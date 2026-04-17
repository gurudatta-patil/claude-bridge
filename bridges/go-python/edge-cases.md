# Edge Cases — Go → Python Bridge

This document captures Go-specific and Python-specific quirks that can trip
up implementors of the Stitch Go→Python pattern.

---

## 1. `bufio.Scanner` 64 KB default limit for large responses

`bufio.NewScanner` wraps the child's stdout with a **64 KB per-line** buffer
by default.  If the Python sidecar ever returns a response whose JSON
serialisation exceeds that (e.g. a base64-encoded image or a large ML
tensor), the scanner silently stops with `bufio.ErrTooLong` and the bridge
freezes.

**Fix** — always call `Scanner.Buffer` with a larger limit immediately after
creating the scanner:

```go
const maxResponseBytes = 8 * 1024 * 1024 // 8 MB
scanner.Buffer(make([]byte, maxResponseBytes), maxResponseBytes)
```

Tune the value to your largest expected payload.  If payload sizes are
unbounded, consider switching to a streaming protocol instead.

---

## 2. Python cold start (~200 ms) vs Go's fast spawn

Go's `exec.Command(...).Start()` returns almost instantly, but Python takes
roughly **150–300 ms** to initialise the interpreter and import standard
library modules before it can write `{"ready":true}`.

Implications:
- Always wait for the ready signal before sending the first RPC call (the
  template does this in `waitReady()`).
- Do **not** set an aggressive timeout on the ready wait; 5–10 s is
  reasonable for cold starts on CI.
- Heavy imports (numpy, torch, etc.) can push cold start past 1–2 s.  For
  latency-sensitive applications, keep the sidecar alive for the lifetime of
  the Go process rather than spawning per-request.

---

## 3. JSON type coercion: Go int64 → Python int → Go float64

Go serialises integer literals as JSON numbers (`42`).  Python's `json`
module decodes JSON numbers without a decimal point as `int`, so the sidecar
receives them correctly as Python `int`.

However, Python returns `int` results as JSON numbers **without** a decimal
point (`{"sum": 42}`).  Go's `json.Unmarshal` into `interface{}` (or
`map[string]interface{}`) decodes every JSON number as `float64`.  This is a
Go `encoding/json` design decision.

**Consequence**: if you unmarshal into `map[string]interface{}` you get
`float64(42)`, not `int(42)`.  Either:

- Unmarshal into a concrete typed struct to get the right Go type, or
- Use `json.Number` as the value type and convert explicitly, or
- Accept `float64` and cast with a bounds check.

Python `float` results (e.g. `1.5`) round-trip through JSON as `float64` on
the Go side without any issue.

---

## 4. `cmd.Wait()` must always be called — defer it

`exec.Cmd.Wait()` releases the OS resources associated with the child process
(file descriptors, the process table entry on Unix).  If you never call it,
you leak a zombie process.

The `killChild()` helper in the template always calls `cmd.Wait()` in a
goroutine after signalling the process.  Make sure your own cleanup path also
calls it — a common mistake is to call `cmd.Process.Kill()` directly without
a subsequent `Wait`.

**Pattern**:

```go
_ = cmd.Process.Signal(syscall.SIGTERM)
go func() { _ = cmd.Wait() }() // always reap
```

---

## 5. Goroutine leak: the response-reader goroutine must be stopped on Close

The `readLoop` goroutine blocks on `scanner.Scan()`.  If the caller calls
`bridge.Close()` and never reads the last response, the goroutine will block
forever unless:

1. The child's stdout pipe is closed (it is, because `cmd.Wait()` closes it
   after the process exits), or
2. `b.done` is closed so the goroutine can detect it via a `select`.

The template handles this with a `done chan struct{}` checked at the top of
the loop.  Do **not** remove that channel.

---

## 6. stdin pipe close order: close stdin FIRST, then wait

The correct shutdown sequence is:

```
1. b.stdin.Close()   ← EOF signal to the Python watchdog
2. close(b.done)     ← stop the read-loop goroutine
3. cmd.Wait()        ← reap the child (with kill fallback)
```

If you call `cmd.Wait()` before closing stdin, `Wait` will block until the
child exits on its own — but the child is waiting for more input.  You have a
deadlock.

---

## 7. Windows: `syscall.SIGTERM` is not available

On Windows, Go's `syscall` package does not export `SIGTERM`.  The `killChild`
function in the template uses `syscall.SIGTERM`; this will fail to compile on
Windows.

**Fix** — add a build constraint:

```go
//go:build !windows

package main

import "syscall"

func termSignal() os.Signal { return syscall.SIGTERM }
```

```go
//go:build windows

package main

import "os"

func termSignal() os.Signal { return os.Kill }
```

Or use a runtime check:

```go
if runtime.GOOS == "windows" {
    _ = cmd.Process.Kill()
} else {
    _ = cmd.Process.Signal(syscall.SIGTERM)
}
```

The test file already applies this pattern.

---

## 8. Race condition: writing to stdin after the child has died

If the child crashes unexpectedly (OOM, Python exception in the watchdog,
etc.), `b.stdin.Write()` will return an error (`broken pipe` on Unix,
`ERROR_NO_DATA` on Windows).  The `Call` method must handle this error and
remove the pending channel entry to avoid a goroutine leak:

```go
if _, err := b.stdin.Write(data); err != nil {
    b.mu.Lock()
    delete(b.pending, id)
    b.mu.Unlock()
    return nil, fmt.Errorf("bridge: write: %w", err)
}
```

The template does this correctly; do not omit the cleanup on write failure.
