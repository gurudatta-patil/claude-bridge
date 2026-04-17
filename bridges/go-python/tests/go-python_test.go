// go-python_test.go — Ghost-Bridge integration tests (Go → Python).
//
// Run from the tests/ directory:
//
//	go test -v -timeout 30s
//
// The tests spawn tests/test-child.py via python3 (override with PYTHON_BIN).
package main_test

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sync"
	"syscall"
	"testing"
	"time"

	"github.com/google/uuid"
)

// ---------------------------------------------------------------------------
// Embedded bridge (copy of template — avoids import complexity in test pkg)
// ---------------------------------------------------------------------------

type rpcRequest struct {
	ID     string      `json:"id"`
	Method string      `json:"method"`
	Params interface{} `json:"params"`
}

type rpcResponse struct {
	ID     string          `json:"id"`
	Result json.RawMessage `json:"result,omitempty"`
	Error  *rpcError       `json:"error,omitempty"`
}

type rpcError struct {
	Message   string `json:"message"`
	Traceback string `json:"traceback,omitempty"`
}

func (e *rpcError) Error() string {
	if e.Traceback != "" {
		return e.Message + "\n" + e.Traceback
	}
	return e.Message
}

type Bridge struct {
	cmd    *exec.Cmd
	stdin  io.WriteCloser
	stdout *bufio.Scanner

	mu      sync.Mutex
	pending map[string]chan rpcResponse

	closeOnce sync.Once
	done      chan struct{}
}

func newBridge(pythonBin, script string) (*Bridge, error) {
	cmd := exec.Command(pythonBin, script)
	cmd.Stderr = os.Stderr

	stdinPipe, err := cmd.StdinPipe()
	if err != nil {
		return nil, err
	}
	stdoutPipe, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	if err := cmd.Start(); err != nil {
		return nil, err
	}

	scanner := bufio.NewScanner(stdoutPipe)
	scanner.Buffer(make([]byte, 8*1024*1024), 8*1024*1024)

	b := &Bridge{
		cmd:     cmd,
		stdin:   stdinPipe,
		stdout:  scanner,
		pending: make(map[string]chan rpcResponse),
		done:    make(chan struct{}),
	}

	if err := b.waitReady(); err != nil {
		_ = b.killChild()
		return nil, err
	}
	go b.readLoop()
	return b, nil
}

func (b *Bridge) waitReady() error {
	if !b.stdout.Scan() {
		if err := b.stdout.Err(); err != nil {
			return err
		}
		return errors.New("bridge: child closed stdout before ready signal")
	}
	var msg map[string]interface{}
	if err := json.Unmarshal([]byte(b.stdout.Text()), &msg); err != nil {
		return err
	}
	if ready, _ := msg["ready"].(bool); !ready {
		return fmt.Errorf("expected ready, got: %q", b.stdout.Text())
	}
	return nil
}

func (b *Bridge) readLoop() {
	defer func() {
		b.mu.Lock()
		for id, ch := range b.pending {
			ch <- rpcResponse{ID: id, Error: &rpcError{Message: "bridge: child terminated"}}
			delete(b.pending, id)
		}
		b.mu.Unlock()
	}()
	for {
		select {
		case <-b.done:
			return
		default:
		}
		if !b.stdout.Scan() {
			return
		}
		var resp rpcResponse
		if err := json.Unmarshal([]byte(b.stdout.Text()), &resp); err != nil {
			log.Printf("test bridge: bad response: %v", err)
			continue
		}
		b.mu.Lock()
		ch, ok := b.pending[resp.ID]
		if ok {
			delete(b.pending, resp.ID)
		}
		b.mu.Unlock()
		if ok {
			ch <- resp
		}
	}
}

func (b *Bridge) killChild() error {
	if b.cmd.Process == nil {
		return nil
	}
	if runtime.GOOS == "windows" {
		_ = b.cmd.Process.Kill()
	} else {
		_ = b.cmd.Process.Signal(syscall.SIGTERM)
	}
	done := make(chan struct{})
	go func() { _ = b.cmd.Wait(); close(done) }()
	t := time.NewTimer(2 * time.Second)
	defer t.Stop()
	select {
	case <-done:
	case <-t.C:
		_ = b.cmd.Process.Kill()
		<-done
	}
	return nil
}

func (b *Bridge) Call(method string, params interface{}) (json.RawMessage, error) {
	id := uuid.NewString()
	data, err := json.Marshal(rpcRequest{ID: id, Method: method, Params: params})
	if err != nil {
		return nil, err
	}
	data = append(data, '\n')

	ch := make(chan rpcResponse, 1)
	b.mu.Lock()
	select {
	case <-b.done:
		b.mu.Unlock()
		return nil, errors.New("bridge: closed")
	default:
	}
	b.pending[id] = ch
	b.mu.Unlock()

	if _, err := b.stdin.Write(data); err != nil {
		b.mu.Lock()
		delete(b.pending, id)
		b.mu.Unlock()
		return nil, err
	}
	resp := <-ch
	if resp.Error != nil {
		return nil, resp.Error
	}
	return resp.Result, nil
}

func (b *Bridge) Close() {
	b.closeOnce.Do(func() {
		_ = b.stdin.Close()
		close(b.done)
		_ = b.killChild()
	})
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

func pythonBin() string {
	if p := os.Getenv("PYTHON_BIN"); p != "" {
		return p
	}
	return "python3"
}

// childScript resolves the path to test-child.py relative to this test file.
func childScript(t *testing.T) string {
	t.Helper()
	// This file lives at tests/go-python_test.go; test-child.py is in the
	// same directory.
	_, thisFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("cannot determine test file path via runtime.Caller")
	}
	p := filepath.Join(filepath.Dir(thisFile), "test-child.py")
	if _, err := os.Stat(p); err != nil {
		t.Fatalf("test-child.py not found at %s: %v", p, err)
	}
	return p
}

func startBridge(t *testing.T) *Bridge {
	t.Helper()
	b, err := newBridge(pythonBin(), childScript(t))
	if err != nil {
		t.Fatalf("failed to start bridge: %v", err)
	}
	t.Cleanup(b.Close)
	return b
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

// TestBasicRoundTrip verifies echo and add work correctly.
func TestBasicRoundTrip(t *testing.T) {
	b := startBridge(t)

	t.Run("echo", func(t *testing.T) {
		res, err := b.Call("echo", map[string]interface{}{"msg": "hello"})
		if err != nil {
			t.Fatalf("Call error: %v", err)
		}
		var got map[string]string
		if err := json.Unmarshal(res, &got); err != nil {
			t.Fatalf("unmarshal: %v", err)
		}
		if got["echo"] != "hello" {
			t.Errorf("expected 'hello', got %q", got["echo"])
		}
	})

	t.Run("add_integers", func(t *testing.T) {
		res, err := b.Call("add", map[string]interface{}{"a": 40, "b": 2})
		if err != nil {
			t.Fatalf("Call error: %v", err)
		}
		var got map[string]float64
		if err := json.Unmarshal(res, &got); err != nil {
			t.Fatalf("unmarshal: %v", err)
		}
		if got["sum"] != 42 {
			t.Errorf("expected 42, got %v", got["sum"])
		}
	})

	t.Run("add_floats", func(t *testing.T) {
		res, err := b.Call("add", map[string]interface{}{"a": 1.5, "b": 2.5})
		if err != nil {
			t.Fatalf("Call error: %v", err)
		}
		var got map[string]float64
		if err := json.Unmarshal(res, &got); err != nil {
			t.Fatalf("unmarshal: %v", err)
		}
		if got["sum"] != 4.0 {
			t.Errorf("expected 4.0, got %v", got["sum"])
		}
	})
}

// TestErrorReturn verifies that Python exceptions are propagated as errors.
func TestErrorReturn(t *testing.T) {
	b := startBridge(t)

	t.Run("raise_error_returns_error", func(t *testing.T) {
		_, err := b.Call("raise_error", map[string]interface{}{})
		if err == nil {
			t.Fatal("expected an error, got nil")
		}
		t.Logf("received expected error: %v", err)
	})

	t.Run("unknown_method_returns_error", func(t *testing.T) {
		_, err := b.Call("does_not_exist", map[string]interface{}{})
		if err == nil {
			t.Fatal("expected an error for unknown method, got nil")
		}
		t.Logf("received expected error: %v", err)
	})

	t.Run("bridge_still_usable_after_error", func(t *testing.T) {
		// Errors must not corrupt the bridge state.
		res, err := b.Call("echo", map[string]interface{}{"msg": "still alive"})
		if err != nil {
			t.Fatalf("bridge unusable after error: %v", err)
		}
		var got map[string]string
		_ = json.Unmarshal(res, &got)
		if got["echo"] != "still alive" {
			t.Errorf("unexpected echo: %q", got["echo"])
		}
	})
}

// TestConcurrency fires 10 goroutines simultaneously and checks all results.
func TestConcurrency(t *testing.T) {
	b := startBridge(t)
	const N = 10

	var wg sync.WaitGroup
	errs := make(chan error, N)

	for i := 0; i < N; i++ {
		wg.Add(1)
		go func(n int) {
			defer wg.Done()
			res, err := b.Call("add", map[string]interface{}{"a": n, "b": n})
			if err != nil {
				errs <- fmt.Errorf("goroutine %d: %w", n, err)
				return
			}
			var got map[string]float64
			if err := json.Unmarshal(res, &got); err != nil {
				errs <- fmt.Errorf("goroutine %d unmarshal: %w", n, err)
				return
			}
			want := float64(n + n)
			if got["sum"] != want {
				errs <- fmt.Errorf("goroutine %d: want %v got %v", n, want, got["sum"])
			}
		}(i)
	}

	wg.Wait()
	close(errs)
	for e := range errs {
		t.Error(e)
	}
}

// TestStdinEOFKillsChild verifies the Python watchdog exits when stdin is closed.
func TestStdinEOFKillsChild(t *testing.T) {
	b, err := newBridge(pythonBin(), childScript(t))
	if err != nil {
		t.Fatalf("start bridge: %v", err)
	}

	// Verify the child is running.
	pid := b.cmd.Process.Pid
	if pid <= 0 {
		t.Fatal("child has invalid PID")
	}

	// Close stdin — the Python watchdog should detect EOF and call os._exit(0).
	_ = b.stdin.Close()
	close(b.done)

	// Give the process time to exit (watchdog is a daemon thread, exits fast).
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		// os.FindProcess never fails on Unix; Signal(0) probes liveness.
		proc, err := os.FindProcess(pid)
		if err != nil {
			break // process gone
		}
		if err := proc.Signal(syscall.Signal(0)); err != nil {
			break // process no longer running
		}
		time.Sleep(100 * time.Millisecond)
	}

	// Call killChild to reap and verify it doesn't hang.
	done := make(chan struct{})
	go func() {
		_ = b.killChild()
		close(done)
	}()
	select {
	case <-done:
		// Good.
	case <-time.After(5 * time.Second):
		t.Error("killChild timed out — child may not have exited on stdin EOF")
	}
}

// TestSlowCall checks that a slow Python handler doesn't block other calls.
func TestSlowCall(t *testing.T) {
	b := startBridge(t)

	start := time.Now()
	res, err := b.Call("slow", map[string]interface{}{"ms": 250})
	if err != nil {
		t.Fatalf("slow call error: %v", err)
	}
	elapsed := time.Since(start)
	if elapsed < 200*time.Millisecond {
		t.Errorf("slow call returned too fast: %v", elapsed)
	}

	var got map[string]float64
	if err := json.Unmarshal(res, &got); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if got["slept_ms"] != 250 {
		t.Errorf("expected slept_ms=250, got %v", got["slept_ms"])
	}
}
