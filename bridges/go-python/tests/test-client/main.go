// main.go — Stitch manual test client (Go → Python).
//
// Run from the tests/test-client directory:
//
//	go run . ../../tests/test-child.py
//
// or
//
//	go run . /absolute/path/to/test-child.py
package main

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"os"
	"os/exec"
	"os/signal"
	"sync"
	"syscall"
	"time"

	"github.com/google/uuid"
)

// ---------------------------------------------------------------------------
// Protocol types
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
		return fmt.Sprintf("%s\n%s", e.Message, e.Traceback)
	}
	return e.Message
}

// ---------------------------------------------------------------------------
// Bridge
// ---------------------------------------------------------------------------

type Bridge struct {
	cmd    *exec.Cmd
	stdin  io.WriteCloser
	stdout *bufio.Scanner

	mu      sync.Mutex
	pending map[string]chan rpcResponse

	closeOnce sync.Once
	done      chan struct{}
}

func NewBridge(pythonBin, script string) (*Bridge, error) {
	cmd := exec.Command(pythonBin, script)
	cmd.Stderr = os.Stderr

	stdinPipe, err := cmd.StdinPipe()
	if err != nil {
		return nil, fmt.Errorf("bridge: stdin pipe: %w", err)
	}
	stdoutPipe, err := cmd.StdoutPipe()
	if err != nil {
		return nil, fmt.Errorf("bridge: stdout pipe: %w", err)
	}
	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("bridge: start: %w", err)
	}

	scanner := bufio.NewScanner(stdoutPipe)
	const maxBuf = 8 * 1024 * 1024
	scanner.Buffer(make([]byte, maxBuf), maxBuf)

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
	go b.handleSignals()
	return b, nil
}

func (b *Bridge) waitReady() error {
	if !b.stdout.Scan() {
		if err := b.stdout.Err(); err != nil {
			return fmt.Errorf("bridge: ready wait: %w", err)
		}
		return errors.New("bridge: child closed stdout before ready signal")
	}
	var msg map[string]interface{}
	if err := json.Unmarshal([]byte(b.stdout.Text()), &msg); err != nil {
		return fmt.Errorf("bridge: ready line not JSON: %w", err)
	}
	if ready, _ := msg["ready"].(bool); !ready {
		return fmt.Errorf("bridge: expected ready signal, got: %q", b.stdout.Text())
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
			log.Printf("bridge: bad response (skip): %v", err)
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

func (b *Bridge) handleSignals() {
	ch := make(chan os.Signal, 1)
	signal.Notify(ch, os.Interrupt, syscall.SIGTERM)
	select {
	case <-ch:
		log.Println("bridge: shutting down on signal")
		b.Close()
		os.Exit(0)
	case <-b.done:
		signal.Stop(ch)
	}
}

func (b *Bridge) killChild() error {
	if b.cmd.Process == nil {
		return nil
	}
	_ = b.cmd.Process.Signal(syscall.SIGTERM)
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
		return nil, fmt.Errorf("bridge: marshal: %w", err)
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
		return nil, fmt.Errorf("bridge: write: %w", err)
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
// Test runner
// ---------------------------------------------------------------------------

func main() {
	script := "../test-child.py"
	if len(os.Args) > 1 {
		script = os.Args[1]
	}

	pythonBin := "python3"
	if p := os.Getenv("PYTHON_BIN"); p != "" {
		pythonBin = p
	}

	log.Printf("Spawning sidecar: %s %s", pythonBin, script)
	bridge, err := NewBridge(pythonBin, script)
	if err != nil {
		log.Fatalf("FAIL start bridge: %v", err)
	}
	defer bridge.Close()

	pass := 0
	fail := 0

	check := func(name string, fn func() error) {
		if err := fn(); err != nil {
			fmt.Printf("FAIL  %s: %v\n", name, err)
			fail++
		} else {
			fmt.Printf("PASS  %s\n", name)
			pass++
		}
	}

	// --- echo ---
	check("echo", func() error {
		res, err := bridge.Call("echo", map[string]interface{}{"msg": "hello"})
		if err != nil {
			return err
		}
		var got map[string]string
		if err := json.Unmarshal(res, &got); err != nil {
			return err
		}
		if got["echo"] != "hello" {
			return fmt.Errorf("expected 'hello', got %q", got["echo"])
		}
		return nil
	})

	// --- add ---
	check("add", func() error {
		res, err := bridge.Call("add", map[string]interface{}{"a": 7, "b": 3})
		if err != nil {
			return err
		}
		var got map[string]float64
		if err := json.Unmarshal(res, &got); err != nil {
			return err
		}
		if got["sum"] != 10 {
			return fmt.Errorf("expected 10, got %v", got["sum"])
		}
		return nil
	})

	// --- raise_error ---
	check("raise_error", func() error {
		_, err := bridge.Call("raise_error", map[string]interface{}{})
		if err == nil {
			return fmt.Errorf("expected error, got nil")
		}
		log.Printf("  (received expected error: %v)", err)
		return nil
	})

	// --- concurrent calls (10 goroutines) ---
	check("concurrent_10", func() error {
		var wg sync.WaitGroup
		errs := make(chan error, 10)
		for i := 0; i < 10; i++ {
			wg.Add(1)
			go func(n int) {
				defer wg.Done()
				res, err := bridge.Call("add", map[string]interface{}{"a": n, "b": n})
				if err != nil {
					errs <- err
					return
				}
				var got map[string]float64
				if err := json.Unmarshal(res, &got); err != nil {
					errs <- err
					return
				}
				if got["sum"] != float64(n+n) {
					errs <- fmt.Errorf("goroutine %d: expected %d got %v", n, n+n, got["sum"])
				}
			}(i)
		}
		wg.Wait()
		close(errs)
		for e := range errs {
			return e
		}
		return nil
	})

	// --- slow (200 ms) ---
	check("slow_200ms", func() error {
		start := time.Now()
		res, err := bridge.Call("slow", map[string]interface{}{"ms": 200})
		if err != nil {
			return err
		}
		elapsed := time.Since(start)
		if elapsed < 150*time.Millisecond {
			return fmt.Errorf("too fast: %v", elapsed)
		}
		var got map[string]float64
		if err := json.Unmarshal(res, &got); err != nil {
			return err
		}
		if got["slept_ms"] != 200 {
			return fmt.Errorf("expected slept_ms=200, got %v", got["slept_ms"])
		}
		return nil
	})

	fmt.Printf("\n%d passed, %d failed\n", pass, fail)
	if fail > 0 {
		os.Exit(1)
	}
}
