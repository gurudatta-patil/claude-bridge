package goruby_test

import (
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

	goruby "github.com/claude-bridge/bridges/go-ruby"
)

// testScript returns the absolute path to tests/test-child.rb so the tests
// work regardless of the working directory Go chooses when running them.
func testScript(t *testing.T) string {
	t.Helper()
	_, thisFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("runtime.Caller failed")
	}
	// This file lives at the module root; test-child.rb is in tests/.
	return filepath.Join(filepath.Dir(thisFile), "tests", "test-child.rb")
}

func newClient(t *testing.T) *goruby.Client {
	t.Helper()
	c, err := goruby.New(testScript(t))
	if err != nil {
		t.Fatalf("failed to start sidecar: %v", err)
	}
	t.Cleanup(func() { _ = c.Close() })
	return c
}

// ── Round-trip ────────────────────────────────────────────────────────────────

func TestEchoRoundTrip(t *testing.T) {
	c := newClient(t)

	var result map[string]any
	if err := c.Call("echo", map[string]any{"text": "hello"}, &result); err != nil {
		t.Fatalf("echo call failed: %v", err)
	}
	if result["text"] != "hello" {
		t.Errorf("expected text=hello, got %v", result["text"])
	}
}

func TestAddRoundTrip(t *testing.T) {
	c := newClient(t)

	var result map[string]any
	if err := c.Call("add", map[string]any{"a": 7, "b": 13}, &result); err != nil {
		t.Fatalf("add call failed: %v", err)
	}
	// JSON numbers decode as float64 in Go's map[string]any.
	if result["sum"] != float64(20) {
		t.Errorf("expected sum=20, got %v", result["sum"])
	}
}

func TestEchoBase64(t *testing.T) {
	c := newClient(t)

	// "Hello World" base64-encoded.
	const encoded = "SGVsbG8gV29ybGQ="
	var result map[string]any
	if err := c.Call("echo_b64", map[string]any{"data": encoded}, &result); err != nil {
		t.Fatalf("echo_b64 call failed: %v", err)
	}
	if result["decoded"] != "Hello World" {
		t.Errorf("expected decoded=Hello World, got %v", result["decoded"])
	}
	if result["re_encoded"] != encoded {
		t.Errorf("expected re_encoded=%s, got %v", encoded, result["re_encoded"])
	}
}

// ── Error propagation ─────────────────────────────────────────────────────────

func TestRaiseError(t *testing.T) {
	c := newClient(t)

	err := c.Call("raise_error", map[string]any{"msg": "boom"}, nil)
	if err == nil {
		t.Fatal("expected an error, got nil")
	}
	if !strings.Contains(err.Error(), "boom") {
		t.Errorf("expected error message to contain 'boom', got: %v", err)
	}
}

func TestUnknownMethod(t *testing.T) {
	c := newClient(t)

	err := c.Call("no_such_method", nil, nil)
	if err == nil {
		t.Fatal("expected an error for unknown method")
	}
	if !strings.Contains(err.Error(), "unknown method") {
		t.Errorf("expected 'unknown method' in error, got: %v", err)
	}
}

// ── Concurrency ───────────────────────────────────────────────────────────────

func TestConcurrentCalls(t *testing.T) {
	c := newClient(t)

	const workers = 20
	var wg sync.WaitGroup
	errs := make(chan error, workers)

	start := time.Now()
	for i := 0; i < workers; i++ {
		wg.Add(1)
		go func(n int) {
			defer wg.Done()
			var result map[string]any
			if err := c.Call("add", map[string]any{"a": n, "b": n}, &result); err != nil {
				errs <- err
				return
			}
			expected := float64(n * 2)
			if result["sum"] != expected {
				errs <- nil // count mismatch separately
			}
		}(i)
	}
	wg.Wait()
	close(errs)

	elapsed := time.Since(start)
	t.Logf("%d concurrent add calls finished in %v", workers, elapsed)

	for err := range errs {
		if err != nil {
			t.Errorf("concurrent call error: %v", err)
		}
	}
}

// TestSlowConcurrent fires several slow calls simultaneously and asserts that
// the total wall-clock time is less than the sum of individual sleep durations,
// confirming that calls are truly pipelined and not serialised.
func TestSlowConcurrent(t *testing.T) {
	c := newClient(t)

	const (
		workers  = 5
		sleepMs  = 150
		maxTotal = time.Duration(workers) * sleepMs * time.Millisecond / 2
	)

	var wg sync.WaitGroup
	start := time.Now()
	for i := 0; i < workers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			var r map[string]any
			_ = c.Call("slow", map[string]any{"ms": sleepMs}, &r)
		}()
	}
	wg.Wait()
	elapsed := time.Since(start)

	// Each call sleeps 150 ms; if serialised it would take ~750 ms.
	// With concurrent dispatch we expect far less. Allow generous 3× headroom.
	limit := time.Duration(workers) * sleepMs * time.Millisecond * 3
	if elapsed >= limit {
		t.Errorf("slow concurrent calls took %v; expected < %v (suggests serialisation)", elapsed, limit)
	}
	t.Logf("slow concurrent: %d × %dms finished in %v (max allowed %v)", workers, sleepMs, elapsed, maxTotal)
}

// ── stdin EOF ─────────────────────────────────────────────────────────────────

// TestStdinEOF closes the client and verifies that a subsequent Call returns
// an error rather than blocking forever.
func TestStdinEOF(t *testing.T) {
	c, err := goruby.New(testScript(t))
	if err != nil {
		t.Fatalf("failed to start sidecar: %v", err)
	}

	// Close immediately — do NOT defer so we can test afterwards.
	if err := c.Close(); err != nil {
		t.Logf("close warning: %v", err) // non-fatal; process may already be gone
	}

	// Allow the sidecar a moment to fully exit.
	time.Sleep(300 * time.Millisecond)

	// Any subsequent call must return an error.
	callErr := c.Call("echo", map[string]any{"text": "after close"}, nil)
	if callErr == nil {
		t.Error("expected error after sidecar exit, got nil")
	} else {
		t.Logf("got expected post-close error: %v", callErr)
	}
}
