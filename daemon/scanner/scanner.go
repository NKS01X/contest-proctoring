package scanner

import (
	"sort"
	"strings"
	"time"

	"github.com/shirou/gopsutil/v3/process"
)

const maxSnapshotLen = 4000

// Activity is one recorded event. Type is one of:
// process_snapshot, process_start, process_stop, window.
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

// Poll records every active-window change and every process start/stop.
// The first scan emits a snapshot of running processes as the baseline.
func Poll(interval time.Duration, out chan<- Activity) {
	var prev map[string]struct{}
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
					if _, ok := prev[n]; !ok {
						out <- Activity{Timestamp: now, Type: "process_start", Description: n, Flagged: matches(n, ProcessBlacklist)}
					}
				}
				for n := range prev {
					if _, ok := cur[n]; !ok {
						out <- Activity{Timestamp: now, Type: "process_stop", Description: n}
					}
				}
			}
			prev = cur
		}

		if title := GetActiveWindowTitle(); title != "" && title != lastTitle {
			lastTitle = title
			out <- Activity{Timestamp: now, Type: "window", Description: title, Flagged: matches(title, WindowBlacklist)}
		}

		<-ticker.C
	}
}
