// go-nodejs_test.go — integration tests for the Go→Node.js bridge.
//
// Prerequisites: `node` must be on PATH.
// Run:  go test -v -count=1 ./tests/
package tests

import (
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"sync"
	"testing"
	"time"

	gobridge "github.com/ghost-bridge/go-nodejs"
)

// childScript returns the absolute path to test-child.js relative to this file.
func childScript(t *testing.T) string {
	t.Helper()
	_, file, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("cannot determine test file path")
	}
	return filepath.Join(filepath.Dir(file), "test-child.js")
}

func newBridge(t *testing.T) *gobridge.NodeBridge {
	t.Helper()
	b, err := gobridge.NewNodeBridge(childScript(t))
	if err != nil {
		t.Fatalf("NewNodeBridge: %v", err)
	}
	t.Cleanup(func() { _ = b.Close() })
	return b
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

func TestEcho(t *testing.T) {
	b := newBridge(t)
	res, err := b.Call("echo", map[string]any{"hello": "world", "num": 42})
	if err != nil {
		t.Fatalf("echo: %v", err)
	}
	var got map[string]any
	if err := json.Unmarshal(res, &got); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if got["hello"] != "world" {
		t.Errorf("expected hello=world, got %v", got["hello"])
	}
}

func TestAdd(t *testing.T) {
	b := newBridge(t)
	res, err := b.Call("add", map[string]any{"a": 7, "b": 8})
	if err != nil {
		t.Fatalf("add: %v", err)
	}
	var got struct{ Sum float64 `json:"sum"` }
	if err := json.Unmarshal(res, &got); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if got.Sum != 15 {
		t.Errorf("expected 15, got %v", got.Sum)
	}
}

func TestRaiseError(t *testing.T) {
	b := newBridge(t)
	_, err := b.Call("raise_error", map[string]any{"msg": "boom"})
	if err == nil {
		t.Fatal("expected an error but got nil")
	}
	t.Logf("received expected error: %v", err)
}

func TestUnknownMethod(t *testing.T) {
	b := newBridge(t)
	_, err := b.Call("no_such_method", nil)
	if err == nil {
		t.Fatal("expected method-not-found error")
	}
	t.Logf("received expected error: %v", err)
}

func TestEchoB64(t *testing.T) {
	b := newBridge(t)
	// "Hello World" in base-64
	res, err := b.Call("echo_b64", map[string]any{"data": "SGVsbG8gV29ybGQ="})
	if err != nil {
		t.Fatalf("echo_b64: %v", err)
	}
	var got struct {
		Decoded   string `json:"decoded"`
		Reencoded string `json:"reencoded"`
	}
	if err := json.Unmarshal(res, &got); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if got.Decoded != "Hello World" {
		t.Errorf("expected 'Hello World', got %q", got.Decoded)
	}
	if got.Reencoded != "SGVsbG8gV29ybGQ=" {
		t.Errorf("unexpected reencoded: %q", got.Reencoded)
	}
}

func TestConcurrentSlow(t *testing.T) {
	b := newBridge(t)
	const goroutines = 10
	var wg sync.WaitGroup
	errs := make([]error, goroutines)
	start := time.Now()

	for i := 0; i < goroutines; i++ {
		wg.Add(1)
		go func(n int) {
			defer wg.Done()
			_, errs[n] = b.Call("slow", map[string]any{"ms": 80, "tag": n})
		}(i)
	}
	wg.Wait()
	elapsed := time.Since(start)

	for i, e := range errs {
		if e != nil {
			t.Errorf("goroutine %d: %v", i, e)
		}
	}
	// All 10 calls should complete close to 80 ms (Node handles them concurrently).
	if elapsed > 2*time.Second {
		t.Errorf("concurrent slow calls took too long: %v", elapsed)
	}
	t.Logf("10 concurrent slow(80ms) calls finished in %v", elapsed)
}

func TestStdinEOF(t *testing.T) {
	// Verify that closing the bridge (which closes stdin) causes the child to exit.
	b, err := gobridge.NewNodeBridge(childScript(t))
	if err != nil {
		t.Fatalf("NewNodeBridge: %v", err)
	}
	// Make one successful call first.
	if _, err := b.Call("echo", map[string]any{"ping": true}); err != nil {
		t.Fatalf("echo before close: %v", err)
	}
	// Close the bridge — this closes stdin, triggering rl.on('close') in the child.
	if err := b.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
	// Subsequent calls must fail (child is gone).
	_, err = b.Call("echo", map[string]any{"after": "close"})
	if err == nil {
		t.Fatal("expected error after bridge close, got nil")
	}
	t.Logf("post-close error (expected): %v", err)
}

func TestLargePayload(t *testing.T) {
	b := newBridge(t)
	// Send a reasonably large payload to exercise the stdout write path.
	big := make([]byte, 64*1024) // 64 KiB of 'A'
	for i := range big {
		big[i] = 'A'
	}
	res, err := b.Call("echo", map[string]any{"data": string(big)})
	if err != nil {
		t.Fatalf("large echo: %v", err)
	}
	var got map[string]any
	if err := json.Unmarshal(res, &got); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if s, _ := got["data"].(string); len(s) != len(big) {
		t.Errorf("payload length mismatch: got %d, want %d", len(s), len(big))
	}
}

// TestNodeAvailable skips the whole suite if node is not found.
func TestMain(m *testing.M) {
	if _, err := gobridge.LookupNode(); err != nil {
		// Print a clear message and exit 0 (skip, not fail) so CI on environments
		// without Node does not break the overall build.
		println("SKIP: node not found on PATH —", err.Error())
		os.Exit(0)
	}
	os.Exit(m.Run())
}
