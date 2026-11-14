package scanner

import (
	"sort"
	"strings"
	"time"

	"github.com/shirou/gopsutil/v3/process"
)

const (
	maxSnapshotLen = 4000
	maxTitleLen    = 160
	titleCooldown  = 15 * time.Second
)

// Activity is one recorded event. Type is one of:
// process_snapshot, process_start, window.
type Activity struct {
	Timestamp   time.Time `json:"timestamp"`
	Type        string    `json:"type"`
	Description string    `json:"description"`
	Flagged     bool      `json:"flagged"`
}

var ProcessBlacklist = []string{
	"code.exe",
	"cursor.exe",
	"code",
	"cursor",
}

var WindowBlacklist = []string{
	"ChatGPT",
	"Claude",
	"Gemini",
}

func matches(s string, list []string) bool {
	s = strings.ToLower(s)
	for _, b := range list {
		if strings.Contains(s, strings.ToLower(b)) {
			return true
		}
	}
	return false
}

func clip(s string, n int) string {
	if r := []rune(s); len(r) > n {
		return string(r[:n])
	}
	return s
}

func processNames() map[string]struct{} {
	procs, err := process.Processes()
	if err != nil {
		return nil
	}
	set := make(map[string]struct{}, len(procs))
	for _, p := range procs {
		if name, err := p.Name(); err == nil && name != "" {
			set[name] = struct{}{}
		}
	}
	return set
}

// Poll records window changes and process starts, keeping only new information:
// each process name is reported once (flagged ones every time), process stops are
// not reported, and a window title is not repeated within titleCooldown.
func Poll(interval time.Duration, out chan<- Activity) {
	var prev map[string]struct{}
	seen := map[string]struct{}{}
	emitted := map[string]time.Time{}
	lastTitle := ""
	ticker := time.NewTicker(interval)
	defer ticker.Stop()

	for {
		now := time.Now()

		if cur := processNames(); cur != nil {
			if prev == nil {
				names := make([]string, 0, len(cur))
				for n := range cur {
					names = append(names, n)
					seen[n] = struct{}{}
				}
				sort.Strings(names)
				snap := strings.Join(names, ", ")
				if len(snap) > maxSnapshotLen {
					snap = snap[:maxSnapshotLen]
				}
				out <- Activity{Timestamp: now, Type: "process_snapshot", Description: snap}
				for _, n := range names {
					if matches(n, ProcessBlacklist) {
						out <- Activity{Timestamp: now, Type: "process_start", Description: n, Flagged: true}
					}
				}
			} else {
				for n := range cur {
					if _, ok := prev[n]; ok {
						continue
					}
					flagged := matches(n, ProcessBlacklist)
					if _, ok := seen[n]; !ok || flagged {
						out <- Activity{Timestamp: now, Type: "process_start", Description: n, Flagged: flagged}
					}
					seen[n] = struct{}{}
				}
			}
			prev = cur
		}

		if title := clip(GetActiveWindowTitle(), maxTitleLen); title != "" && title != lastTitle {
			lastTitle = title
			flagged := matches(title, WindowBlacklist)
			if last, ok := emitted[title]; !ok || flagged || now.Sub(last) > titleCooldown {
				emitted[title] = now
				out <- Activity{Timestamp: now, Type: "window", Description: title, Flagged: flagged}
			}
		}

		<-ticker.C
	}
}
