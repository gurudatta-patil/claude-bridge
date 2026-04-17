package goruby

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"sync"
	"time"

	ghostbridge "github.com/stitch/shared/go"
	"github.com/google/uuid"
)

// Request is a JSON-RPC request sent to the Ruby sidecar.
type Request struct {
	ID     string         `json:"id"`
	Method string         `json:"method"`
	Params map[string]any `json:"params"`
}

// Client manages the lifecycle of a Ruby sidecar subprocess and multiplexes
// concurrent JSON-RPC calls over its stdin/stdout pipes.
type Client struct {
	cmd     *exec.Cmd
	stdin   io.WriteCloser
	writeMu sync.Mutex // serialises writes to stdin
	pending *ghostbridge.PendingMap
	done    chan struct{}
	once    sync.Once
}

// New starts the Ruby sidecar at scriptPath (invoked as `ruby scriptPath`)
// and waits for the {"ready":true} handshake before returning.
//
// Any additional Ruby interpreter flags can be supplied via rubyArgs; they are
// inserted between "ruby" and scriptPath.
func New(scriptPath string, rubyArgs ...string) (*Client, error) {
	args := append(rubyArgs, scriptPath)
	cmd := exec.Command("ruby", args...)
	cmd.Stderr = os.Stderr

	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, fmt.Errorf("go-ruby: stdin pipe: %w", err)
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, fmt.Errorf("go-ruby: stdout pipe: %w", err)
	}

	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("go-ruby: start ruby: %w", err)
	}

	scanner := ghostbridge.NewScanner(stdout)
	pending := ghostbridge.NewPendingMap()

	c := &Client{
		cmd:     cmd,
		stdin:   stdin,
		pending: pending,
		done:    make(chan struct{}),
	}

	// Wait for the ready signal.
	readyCh := make(chan error, 1)
	go func() {
		if err := ghostbridge.WaitReady(scanner); err != nil {
			readyCh <- err
			return
		}
		readyCh <- nil

		// Dispatch loop — runs for the lifetime of the process.
		for scanner.Scan() {
			var resp ghostbridge.RpcResponse
			if err := json.Unmarshal(scanner.Bytes(), &resp); err != nil {
				continue // malformed frame — skip
			}
			pending.Dispatch(resp)
		}
		close(c.done)
	}()

	select {
	case err := <-readyCh:
		if err != nil {
			_ = cmd.Process.Kill()
			return nil, err
		}
	case <-time.After(10 * time.Second):
		_ = cmd.Process.Kill()
		return nil, fmt.Errorf("go-ruby: timeout waiting for ready signal")
	}

	return c, nil
}

// Call invokes method on the sidecar with the given params and unmarshals the
// result into out (which must be a pointer, or nil to discard).
func (c *Client) Call(method string, params map[string]any, out any) error {
	id := uuid.New().String()
	req := Request{ID: id, Method: method, Params: params}

	line, err := json.Marshal(req)
	if err != nil {
		return fmt.Errorf("go-ruby: marshal request: %w", err)
	}

	ch := c.pending.Register(id)

	c.writeMu.Lock()
	_, writeErr := fmt.Fprintf(c.stdin, "%s\n", line)
	c.writeMu.Unlock()
	if writeErr != nil {
		c.pending.Delete(id)
		return fmt.Errorf("go-ruby: write to sidecar: %w", writeErr)
	}

	select {
	case resp := <-ch:
		if resp.Error != nil {
			return resp.Error
		}
		if out != nil && resp.Result != nil {
			return json.Unmarshal(resp.Result, out)
		}
		return nil
	case <-c.done:
		return fmt.Errorf("go-ruby: sidecar exited while waiting for response to %q", method)
	}
}

// Close shuts down the Ruby sidecar gracefully: it closes stdin (causing the
// watchdog thread to detect EOF and call exit), then sends SIGTERM, and
// finally SIGKILL after a 2-second grace period.
func (c *Client) Close() error {
	var closeErr error
	c.once.Do(func() {
		_ = c.stdin.Close()
		ghostbridge.KillChild(c.cmd)
		closeErr = nil
	})
	return closeErr
}
