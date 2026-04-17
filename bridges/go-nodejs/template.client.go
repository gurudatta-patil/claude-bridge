// template.client.go — Go client that spawns a Node.js sidecar and communicates
// with it over newline-delimited JSON-RPC via stdin/stdout.
//
// Usage: replace the constants / Call invocations below with your own methods.
package gobridge

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"os/signal"
	"sync"
	"syscall"

	ghostbridge "github.com/stitch/shared/go"
	"github.com/google/uuid"
)

// ---------------------------------------------------------------------------
// Wire types
// ---------------------------------------------------------------------------

type rpcRequest struct {
	ID     string         `json:"id"`
	Method string         `json:"method"`
	Params map[string]any `json:"params"`
}

// ---------------------------------------------------------------------------
// Bridge
// ---------------------------------------------------------------------------

// NodeBridge manages a long-lived Node.js child process.
type NodeBridge struct {
	cmd     *exec.Cmd
	stdin   io.WriteCloser
	mu      sync.Mutex
	pending *ghostbridge.PendingMap
	done    chan struct{}
}

// NewNodeBridge spawns `node <scriptPath>` and waits for the {"ready":true} signal.
// Additional arguments are forwarded to the node process as argv.
func NewNodeBridge(scriptPath string, args ...string) (*NodeBridge, error) {
	nodePath, err := LookupNode()
	if err != nil {
		return nil, err
	}
	nodeArgs := append([]string{scriptPath}, args...)
	cmd := exec.Command(nodePath, nodeArgs...)
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
		return nil, fmt.Errorf("start node: %w", err)
	}

	scanner := ghostbridge.NewScanner(stdout)
	pending := ghostbridge.NewPendingMap()

	b := &NodeBridge{
		cmd:     cmd,
		stdin:   stdin,
		pending: pending,
		done:    make(chan struct{}),
	}

	// Wait for {"ready":true} before returning.
	if err := ghostbridge.WaitReady(scanner); err != nil {
		_ = cmd.Process.Kill()
		return nil, fmt.Errorf("child exited before sending ready signal: %w", err)
	}

	// Dispatch loop — reads responses from the child and routes them.
	go b.readLoop(scanner)

	// SIGTERM / SIGINT watchdog — kill the child when the parent is signalled.
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

// readLoop dispatches incoming responses to waiting callers.
func (b *NodeBridge) readLoop(scanner interface {
	Scan() bool
	Bytes() []byte
}) {
	defer close(b.done)
	for scanner.Scan() {
		var resp ghostbridge.RpcResponse
		if err := json.Unmarshal(scanner.Bytes(), &resp); err != nil {
			continue // malformed line — skip
		}
		b.pending.Dispatch(resp)
	}
	// Scanner ended — child stdout closed; fail all pending callers.
	b.pending.DrainWithError("child process exited")
}

// Call sends a JSON-RPC request to the Node.js child and blocks until a response arrives.
func (b *NodeBridge) Call(method string, params map[string]any) (json.RawMessage, error) {
	id := uuid.New().String()
	ch := b.pending.Register(id)

	b.mu.Lock()
	line, _ := json.Marshal(rpcRequest{ID: id, Method: method, Params: params})
	_, err := fmt.Fprintf(b.stdin, "%s\n", line)
	b.mu.Unlock()

	if err != nil {
		b.pending.Delete(id)
		return nil, fmt.Errorf("encode request: %w", err)
	}

	resp := <-ch
	if resp.Error != nil {
		return nil, resp.Error
	}
	return resp.Result, nil
}

// Close shuts down the Node.js child gracefully.
func (b *NodeBridge) Close() error {
	_ = b.stdin.Close()
	_ = b.cmd.Wait()
	return nil
}
