// Package ghostbridge provides shared primitives for Ghost-Bridge Go clients.
//
// All Go bridge clients (go-python, go-ruby, go-nodejs) import this package
// instead of duplicating scanner, pending-map, kill, and ready-wait logic.
package ghostbridge

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os/exec"
	"sync"
	"syscall"
	"time"
)

// ─────────────────────────────────────────────────────────────────────────────
// Protocol types
// ─────────────────────────────────────────────────────────────────────────────

// RpcError carries the error payload from the sidecar.
type RpcError struct {
	Message   string `json:"message"`
	Traceback string `json:"traceback,omitempty"`
	Backtrace string `json:"backtrace,omitempty"`
	Code      int    `json:"code,omitempty"`
}

func (e *RpcError) Error() string {
	if e.Traceback != "" {
		return fmt.Sprintf("%s\n%s", e.Message, e.Traceback)
	}
	if e.Backtrace != "" {
		return fmt.Sprintf("%s\n%s", e.Message, e.Backtrace)
	}
	return e.Message
}

// RpcResponse is the wire format for incoming JSON-RPC responses.
type RpcResponse struct {
	ID     string          `json:"id"`
	Result json.RawMessage `json:"result,omitempty"`
	Error  *RpcError       `json:"error,omitempty"`
}

// ─────────────────────────────────────────────────────────────────────────────
// PendingMap — mutex-guarded map of in-flight calls
// ─────────────────────────────────────────────────────────────────────────────

// PendingMap manages in-flight RPC calls, each identified by a string UUID.
// It is safe for concurrent use from multiple goroutines.
type PendingMap struct {
	mu    sync.Mutex
	calls map[string]chan RpcResponse
}

// NewPendingMap creates an initialised PendingMap.
func NewPendingMap() *PendingMap {
	return &PendingMap{calls: make(map[string]chan RpcResponse)}
}

// Register inserts a channel for the given request id and returns it.
// The returned channel is buffered with capacity 1.
func (p *PendingMap) Register(id string) chan RpcResponse {
	ch := make(chan RpcResponse, 1)
	p.mu.Lock()
	p.calls[id] = ch
	p.mu.Unlock()
	return ch
}

// Dispatch delivers resp to the channel registered for resp.ID.
// It is a no-op if no channel is registered (e.g. caller timed out).
func (p *PendingMap) Dispatch(resp RpcResponse) {
	p.mu.Lock()
	ch, ok := p.calls[resp.ID]
	if ok {
		delete(p.calls, resp.ID)
	}
	p.mu.Unlock()
	if ok {
		ch <- resp
	}
}

// Delete removes the entry for id without delivering a response.
// Use this when a call is cancelled or timed out before a reply arrives.
func (p *PendingMap) Delete(id string) {
	p.mu.Lock()
	delete(p.calls, id)
	p.mu.Unlock()
}

// DrainWithError unblocks all pending callers with an error response.
// Call this when the child process exits unexpectedly.
func (p *PendingMap) DrainWithError(message string) {
	p.mu.Lock()
	for id, ch := range p.calls {
		ch <- RpcResponse{ID: id, Error: &RpcError{Message: message}}
		delete(p.calls, id)
	}
	p.mu.Unlock()
}

// ─────────────────────────────────────────────────────────────────────────────
// Scanner constructor with enlarged buffer
// ─────────────────────────────────────────────────────────────────────────────

const defaultScannerBufSize = 4 * 1024 * 1024 // 4 MiB

// NewScanner returns a *bufio.Scanner reading from r with a 4 MiB buffer.
// This avoids scanner.ErrTooLong on large JSON payloads.
func NewScanner(r io.Reader) *bufio.Scanner {
	s := bufio.NewScanner(r)
	s.Buffer(make([]byte, defaultScannerBufSize), defaultScannerBufSize)
	return s
}

// ─────────────────────────────────────────────────────────────────────────────
// KillChild — SIGTERM → SIGKILL(2 s) pattern
// ─────────────────────────────────────────────────────────────────────────────

// KillChild sends SIGTERM to the child process; if it has not exited after 2 s
// it sends SIGKILL.  Safe to call when cmd.Process is nil.
func KillChild(cmd *exec.Cmd) {
	if cmd.Process == nil {
		return
	}

	_ = cmd.Process.Signal(syscall.SIGTERM)

	done := make(chan struct{})
	go func() {
		_ = cmd.Wait()
		close(done)
	}()

	timer := time.NewTimer(2 * time.Second)
	defer timer.Stop()
	select {
	case <-done:
	case <-timer.C:
		_ = cmd.Process.Kill()
		<-done
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// WaitReady — read lines until {"ready":true}
// ─────────────────────────────────────────────────────────────────────────────

// WaitReady advances scanner until it finds a line that decodes as
// {"ready":true}.  Returns an error if the scanner ends before that.
func WaitReady(scanner *bufio.Scanner) error {
	for scanner.Scan() {
		var msg map[string]interface{}
		if err := json.Unmarshal(scanner.Bytes(), &msg); err != nil {
			continue // not valid JSON, keep reading
		}
		if ready, _ := msg["ready"].(bool); ready {
			return nil
		}
	}
	if err := scanner.Err(); err != nil {
		return fmt.Errorf("ghostbridge: waiting for ready: %w", err)
	}
	return errors.New("ghostbridge: child closed stdout before sending ready signal")
}
