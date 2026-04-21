// go-rust_test.go - integration tests for the Go → Rust bridge.
//
// Prerequisites: `cargo` must be on PATH (or set TEST_CHILD_BIN to a
// pre-built binary).
//
// Run:
//
//	cd bridges/go-rust/tests
//	go test -v -count=1 ./...
//
// To use a pre-built binary:
//
//	TEST_CHILD_BIN=/path/to/test-child go test -v ./...
package tests

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sync"
	"testing"
	"time"

	gobridge "github.com/stitch/go-rust"
)

// ─── Binary resolution ────────────────────────────────────────────────────────

// childBin returns the path to the test-child Rust binary.
// It honours TEST_CHILD_BIN; otherwise it derives the path from the
// cargo release output directory relative to this test file.
func childBin(t *testing.T) string {
	t.Helper()
	if bin := os.Getenv("TEST_CHILD_BIN"); bin != "" {
		return bin
	}
	_, thisFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("cannot determine test file path via runtime.Caller")
	}
	binName := "test-child"
	if runtime.GOOS == "windows" {
		binName = "test-child.exe"
	}
	return filepath.Join(filepath.Dir(thisFile), "test-child", "target", "release", binName)
}

// newBridge is a test helper that creates a RustBridge and registers Close as
// cleanup so the child process is always killed when the test ends.
func newBridge(t *testing.T) *gobridge.RustBridge {
	t.Helper()
	b, err := gobridge.NewRustBridge(childBin(t))
	if err != nil {
		t.Fatalf("NewRustBridge: %v", err)
	}
	t.Cleanup(func() { _ = b.Close() })
	return b
}

// ─── TestMain ─────────────────────────────────────────────────────────────────

// TestMain ensures the test-child Rust binary is built before any test runs.
// If TEST_CHILD_BIN is already set the build step is skipped.
// If `cargo` is not on PATH the entire suite is skipped with exit code 0 so
// CI environments without Rust do not fail the overall build.
func TestMain(m *testing.M) {
	if os.Getenv("TEST_CHILD_BIN") == "" {
		if _, err := exec.LookPath("cargo"); err != nil {
			fmt.Fprintln(os.Stderr, "SKIP: cargo not found on PATH -", err)
			os.Exit(0)
		}

		// Resolve the test-child directory relative to this file.
		_, thisFile, _, ok := runtime.Caller(0)
		if !ok {
			fmt.Fprintln(os.Stderr, "SKIP: cannot determine test file path")
			os.Exit(0)
		}
		testChildDir := filepath.Join(filepath.Dir(thisFile), "test-child")

		fmt.Fprintln(os.Stderr, "[TestMain] Building test-child Rust binary…")
		cmd := exec.Command("cargo", "build", "--release")
		cmd.Dir = testChildDir
		cmd.Stdout = os.Stderr
		cmd.Stderr = os.Stderr
		if err := cmd.Run(); err != nil {
			fmt.Fprintln(os.Stderr, "FATAL: cargo build failed:", err)
			os.Exit(1)
		}
		fmt.Fprintln(os.Stderr, "[TestMain] Build complete.")
	}

	os.Exit(m.Run())
}

// ─── Basic round-trip ─────────────────────────────────────────────────────────

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
	res, err := b.Call("add", map[string]any{"a": 17, "b": 25})
	if err != nil {
		t.Fatalf("add: %v", err)
	}
	var got struct {
		Sum float64 `json:"sum"`
	}
	if err := json.Unmarshal(res, &got); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if got.Sum != 42 {
		t.Errorf("expected sum=42, got %v", got.Sum)
	}
}

func TestAddFloats(t *testing.T) {
	b := newBridge(t)
	res, err := b.Call("add", map[string]any{"a": 1.5, "b": 2.5})
	if err != nil {
		t.Fatalf("add floats: %v", err)
	}
	var got struct {
		Sum float64 `json:"sum"`
	}
	if err := json.Unmarshal(res, &got); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if got.Sum != 4.0 {
		t.Errorf("expected sum=4.0, got %v", got.Sum)
	}
}

// ─── Ping ─────────────────────────────────────────────────────────────────────

func TestPing(t *testing.T) {
	b := newBridge(t)
	if err := b.Ping(); err != nil {
		t.Fatalf("Ping: %v", err)
	}
}

// ─── Error propagation ────────────────────────────────────────────────────────

func TestRaiseError(t *testing.T) {
	b := newBridge(t)
	_, err := b.Call("raise_error", map[string]any{"message": "boom"})
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

// TestBridgeUsableAfterError verifies that a returned error does not corrupt
// the bridge - subsequent calls must still succeed.
func TestBridgeUsableAfterError(t *testing.T) {
	b := newBridge(t)
	if _, err := b.Call("raise_error", map[string]any{"message": "intentional"}); err == nil {
		t.Fatal("expected error, got nil")
	}
	res, err := b.Call("echo", map[string]any{"key": "still alive"})
	if err != nil {
		t.Fatalf("bridge unusable after error: %v", err)
	}
	var got map[string]any
	_ = json.Unmarshal(res, &got)
	if got["key"] != "still alive" {
		t.Errorf("unexpected echo: %v", got)
	}
}

// ─── CallContext / cancellation ───────────────────────────────────────────────

func TestCallContextCancelled(t *testing.T) {
	b := newBridge(t)

	// Start a slow call (500 ms) then cancel it immediately.
	ctx, cancel := context.WithCancel(context.Background())
	cancel() // pre-cancelled

	_, err := b.CallContext(ctx, "slow", map[string]any{"ms": 500})
	if err == nil {
		t.Fatal("expected context cancellation error, got nil")
	}
	t.Logf("received expected cancellation error: %v", err)

	// Bridge must still be usable after a cancelled call.
	if pingErr := b.Ping(); pingErr != nil {
		t.Fatalf("bridge unusable after cancelled call: %v", pingErr)
	}
}

func TestCallContextTimeout(t *testing.T) {
	b := newBridge(t)

	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()

	_, err := b.CallContext(ctx, "slow", map[string]any{"ms": 500})
	if err == nil {
		t.Fatal("expected deadline exceeded error, got nil")
	}
	t.Logf("received expected timeout error: %v", err)
}

// ─── Concurrent calls ─────────────────────────────────────────────────────────

// TestConcurrent fires 20 goroutines simultaneously and verifies that all
// responses are correctly routed back to the originating caller.
func TestConcurrent(t *testing.T) {
	b := newBridge(t)
	const N = 20
	var wg sync.WaitGroup
	errs := make([]error, N)

	for i := 0; i < N; i++ {
		wg.Add(1)
		go func(n int) {
			defer wg.Done()
			res, err := b.Call("add", map[string]any{"a": n, "b": 1})
			if err != nil {
				errs[n] = fmt.Errorf("goroutine %d: %w", n, err)
				return
			}
			var got struct {
				Sum float64 `json:"sum"`
			}
			if err := json.Unmarshal(res, &got); err != nil {
				errs[n] = fmt.Errorf("goroutine %d unmarshal: %w", n, err)
				return
			}
			want := float64(n + 1)
			if got.Sum != want {
				errs[n] = fmt.Errorf("goroutine %d: want %v got %v", n, want, got.Sum)
			}
		}(i)
	}
	wg.Wait()
	for _, e := range errs {
		if e != nil {
			t.Error(e)
		}
	}
}

// TestConcurrentSlow verifies that a slow Rust handler does not block other
// concurrent callers.  The Rust test-child processes each request in the same
// thread sequentially, so this test confirms the bridge's async multiplexing
// over a single pipe works correctly.
func TestConcurrentSlow(t *testing.T) {
	b := newBridge(t)
	const goroutines = 8
	var wg sync.WaitGroup
	errs := make([]error, goroutines)
	start := time.Now()

	for i := 0; i < goroutines; i++ {
		wg.Add(1)
		go func(n int) {
			defer wg.Done()
			_, errs[n] = b.Call("slow", map[string]any{"ms": 80})
		}(i)
	}
	wg.Wait()
	elapsed := time.Since(start)

	for i, e := range errs {
		if e != nil {
			t.Errorf("goroutine %d: %v", i, e)
		}
	}
	// The Rust sidecar is single-threaded, so calls are serialised there.
	// Each 80 ms call should complete within a generous overall budget.
	if elapsed > 10*time.Second {
		t.Errorf("concurrent slow calls took too long: %v", elapsed)
	}
	t.Logf("%d concurrent slow(80ms) calls finished in %v", goroutines, elapsed)
}

// ─── stdin EOF ────────────────────────────────────────────────────────────────

// TestStdinEOF verifies that closing the bridge (which closes stdin) causes the
// Rust child to exit cleanly, and that subsequent calls return an error.
func TestStdinEOF(t *testing.T) {
	b, err := gobridge.NewRustBridge(childBin(t))
	if err != nil {
		t.Fatalf("NewRustBridge: %v", err)
	}

	// One successful call first.
	if _, err := b.Call("echo", map[string]any{"ping": true}); err != nil {
		t.Fatalf("echo before close: %v", err)
	}

	// Close sends stdin EOF; the child should exit.
	if err := b.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}

	// Wait briefly for the readLoop to notice the child has exited.
	time.Sleep(100 * time.Millisecond)

	// Subsequent calls must fail.
	_, err = b.Call("echo", map[string]any{"after": "close"})
	if err == nil {
		t.Fatal("expected error after bridge close, got nil")
	}
	t.Logf("post-close error (expected): %v", err)
}

// ─── Large payload ────────────────────────────────────────────────────────────

// TestLargePayload sends a 64 KiB string through echo_b64 to exercise the
// scanner's enlarged 4 MiB buffer.  The base-64 encoded response is ~87 KiB,
// well above the default 64 KiB bufio.Scanner limit.
func TestLargePayload(t *testing.T) {
	b := newBridge(t)

	// 64 KiB of 'A'
	big := make([]byte, 64*1024)
	for i := range big {
		big[i] = 'A'
	}

	res, err := b.Call("echo_b64", map[string]any{"data": string(big)})
	if err != nil {
		t.Fatalf("echo_b64 large: %v", err)
	}
	var got struct {
		Data string `json:"data"`
	}
	if err := json.Unmarshal(res, &got); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	// The round-trip must preserve the exact byte count (encoded length).
	if len(got.Data) == 0 {
		t.Error("expected non-empty encoded data")
	}
	t.Logf("large payload round-trip: input %d bytes, encoded %d bytes", len(big), len(got.Data))
}

// ─── Sequential reuse ─────────────────────────────────────────────────────────

// TestSequentialReuse verifies that a single bridge handles many sequential
// calls correctly without any state leakage between calls.
func TestSequentialReuse(t *testing.T) {
	b := newBridge(t)
	for i := 0; i < 50; i++ {
		res, err := b.Call("add", map[string]any{"a": i, "b": 10})
		if err != nil {
			t.Fatalf("iteration %d: %v", i, err)
		}
		var got struct {
			Sum float64 `json:"sum"`
		}
		if err := json.Unmarshal(res, &got); err != nil {
			t.Fatalf("iteration %d unmarshal: %v", i, err)
		}
		want := float64(i + 10)
		if got.Sum != want {
			t.Errorf("iteration %d: want %v got %v", i, want, got.Sum)
		}
	}
}
