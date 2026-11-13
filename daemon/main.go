package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"math/rand"
	"net/http"
	"os"
	"sync"
	"time"

	"github.com/NKS01X/contest-proctoring/daemon/scanner"
)

type Payload struct {
	SessionToken string              `json:"session_token"`
	Timestamp    time.Time           `json:"timestamp"`
	Violations   []scanner.Violation `json:"violations"`
}

var (
	bufferMutex sync.Mutex
	violations  []scanner.Violation
)

func generateToken(length int) string {
	const charset = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
	b := make([]byte, length)
	rand.Seed(time.Now().UnixNano())
	for i := range b {
		b[i] = charset[rand.Intn(len(charset))]
	}
	return string(b)
}

func main() {
	sessionToken := generateToken(5)
	
	backendURL := os.Getenv("BACKEND_URL")
	if backendURL == "" {
		backendURL = "https://contest-proctoring-backend.onrender.com"
	}
	
	// Print in bright cyan color
	fmt.Printf("\033[1;36m==================================================\n")
	fmt.Printf("Contest Proctoring Daemon Started\n")
	fmt.Printf("Your Session Token: %s\n", sessionToken)
	fmt.Printf("Target Backend: %s\n", backendURL)
	fmt.Printf("DO NOT CLOSE THIS WINDOW DURING THE CONTEST\n")
	fmt.Printf("==================================================\033[0m\n")

	vChan := make(chan scanner.Violation, 100)
	go scanner.Poll(5*time.Second, vChan)

	// Collect violations into the offline buffer
	go func() {
		for v := range vChan {
			bufferMutex.Lock()
			violations = append(violations, v)
			bufferMutex.Unlock()
		}
	}()

	// Heartbeat worker
	ticker := time.NewTicker(10 * time.Second)
	defer ticker.Stop()

	client := &http.Client{Timeout: 5 * time.Second}

	for {
		<-ticker.C

		bufferMutex.Lock()
		currentViolations := make([]scanner.Violation, len(violations))
		copy(currentViolations, violations)
		bufferMutex.Unlock()

		payload := Payload{
			SessionToken: sessionToken,
			Timestamp:    time.Now(),
			Violations:   currentViolations,
		}

		data, err := json.Marshal(payload)
		if err != nil {
			continue
		}

		resp, err := client.Post(backendURL+"/heartbeat", "application/json", bytes.NewBuffer(data))
		if err == nil {
			if resp.StatusCode == http.StatusOK || resp.StatusCode == http.StatusNoContent {
				// Success: remove sent violations
				bufferMutex.Lock()
				violations = violations[len(currentViolations):]
				bufferMutex.Unlock()
			}
			resp.Body.Close()
		} else {
			fmt.Printf("\033[1;33m[Warning] Heartbeat failed, retrying on next tick...\033[0m\n")
		}
	}
}
