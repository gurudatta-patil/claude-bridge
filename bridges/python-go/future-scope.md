# Future Scope — Python → Go Bridge

Ideas for extending the Python → Go bridge beyond its current capabilities.
None of these are implemented yet; they are recorded here for future
contributors.

---

## 1. `context.Context` timeout propagation

**Problem:** Python's `call(timeout=N)` raises `TimeoutError` on the Python
side, but the Go sidecar keeps executing the handler until it finishes.  For
long-running handlers this wastes CPU and goroutines.

**Idea:** Include an optional `deadline` field in the JSON-RPC request:

```json
{"id": "...", "method": "slow", "params": {"seconds": 30}, "deadline": 1713300000.5}
```

The Go dispatcher creates a `context.WithDeadline` from the Unix timestamp and
passes it to handlers:

```go
type HandlerFunc func(ctx context.Context, params json.RawMessage) (interface{}, *RPCError)
```

Handlers that perform I/O or sub-process calls respect the context and return
early when it is cancelled.

---

## 2. Streaming / server-sent events

**Problem:** Some methods produce incremental output (LLM token streaming,
file-processing progress, log tailing).  The current protocol returns a single
`result` per request.

**Idea:** Introduce a `stream` flag and `event` response type:

```json
// request
{"id":"abc","method":"stream_tokens","params":{"prompt":"hello"},"stream":true}

// partial events  (no "id" match needed — use sub-id)
{"id":"abc","event":"token","data":"Hello"}
{"id":"abc","event":"token","data":", world"}

// terminal response
{"id":"abc","result":{"tokens":2}}
```

Python side: `bridge.stream("stream_tokens", params)` returns a generator that
yields each `data` value and completes when the terminal `result` arrives.

---

## 3. `go generate` for Python type stubs

**Problem:** Python callers have no IDE completion or type checking for remote
method signatures.

**Idea:** A Go tool (`cmd/gen-stubs`) parses the handler map and its parameter
structs using `go/ast` and emits a `.pyi` stub file:

```python
# generated — do not edit
class GoBridgeStubs:
    def echo(self, message: str) -> str: ...
    def add(self, a: float, b: float) -> float: ...
    def slow(self, seconds: float) -> str: ...
```

Integrate with `go generate` so stubs are regenerated whenever the handler map
changes:

```go
//go:generate go run ../../cmd/gen-stubs -out ../../../python/stubs/sidecar.pyi
```

---

## 4. Multiplexed transport (replace stdio with a Unix socket or named pipe)

**Problem:** Stdio is simple but limited to one byte stream.  On heavily
loaded systems, a single writer and a single reader can become a bottleneck.

**Idea:** An optional `--transport socket` flag causes the sidecar to listen on
a Unix domain socket (Linux/macOS) or a named pipe (Windows).  Multiple Python
`GoBridge` instances can connect concurrently without spawning multiple
processes.

---

## 5. Automatic re-spawn on crash

**Problem:** If the Go sidecar panics, the Python bridge raises on the next
call but does not recover automatically.

**Idea:** `GoBridge(binary, auto_restart=True, max_restarts=3)` detects that
`_proc.poll() is not None` (process exited unexpectedly) and re-spawns,
replaying any pending requests.

---

## 6. Metrics and tracing

**Idea:** Each request/response pair records:
* wall-clock latency (Python side)
* Go-side handler duration (returned as a `_meta` field in the response)
* error rate per method

Expose these via a `bridge.metrics()` call or hook them into OpenTelemetry
spans for distributed tracing.

---

## 7. Binary framing (MessagePack / protobuf) as an alternative to JSON

**Problem:** JSON is human-readable but slow for large binary payloads (base64
overhead, UTF-8 encoding, parser allocation).

**Idea:** A compile-time build tag `//go:build msgpack` swaps the codec.
Python uses `msgpack-python`; framing changes from newline-delimited to
4-byte length-prefixed frames.

---

## 8. Hot-reload / live update

**Idea:** When the Go source changes, `GoBridge.reload()` re-runs `go build`,
stops the current sidecar with a graceful drain (no new requests accepted,
in-flight requests complete), then starts the new binary.  Useful in
development workflows without restarting the entire Python application.

---

## 9. Windows named-pipe transport for lower-latency IPC

On Windows, anonymous pipes (used by `subprocess.PIPE`) are slower than named
pipes for high-throughput scenarios.  A future `--transport named-pipe` flag
could use `\\.\pipe\stitch-<pid>` for better throughput on Windows.

---

## 10. Formal JSON Schema / OpenRPC spec generation

Emit an OpenRPC document from the Go handler map so that:
* Python clients can validate request/response shapes at runtime.
* Documentation is auto-generated from the schema.
* Mock servers can be generated for unit testing without compiling Go.
