# Go-Specific Edge Cases

## 1. Compile step required before spawning

Unlike interpreted runtimes, a Go sidecar must be compiled to a native binary
before the TypeScript parent can spawn it.  Add a build step to your CI
pipeline and ensure the binary is committed or built as part of the project
setup:

```sh
go build -o .stitch/go/<bridge>/bridge ./path/to/sidecar
```

The compiled binary is platform-specific.  Cross-compile for other targets
with `GOOS` / `GOARCH`:

```sh
GOOS=linux GOARCH=amd64 go build -o bridge-linux-amd64 .
```

---

## 2. Go's fast startup (~5 ms) vs Python (~200 ms)

Go binaries start almost instantly because there is no interpreter to
initialise.  The `{"ready":true}` handshake is therefore typically received
within 5–20 ms of spawning, making Go an excellent choice for latency-sensitive
sidecars.  Do not assume a long startup grace period in tests — the ready
timeout can be set as low as 2 s.

---

## 3. bufio.Scanner default 64 KB line limit — increase for large payloads

`bufio.NewScanner` uses a 64 KB internal buffer.  A single JSON-RPC line that
exceeds this limit will cause `scanner.Scan()` to return `false` and
`scanner.Err()` to return `bufio.ErrTooLong`.

Always enlarge the buffer at startup when large payloads are expected:

```go
scanner := bufio.NewScanner(os.Stdin)
scanner.Buffer(make([]byte, 10*1024*1024), 10*1024*1024) // 10 MB
```

---

## 4. JSON number types: Go decodes all numbers as float64 by default

When you unmarshal into an `interface{}`, Go represents every JSON number as
`float64`.  For large integers (> 2^53) this causes precision loss.

Prefer typed structs wherever possible:

```go
var params struct {
    Count int64   `json:"count"`
    Value float64 `json:"value"`
}
json.Unmarshal(req.Params, &params)
```

Or use `json.Number` when the type is unknown:

```go
var raw map[string]json.Number
json.Unmarshal(req.Params, &raw)
n, _ := raw["count"].Int64()
```

---

## 5. Goroutine leak if channel not drained on exit

If you launch goroutines that write to unbuffered channels but the receiver
exits early (e.g., on signal), those goroutines will block forever — a
goroutine leak.  Mitigate by:

- Using buffered channels with capacity equal to the number of writers.
- Closing channels from the sender side and ranging over them in the receiver.
- Using `context.Context` cancellation to signal goroutines to stop.

Example:

```go
ctx, cancel := context.WithCancel(context.Background())
go func() {
    <-sigCh
    cancel() // unblocks all goroutines listening on ctx.Done()
}()
```

---

## 6. Windows: no SIGTERM — use SIGINT or os/signal

On Windows, `syscall.SIGTERM` is not delivered by the OS to child processes.
`os/signal.Notify` will still register the signal without error, but it will
never fire.  The reliable cross-platform signal for graceful shutdown on
Windows is `os.Interrupt` (which maps to `SIGINT` / Ctrl+C).

```go
signal.Notify(sigCh, os.Interrupt, syscall.SIGTERM) // SIGTERM works on POSIX only
```

The TypeScript `killChild()` helper sends a bare `child.kill()` on Windows
(which terminates the process immediately), so the signal path is less
critical there.

---

## 7. Avoid CGo dependencies to keep compilation simple

Any Go package that imports `C` (CGo) requires a C compiler at build time and
produces a dynamically linked binary.  This complicates cross-compilation and
Docker builds.

Prefer pure-Go alternatives:

| Avoid (CGo)          | Use instead (pure Go)       |
|----------------------|-----------------------------|
| `github.com/mattn/go-sqlite3` | `modernc.org/sqlite` |
| `github.com/lib/pq` (some builds) | `github.com/jackc/pgx/v5` |
| `github.com/go-gl/*` | N/A — use a server-side renderer |

Verify your build is CGo-free:

```sh
CGO_ENABLED=0 go build -o bridge .
```
