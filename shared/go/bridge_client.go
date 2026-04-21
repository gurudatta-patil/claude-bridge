// Package stitch provides shared primitives for Stitch Go clients.
//
// All Go bridge clients (go-python, go-ruby, go-nodejs) import this package
// instead of duplicating scanner, pending-map, kill, and ready-wait logic.
package stitch

import (
	"bufio"
	"context"
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

// RpcChunk is emitted by the sidecar for streaming responses.
// Chunk frames carry data; the terminal frame has Result set (empty object = stream done).
type RpcChunk struct {
	ID    string          `json:"id"`
	Chunk json.RawMessage `json:"chunk,omitempty"`
	// Result is set on the terminal frame (empty object = stream done).
	Result json.RawMessage `json:"result,omitempty"`
	Error  *RpcError       `json:"error,omitempty"`
}

// ─────────────────────────────────────────────────────────────────────────────
// IsChunk - detect streaming chunk frames
// ─────────────────────────────────────────────────────────────────────────────

// IsChunk reports whether the raw JSON is a streaming chunk frame
// (has "chunk" key but no "result" or "error" key).
// When true, callers should dispatch to StreamPendingMap instead of PendingMap.
func IsChunk(raw []byte) bool {
	var m map[string]json.RawMessage
	if err := json.Unmarshal(raw, &m); err != nil {
		return false
	}
	_, hasChunk := m["chunk"]
	_, hasResult := m["result"]
	_, hasError := m["error"]
	return hasChunk && !hasResult && !hasError
}

// ─────────────────────────────────────────────────────────────────────────────
// PendingMap - mutex-guarded map of in-flight calls
// ─────────────────────────────────────────────────────────────────────────────

// PendingMap manages in-flight RPC calls, each identified by a string UUID.
// It is safe for concurrent use from multiple goroutines.
// Note: PendingMap.Dispatch handles RpcResponse frames (result or error).
// For streaming chunk frames (detected via IsChunk), dispatch to StreamPendingMap instead.
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
// StreamPendingMap - in-flight streaming RPC calls
// ─────────────────────────────────────────────────────────────────────────────

// StreamPendingMap manages in-flight streaming RPC calls.
// Each call is identified by a string UUID and receives frames on a buffered channel.
type StreamPendingMap struct {
	mu    sync.Mutex
	calls map[string]chan RpcChunk
}

// NewStreamPendingMap creates an initialised StreamPendingMap.
func NewStreamPendingMap() *StreamPendingMap {
	return &StreamPendingMap{calls: make(map[string]chan RpcChunk)}
}

// Register creates a buffered channel for streaming id. The channel receives
// one RpcChunk per chunk frame plus a terminal frame (with Result set).
func (s *StreamPendingMap) Register(id string) chan RpcChunk {
	ch := make(chan RpcChunk, 32) // buffer to avoid blocking the reader
	s.mu.Lock()
	s.calls[id] = ch
	s.mu.Unlock()
	return ch
}

// Dispatch delivers frame to the channel registered for frame.ID.
// If the frame is terminal (Result or Error set), the entry is removed.
// It is a no-op if no channel is registered for that ID.
func (s *StreamPendingMap) Dispatch(frame RpcChunk) {
	s.mu.Lock()
	ch, ok := s.calls[frame.ID]
	if ok && (frame.Result != nil || frame.Error != nil) {
		// terminal frame - deliver and remove
		delete(s.calls, frame.ID)
	}
	s.mu.Unlock()
	if ok {
		ch <- frame
	}
}

// Delete removes the entry for id without delivering a frame.
func (s *StreamPendingMap) Delete(id string) {
	s.mu.Lock()
	delete(s.calls, id)
	s.mu.Unlock()
}

// ─────────────────────────────────────────────────────────────────────────────
// Stream - streaming JSON-RPC call
// ─────────────────────────────────────────────────────────────────────────────

// Stream sends a streaming JSON-RPC request and returns a channel that
// receives chunk frames. The channel is closed after the terminal frame.
// The caller is responsible for consuming or draining the returned channel.
//
// Usage:
//
//	ch, err := Stream(streamPending, id, writeFunc)
//	for frame := range ch {
//	    if frame.Error != nil { /* handle error */ }
//	    // frame.Chunk has the data; frame.Result != nil means done
//	}
func Stream(
	streamPending *StreamPendingMap,
	id string,
	writeFunc func() error,
) (<-chan RpcChunk, error) {
	ch := streamPending.Register(id)
	if err := writeFunc(); err != nil {
		streamPending.Delete(id)
		return nil, err
	}

	// Return a wrapper channel that closes itself when the terminal frame arrives.
	out := make(chan RpcChunk, 32)
	go func() {
		defer close(out)
		for frame := range ch {
			out <- frame
			if frame.Result != nil || frame.Error != nil {
				return // terminal
			}
		}
	}()
	return out, nil
}

// ─────────────────────────────────────────────────────────────────────────────
// CallOptions - per-call behaviour
// ─────────────────────────────────────────────────────────────────────────────

// CallOptions control per-call behaviour.
type CallOptions struct {
	// Context for cancellation and deadlines.
	Context context.Context
	// Traceparent is the W3C trace context header value.
	// If non-empty it is included as "traceparent" in the request JSON.
	Traceparent string
}

// WithTraceparent returns a CallOptions with the given W3C traceparent value.
func WithTraceparent(t string) CallOptions {
	return CallOptions{Traceparent: t, Context: context.Background()}
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
// KillChild - SIGTERM → SIGKILL(2 s) pattern
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
// WaitReady - read lines until {"ready":true}
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
		return fmt.Errorf("stitch: waiting for ready: %w", err)
	}
	return errors.New("stitch: child closed stdout before sending ready signal")
}

// ─────────────────────────────────────────────────────────────────────────────
// CallWithContext - context-aware RPC wait
// ─────────────────────────────────────────────────────────────────────────────

// CallWithContext sends a JSON-RPC request and waits for the response,
// honouring ctx cancellation. If ctx is cancelled before the response arrives,
// the pending entry is cleaned up and ctx.Err() is returned.
// The child sidecar continues executing the request - cancellation is Go-side only.
func CallWithContext(ctx context.Context, pending *PendingMap, id string, ch chan RpcResponse) (json.RawMessage, error) {
	select {
	case resp := <-ch:
		if resp.Error != nil {
			return nil, resp.Error
		}
		return resp.Result, nil
	case <-ctx.Done():
		pending.Delete(id)
		return nil, ctx.Err()
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Ping - built-in health-check call
// ─────────────────────────────────────────────────────────────────────────────

// Ping sends a built-in __ping__ call and returns the raw response.
// It is a quick health-check for any bridge that supports the __ping__ method.
// The call uses a 5-second timeout via context.
func Ping(pending *PendingMap, write func(id, method string, params map[string]any) error) (json.RawMessage, error) {
	id := "ping-" + fmt.Sprintf("%d", time.Now().UnixNano())
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	ch := pending.Register(id)
	if err := write(id, "__ping__", nil); err != nil {
		pending.Delete(id)
		return nil, err
	}
	return CallWithContext(ctx, pending, id, ch)
}

// ─────────────────────────────────────────────────────────────────────────────
// BridgePool - least-connections pool of bridge instances
// ─────────────────────────────────────────────────────────────────────────────

// BridgePool routes calls across N bridge instances using least-connections.
// T is the bridge type (e.g. *PythonBridge). spawn is called N times at Start.
type BridgePool[T any] struct {
	workers  []T
	inFlight []int64
	mu       sync.Mutex
	size     int
	spawn    func() (T, error)
}

func NewBridgePool[T any](size int, spawn func() (T, error)) *BridgePool[T] {
	return &BridgePool[T]{size: size, spawn: spawn}
}

func (p *BridgePool[T]) Start() error {
	p.workers = make([]T, 0, p.size)
	p.inFlight = make([]int64, 0, p.size)
	for i := 0; i < p.size; i++ {
		w, err := p.spawn()
		if err != nil {
			return fmt.Errorf("pool start worker %d: %w", i, err)
		}
		p.workers = append(p.workers, w)
		p.inFlight = append(p.inFlight, 0)
	}
	return nil
}

// Pick returns the least-busy worker and its index, incrementing its in-flight counter.
func (p *BridgePool[T]) Pick() (T, int) {
	p.mu.Lock()
	defer p.mu.Unlock()
	minIdx := 0
	for i := 1; i < len(p.inFlight); i++ {
		if p.inFlight[i] < p.inFlight[minIdx] {
			minIdx = i
		}
	}
	p.inFlight[minIdx]++
	return p.workers[minIdx], minIdx
}

// Done decrements the in-flight counter for worker at idx.
func (p *BridgePool[T]) Done(idx int) {
	p.mu.Lock()
	p.inFlight[idx]--
	p.mu.Unlock()
}
