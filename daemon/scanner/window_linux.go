//go:build linux
// +build linux

package scanner

import (
	"os/exec"
	"strings"
)

// GetActiveWindowTitle uses xdotool as a simple interface to X11 for Linux environments.
func GetActiveWindowTitle() string {
	out, err := exec.Command("xdotool", "getactivewindow").Output()
	if err != nil {
		return ""
	}
	windowID := strings.TrimSpace(string(out))
	if windowID == "" {
		return ""
	}

	nameOut, err := exec.Command("xdotool", "getwindowname", windowID).Output()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(nameOut))
}
