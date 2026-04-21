// template.client.go - Go client that spawns a Rust sidecar and communicates
// with it over newline-delimited JSON-RPC via stdin/stdout.
//
// Protocol:
//   - Newline-delimited JSON (NDJSON)
//   - Child writes {"ready":true} as its very first line
//   - Request  → {"id":"<uuid>","method":"<name>","params":{...}}
//   - Success  → {"id":"<uuid>","result":<value>}
//   - Error    → {"id":"<uuid>","error":{"message":"<str>","traceback":"<str>"}}
//   - stdin EOF signals the child to exit cleanly
//
// Usage: copy this file into your project or import github.com/stitch/go-rust.
// Replace the NewRustBridge / Call invocations in your application code with
// your own method names and parameter shapes.
package gobridge

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"os/signal"
	"sync"
	"syscall"
	"time"

	"github.com/google/uuid"
)

// ─── Wire types ───────────────────────────────────────────────────────────────

type rpcRequest struct {
	ID     string         `json:"id"`
	Method string         `json:"method"`
	Params map[string]any `json:"params"`
}

// RpcError is the error payload returned by the Rust sidecar.
type RpcError struct {
	Message   string `json:"message"`
	Traceback string `json:"traceback,omitempty"`
	Code      int    `json:"code,omitempty"`
}

func (e *RpcError) Error() string {
	if e.Traceback != "" {
		return fmt.Sprintf("%s\n%s", e.Message, e.Traceback)
	}
	return e.Message
}

type rpcResponse struct {
	ID     string          `json:"id"`
	Result json.RawMessage `json:"result,omitempty"`
	Error  *RpcError       `json:"error,omitempty"`
}

// ─── pendingMap ───────────────────────────────────────────────────────────────

// pendingMap tracks in-flight RPC calls keyed by their UUID.
// It is safe for concurrent use from multiple goroutines.
type pendingMap struct {
	mu    sync.Mutex
	calls map[string]chan rpcResponse
}

func newPendingMap() *pendingMap {
	return &pendingMap{calls: make(map[string]chan rpcResponse)}
}

func (p *pendingMap) register(id string) chan rpcResponse {
	ch := make(chan rpcResponse, 1)
	p.mu.Lock()
	p.calls[id] = ch
	p.mu.Unlock()
	return ch
}

func (p *pendingMap) dispatch(resp rpcResponse) {
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

func (p *pendingMap) delete(id string) {
	p.mu.Lock()
	delete(p.calls, id)
	p.mu.Unlock()
}

func (p *pendingMap) drainWithError(message string) {
	p.mu.Lock()
	for id, ch := range p.calls {
		ch <- rpcResponse{ID: id, Error: &RpcError{Message: message}}
		delete(p.calls, id)
	}
	p.mu.Unlock()
}

// ─── Scanner constant ─────────────────────────────────────────────────────────

// scannerBufSize is the maximum single-line size the scanner accepts.
// 4 MiB prevents bufio.ErrTooLong on large JSON payloads such as base-64
// encoded files.  Override by constructing your own scanner after reading the
// stdout pipe manually.
const scannerBufSize = 4 * 1024 * 1024

// ─── RustBridge ───────────────────────────────────────────────────────────────

// RustBridge manages a long-lived Rust child process.
// Create one with NewRustBridge; close it with Close when done.
type RustBridge struct {
	cmd     *exec.Cmd
	stdin   io.WriteCloser
	mu      sync.Mutex // serialises writes to stdin
	pending *pendingMap
	done    chan struct{} // closed when the readLoop exits
}

// NewRustBridge spawns the Rust binary at binaryPath (with optional extra args),
// waits for the {"ready":true} signal, and starts the response-dispatch goroutine.
//
// Returns an error if the binary cannot be found, the process fails to start,
// or the ready handshake times out (the binary must emit {"ready":true} before
// sending any other output).
func NewRustBridge(binaryPath string, args ...string) (*RustBridge, error) {
	cmd := exec.Command(binaryPath, args...)
	cmd.Stderr = os.Stderr

	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, fmt.Errorf("stdin pipe: %w", err)
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, fmt.Errorf("stdout pipe: %w", err)
	}

	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("start rust binary: %w", err)
	}

	scanner := bufio.NewScanner(stdout)
	scanner.Buffer(make([]byte, scannerBufSize), scannerBufSize)

	b := &RustBridge{
		cmd:     cmd,
		stdin:   stdin,
		pending: newPendingMap(),
		done:    make(chan struct{}),
	}

	// Block until the child emits {"ready":true}.
	if err := waitReady(scanner); err != nil {
		_ = cmd.Process.Kill()
		return nil, fmt.Errorf("child exited before sending ready signal: %w", err)
	}

	// Response-dispatch goroutine.
	go b.readLoop(scanner)

	// Forward SIGTERM / SIGINT to the child so it can clean up.
	go func() {
		ch := make(chan os.Signal, 1)
		signal.Notify(ch, syscall.SIGTERM, syscall.SIGINT)
		select {
		case <-ch:
			_ = b.Close()
		case <-b.done:
		}
	}()

	return b, nil
}

// waitReady advances scanner until it finds a line that decodes as {"ready":true}.
func waitReady(scanner *bufio.Scanner) error {
	for scanner.Scan() {
		var msg map[string]interface{}
		if err := json.Unmarshal(scanner.Bytes(), &msg); err != nil {
			continue // ignore non-JSON lines (e.g. startup log lines)
		}
		if ready, _ := msg["ready"].(bool); ready {
			return nil
		}
	}
	if err := scanner.Err(); err != nil {
		return fmt.Errorf("reading ready signal: %w", err)
	}
	return errors.New("child closed stdout before sending ready signal")
}

// readLoop is the single goroutine that reads all responses from the child and
// routes each one to the waiting caller via the pendingMap.
func (b *RustBridge) readLoop(scanner *bufio.Scanner) {
	defer close(b.done)
	for scanner.Scan() {
		var resp rpcResponse
		if err := json.Unmarshal(scanner.Bytes(), &resp); err != nil {
			continue // malformed line - skip
		}
		b.pending.dispatch(resp)
	}
	// Child stdout closed; unblock all pending callers with an error.
	b.pending.drainWithError("child process exited")
}

// Call sends a JSON-RPC request to the Rust child and blocks until a response
// arrives.  It is safe to call from multiple goroutines concurrently.
//
// Returns (nil, *RpcError) when the child returns an error object.
func (b *RustBridge) Call(method string, params map[string]any) (json.RawMessage, error) {
	return b.CallContext(context.Background(), method, params)
}

// CallContext is like Call but respects ctx cancellation or deadline.
// If ctx is cancelled before the response arrives, the in-flight request ID
// is removed from the pendingMap and ctx.Err() is returned.
func (b *RustBridge) CallContext(ctx context.Context, method string, params map[string]any) (json.RawMessage, error) {
	id := uuid.New().String()
	ch := b.pending.register(id)

	b.mu.Lock()
	line, _ := json.Marshal(rpcRequest{ID: id, Method: method, Params: params})
	_, err := fmt.Fprintf(b.stdin, "%s\n", line)
	b.mu.Unlock()

	if err != nil {
		b.pending.delete(id)
		return nil, fmt.Errorf("send request: %w", err)
	}

	select {
	case resp := <-ch:
		if resp.Error != nil {
			return nil, resp.Error
		}
		return resp.Result, nil
	case <-ctx.Done():
		b.pending.delete(id)
		return nil, ctx.Err()
	case <-b.done:
		return nil, errors.New("bridge: child process has exited")
	}
}

// Ping sends a built-in __ping__ request and verifies the child responds with
// {"pong":true}.  Returns an error if the child does not respond within 5 s.
// The Rust sidecar template includes this handler by default.
func (b *RustBridge) Ping() error {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	res, err := b.CallContext(ctx, "__ping__", nil)
	if err != nil {
		return fmt.Errorf("ping: %w", err)
	}

	var got map[string]any
	if err := json.Unmarshal(res, &got); err != nil {
		return fmt.Errorf("ping: bad response: %w", err)
	}
	if pong, _ := got["pong"].(bool); !pong {
		return fmt.Errorf("ping: unexpected response: %s", res)
	}
	return nil
}

// Close shuts down the Rust child gracefully.  It closes stdin (which delivers
// EOF to the child's stdin loop, causing it to exit cleanly), then waits up to
// 2 s before sending SIGKILL.
//
// Safe to call more than once; subsequent calls are no-ops.
func (b *RustBridge) Close() error {
	_ = b.stdin.Close()
	killChild(b.cmd)
	return nil
}

// killChild sends SIGTERM; if the child has not exited after 2 s, SIGKILL.
func killChild(cmd *exec.Cmd) {
	if cmd.Process == nil {
		return
	}
	_ = cmd.Process.Signal(syscall.SIGTERM)

	done := make(chan struct{})
	go func() { _ = cmd.Wait(); close(done) }()

	t := time.NewTimer(2 * time.Second)
	defer t.Stop()
	select {
	case <-done:
	case <-t.C:
		_ = cmd.Process.Kill()
		<-done
	}
}
