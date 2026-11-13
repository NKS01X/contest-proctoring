package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"math/big"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/NKS01X/contest-proctoring/daemon/scanner"
	"github.com/wailsapp/wails/v2/pkg/runtime"
)

var defaultBackend = "https://contest-proctoring-backend.onrender.com"

const (
	flushEvery = 10 * time.Second
	batchSize  = 500
	maxBuffer  = 20000
)

type event struct {
	ID string `json:"id"`
	scanner.Activity
}

type payload struct {
	SessionToken string    `json:"session_token"`
	Timestamp    time.Time `json:"timestamp"`
	Activities   []event   `json:"activities"`
}

// State is the snapshot shown in the UI.
type State struct {
	Token    string `json:"token"`
	Backend  string `json:"backend"`
	Online   bool   `json:"online"`
	Pending  int    `json:"pending"`
	Sent     int    `json:"sent"`
	Flagged  int    `json:"flagged"`
	LastSync string `json:"lastSync"`
}

type App struct {
	ctx     context.Context
	token   string
	backend string
	client  *http.Client

	mu       sync.Mutex
	buffer   []event
	seq      int
	sent     int
	flagged  int
	online   bool
	lastSync time.Time
}

func NewApp() *App {
	backend := os.Getenv("BACKEND_URL")
	if backend == "" {
		backend = defaultBackend
	}
	return &App{
		token:   generateToken(5),
		backend: strings.TrimRight(backend, "/"),
		client:  &http.Client{Timeout: 15 * time.Second},
	}
}

func generateToken(n int) string {
	const charset = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
	b := make([]byte, n)
	for i := range b {
		x, err := rand.Int(rand.Reader, big.NewInt(int64(len(charset))))
		if err != nil {
			panic(err)
		}
		b[i] = charset[x.Int64()]
	}
	return string(b)
}

func (a *App) startup(ctx context.Context) {
	a.ctx = ctx
	a.record(scanner.Activity{Timestamp: time.Now(), Type: "session_start", Description: "app started"})

	ch := make(chan scanner.Activity, 1000)
	go scanner.Poll(3*time.Second, ch)
	go func() {
		for act := range ch {
			a.record(act)
		}
	}()
	go a.syncLoop()
}

func (a *App) beforeClose(ctx context.Context) bool {
	res, err := runtime.MessageDialog(ctx, runtime.MessageDialogOptions{
		Type:          runtime.QuestionDialog,
		Title:         "Quit proctoring?",
		Message:       "Closing the app stops proctoring and shows you as offline to the host.",
		Buttons:       []string{"Yes", "No"},
		DefaultButton: "No",
	})
	if err != nil || res != "Yes" {
		return true
	}
	a.record(scanner.Activity{Timestamp: time.Now(), Type: "session_end", Description: "app closed"})
	a.flush()
	return false
}

func (a *App) record(act scanner.Activity) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.seq++
	a.buffer = append(a.buffer, event{ID: fmt.Sprintf("%s-%d", a.token, a.seq), Activity: act})
	if act.Flagged {
		a.flagged++
	}
	if over := len(a.buffer) - maxBuffer; over > 0 {
		a.buffer = a.buffer[over:]
	}
}

func (a *App) pending() int {
	a.mu.Lock()
	defer a.mu.Unlock()
	return len(a.buffer)
}

func (a *App) syncLoop() {
	ticker := time.NewTicker(flushEvery)
	defer ticker.Stop()
	for {
		if a.flush() && a.pending() > 0 {
			continue
		}
		<-ticker.C
	}
}

// flush sends up to batchSize buffered events. An empty batch still acts as a heartbeat.
// Events stay buffered until the server acknowledges them, so offline periods are backfilled.
func (a *App) flush() bool {
	a.mu.Lock()
	n := len(a.buffer)
	if n > batchSize {
		n = batchSize
	}
	batch := make([]event, n)
	copy(batch, a.buffer[:n])
	a.mu.Unlock()

	body, err := json.Marshal(payload{SessionToken: a.token, Timestamp: time.Now(), Activities: batch})
	if err != nil {
		return false
	}

	ok := false
	resp, err := a.client.Post(a.backend+"/activity", "application/json", bytes.NewReader(body))
	if err == nil {
		ok = resp.StatusCode >= 200 && resp.StatusCode < 300
		resp.Body.Close()
	}

	a.mu.Lock()
	defer a.mu.Unlock()
	a.online = ok
	if ok {
		a.buffer = append([]event(nil), a.buffer[n:]...)
		a.sent += n
		a.lastSync = time.Now()
	}
	return ok
}

// GetState is polled by the UI.
func (a *App) GetState() State {
	a.mu.Lock()
	defer a.mu.Unlock()
	s := State{
		Token:   a.token,
		Backend: a.backend,
		Online:  a.online,
		Pending: len(a.buffer),
		Sent:    a.sent,
		Flagged: a.flagged,
	}
	if !a.lastSync.IsZero() {
		s.LastSync = a.lastSync.Format("15:04:05")
	}
	return s
}

func (a *App) CopyToken() {
	_ = runtime.ClipboardSetText(a.ctx, a.token)
}

// Link pairs the Codeforces handle with this session and returns the contest password.
func (a *App) Link(handle string) (string, error) {
	handle = strings.TrimSpace(handle)
	if handle == "" {
		return "", errors.New("enter your Codeforces handle")
	}

	body, _ := json.Marshal(map[string]string{"cf_handle": handle, "session_token": a.token})
	resp, err := a.client.Post(a.backend+"/link", "application/json", bytes.NewReader(body))
	if err != nil {
		return "", errors.New("cannot reach the server")
	}
	defer resp.Body.Close()

	var out struct {
		Success  bool   `json:"success"`
		Password string `json:"password"`
		Error    string `json:"error"`
	}
	_ = json.NewDecoder(resp.Body).Decode(&out)
	if resp.StatusCode != http.StatusOK || !out.Success {
		if out.Error == "" {
			out.Error = "pairing failed"
		}
		return "", errors.New(out.Error)
	}

	a.record(scanner.Activity{Timestamp: time.Now(), Type: "linked", Description: "paired with handle " + handle})
	return out.Password, nil
}
