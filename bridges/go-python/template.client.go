// template.client.go - Stitch: Go (source) → Python (target) client template.
//
// Copy this file into your project and replace the three PLACEHOLDER sections:
//   1. SIDECAR_SCRIPT  – path to the Python sidecar (absolute or relative to binary)
//   2. PYTHON_BIN      – python executable name ("python3", "python", …)
//   3. Add your own high-level helper methods on top of Call().
//
// Build requirements:
//   go get github.com/google/uuid
//   go get github.com/stitch/shared/go

package main

import (
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

	"github.com/google/uuid"
	stitch "github.com/stitch/shared/go"
)

// ---------------------------------------------------------------------------
// PLACEHOLDERS - edit these for your project
// ---------------------------------------------------------------------------

const (
	// SIDECAR_SCRIPT is the path to the Python sidecar file.
	SIDECAR_SCRIPT = "sidecar.py" // ← REPLACE

	// PYTHON_BIN is the Python interpreter to use.
	PYTHON_BIN = "python3" // ← REPLACE if needed
)

// ---------------------------------------------------------------------------
// Bridge client
// ---------------------------------------------------------------------------

// Bridge manages a single Python sidecar child process.
type Bridge struct {
	cmd    *exec.Cmd
	stdin  io.WriteCloser
	stdout *stitch.PendingMap

	scanner   *stitch.PendingMap // kept for type parity; actual scanner is local
	pending   *stitch.PendingMap
	closeOnce sync.Once
	done      chan struct{}
}

// NewBridge spawns the Python sidecar and waits for its ready signal.
// It also installs a SIGINT/SIGTERM handler so the child is always reaped.
func NewBridge() (*Bridge, error) {
	cmd := exec.Command(PYTHON_BIN, SIDECAR_SCRIPT)
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
		return nil, fmt.Errorf("bridge: start child: %w", err)
	}

	scanner := stitch.NewScanner(stdoutPipe)
	pending := stitch.NewPendingMap()

	b := &Bridge{
		cmd:     cmd,
		stdin:   stdinPipe,
		pending: pending,
		done:    make(chan struct{}),
	}

	// Wait for the ready signal from the child.
	if err := stitch.WaitReady(scanner); err != nil {
		_ = stitch.KillChild(cmd)
		return nil, err
	}

	// Start background goroutine that routes responses to waiting callers.
	go b.readLoop(scanner)

	// Install OS signal handler so Ctrl-C / SIGTERM cleanly kills the child.
	go b.handleSignals()

	return b, nil
}

// readLoop runs in a goroutine and dispatches every incoming line to the
// channel registered for that request ID.
func (b *Bridge) readLoop(scanner interface {
	Scan() bool
	Text() string
	Err() error
}) {
	defer func() {
		b.pending.DrainWithError("bridge: child process terminated")
	}()

	for {
		select {
		case <-b.done:
			return
		default:
		}

		if !scanner.Scan() {
			return
		}

		var resp stitch.RpcResponse
		if err := json.Unmarshal([]byte(scanner.Text()), &resp); err != nil {
			log.Printf("bridge: malformed response (skipped): %v - %q", err, scanner.Text())
			continue
		}
		if resp.ID == "" {
			log.Printf("bridge: response missing id (skipped): %q", scanner.Text())
			continue
		}

		b.pending.Dispatch(resp)
	}
}

// handleSignals catches SIGINT and SIGTERM so the child process is always
// reaped even when the parent is interrupted interactively.
func (b *Bridge) handleSignals() {
	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, os.Interrupt, syscall.SIGTERM)
	select {
	case <-sigCh:
		log.Println("bridge: received shutdown signal, killing child")
		b.Close()
		os.Exit(0)
	case <-b.done:
		signal.Stop(sigCh)
	}
}

// Call invokes a remote method on the Python sidecar and returns the raw
// JSON result.  It is safe to call from multiple goroutines concurrently.
func (b *Bridge) Call(method string, params interface{}) (json.RawMessage, error) {
	id := uuid.NewString()

	type rpcRequest struct {
		ID     string      `json:"id"`
		Method string      `json:"method"`
		Params interface{} `json:"params"`
	}
	req := rpcRequest{ID: id, Method: method, Params: params}
	data, err := json.Marshal(req)
	if err != nil {
		return nil, fmt.Errorf("bridge: marshal request: %w", err)
	}
	data = append(data, '\n')

	ch := b.pending.Register(id)

	select {
	case <-b.done:
		b.pending.Delete(id)
		return nil, errors.New("bridge: already closed")
	default:
	}

	if _, err := b.stdin.Write(data); err != nil {
		b.pending.Delete(id)
		return nil, fmt.Errorf("bridge: write request: %w", err)
	}

	resp := <-ch
	if resp.Error != nil {
		return nil, resp.Error
	}
	return resp.Result, nil
}

// Close shuts down the bridge: closes stdin so the Python watchdog detects
// EOF, waits for the child to exit (with a forced kill after 2 s), and stops
// the read-loop goroutine.
func (b *Bridge) Close() {
	b.closeOnce.Do(func() {
		_ = b.stdin.Close()
		close(b.done)
		stitch.KillChild(b.cmd)
	})
}

// ---------------------------------------------------------------------------
// Example entry-point (remove or replace in your project)
// ---------------------------------------------------------------------------

func main() {
	bridge, err := NewBridge()
	if err != nil {
		log.Fatalf("Failed to start bridge: %v", err)
	}
	defer bridge.Close()

	result, err := bridge.Call("echo", map[string]interface{}{"msg": "hello from Go"})
	if err != nil {
		log.Fatalf("Call error: %v", err)
	}
	fmt.Println("echo result:", string(result))
}
