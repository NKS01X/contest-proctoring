package scanner

import (
	"strings"
	"time"

	"github.com/shirou/gopsutil/v3/process"
)

type Violation struct {
	Timestamp   time.Time `json:"timestamp"`
	Type        string    `json:"type"`        // "process" or "window"
	Description string    `json:"description"` // Name of process or window title
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

// Poll continuously checks processes and active windows
func Poll(interval time.Duration, violationsChan chan<- Violation) {
	ticker := time.NewTicker(interval)
	defer ticker.Stop()

	for {
		<-ticker.C
		
		// 1. Check Processes
		procs, err := process.Processes()
		if err == nil {
			for _, p := range procs {
				name, err := p.Name()
				if err != nil {
					continue
				}
				nameLower := strings.ToLower(name)
				for _, blacklisted := range ProcessBlacklist {
					if strings.Contains(nameLower, strings.ToLower(blacklisted)) {
						violationsChan <- Violation{
							Timestamp:   time.Now(),
							Type:        "process",
							Description: name,
						}
						break
					}
				}
			}
		}

		// 2. Check Active Window
		activeTitle := GetActiveWindowTitle()
		titleLower := strings.ToLower(activeTitle)
		for _, blacklisted := range WindowBlacklist {
			if strings.Contains(titleLower, strings.ToLower(blacklisted)) {
				violationsChan <- Violation{
					Timestamp:   time.Now(),
					Type:        "window",
					Description: activeTitle,
				}
				break
			}
		}
	}
}
