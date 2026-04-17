# Edge Cases — Python → Go Bridge

This document captures Python-to-Go-specific edge cases that implementors and
contributors must be aware of.

---

## 1. Go startup speed vs Python client startup

Go binaries start in **< 10 ms** on modern hardware, far faster than a typical
Python interpreter.  The practical danger is the opposite: a Python caller that
issues its first `call()` before `start()` returns.  `GoBridge.start()` blocks
until `{"ready":true}` is received, so this is safe — but callers must not
bypass `start()` (or the context manager `__enter__`).

---

## 2. `bufio.Scanner` 64 KB default limit

`bufio.NewScanner` uses a 64 KB internal buffer.  Any single JSON line that
exceeds this limit causes `scanner.Scan()` to return `false` and
`scanner.Err()` to return `bufio.ErrTooLong`, silently killing the request
loop.

**Mitigation** (already applied in `test-child/main.go`):

```go
buf := make([]byte, 4*1024*1024) // 4 MiB
scanner.Buffer(buf, cap(buf))
```

Choose the cap based on the largest payload your application will send.
For truly unbounded payloads, read raw bytes with `bufio.Reader.ReadBytes('\n')`
instead.

---

## 3. Go's strict type system — JSON floats and `json.Number`

Go's default JSON decoder maps all JSON numbers to `float64`, which can lose
precision for large integers (> 2^53).  Use `json.Number` for numeric fields
that may carry integer or high-precision values, then convert explicitly:

```go
var p struct {
    A json.Number `json:"a"`
}
json.Unmarshal(params, &p)
a, _ := p.A.Int64()   // or .Float64()
```

Python's `json` module sends integers as bare integers (e.g., `42`) and floats
as floats (e.g., `3.14`); both are valid JSON numbers and must be handled on
the Go side.

---

## 4. Compile step — `GoBridge.build()` must run before first use

Unlike interpreted languages, the Go sidecar must be compiled before it can be
spawned.  `GoBridge.build(source_dir)` is a static helper that shells out to
`go build`.  Call it once during application initialisation or as part of a
setup/install script:

```python
binary = GoBridge.build("path/to/sidecar")
bridge = GoBridge(binary)
```

If `go` is not on `PATH`, `build()` raises `FileNotFoundError` (from
`subprocess.run`).  CI pipelines should ensure Go is installed and in `PATH`
before running Python tests.

---

## 5. Windows: `.exe` extension and `GOPATH` resolution

On Windows:

* `go build` produces a binary named `<dir>.exe` unless `-o` overrides it.
  `GoBridge.build()` automatically appends `.exe` on `sys.platform == "win32"`.
* `GOPATH` is typically `%USERPROFILE%\go`; ensure the Go toolchain is
  installed via the official MSI or `winget install GoLang.Go`.
* Pipe buffering on Windows is line-buffered or fully buffered depending on the
  runtime.  `bufsize=0` in `subprocess.Popen` forces unbuffered reads on the
  Python side; the Go sidecar must call `stdout.Flush()` after every write
  (already enforced in all templates).

---

## 6. Goroutine cleanup — reader goroutine exits when stdin pipe closes

The Go sidecar's main goroutine blocks on `scanner.Scan()`.  When Python closes
the stdin pipe (`proc.stdin.close()`), `Scan()` returns `false` and `main()`
returns, which terminates the process and implicitly cancels all goroutines.

If your sidecar spawns additional goroutines (e.g., for concurrent method
handlers), ensure they either:

1. Respect a `context.Context` derived from a cancellable root context, **or**
2. Select on a `done` channel that is closed when `main()` begins to exit.

Goroutine leaks in a sidecar will not surface until the process exits, but they
waste memory and file descriptors during the process lifetime.

---

## 7. Python subprocess pipe buffering on Windows

On Windows, `subprocess.PIPE` combined with a Go binary that writes small
chunks can cause the Python reader thread to block indefinitely if the OS-level
pipe buffer is full.  Mitigations:

* Set `bufsize=0` in `Popen` (already done in the template).
* Ensure the Go sidecar flushes stdout after **every** response (`stdout.Flush()`).
* Avoid writing to stderr from the Go sidecar in tight loops; stderr is also a
  pipe and can fill up, blocking the sidecar if Python does not drain it.
  The template discards stderr in tests; production code should drain it in a
  dedicated thread.

---

## 8. Method not found vs parse error

The sidecar returns different error codes for these failure modes:

| Situation               | Code    |
|-------------------------|---------|
| Invalid JSON            | -32700  |
| Unknown method          | -32601  |
| Invalid / missing params| -32602  |
| Application error       | any > 0 |

Python callers should inspect `GoBridgeError.code` and handle parse/method
errors separately from application errors.

---

## 9. Concurrent calls and ID collision

`GoBridge` generates IDs with `uuid.uuid4()` (122 bits of randomness).  The
probability of a collision within a single process lifetime is negligible.  If
you replace the ID scheme with shorter tokens for performance, ensure they are
unique within the window of outstanding requests, not globally.

---

## 10. Partial reads and line boundaries

Newline-delimited JSON assumes each JSON object fits on a single line.  Neither
Python's `json.dumps` nor Go's `json.Marshal` emit embedded newlines by default
— but if you ever pretty-print on one side, the other side will misparse.
Always use compact serialisation (Python: `separators=(',', ':')`, Go: default
`json.Marshal`).
