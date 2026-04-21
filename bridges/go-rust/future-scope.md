# Future Scope - Go → Rust Bridge

A Go → Rust bridge lets Go services offload CPU-intensive, memory-safety-critical,
or latency-sensitive work to a Rust sidecar without requiring CGo or in-process
linking.

---

## 1. CGo vs. Stitch trade-off reference

Before choosing the IPC bridge, consider the alternatives:

| Dimension | Stitch (stdio) | CGo via `cgo` |
|---|---|---|
| Overhead per call | ~0.1–0.5 ms (JSON + pipe) | ~100 ns (C ABI) |
| Crash isolation | Full — Rust panic ≠ Go crash | None — panic kills process |
| Cross-compilation | Easy (two separate binaries) | Hard (needs C toolchain) |
| Windows support | Full | Requires MSVC or MinGW |
| Deployment | Two files | One binary |

**Prefer Stitch when** crash isolation, independent deployability, or
WebAssembly targets are requirements. Prefer CGo for sub-millisecond
hot-path integrations where the two codebases are tightly coupled.

---

## 2. Tokio async sidecar for concurrent request handling

The Rust sidecar can use `tokio` to handle multiple in-flight requests concurrently
from a single process — useful when the Go client uses goroutines to call the
bridge in parallel:

```rust
#[tokio::main]
async fn main() {
    let stdin = tokio::io::stdin();
    let mut lines = tokio::io::BufReader::new(stdin).lines();
    while let Some(line) = lines.next_line().await.unwrap() {
        tokio::spawn(handle_request(line));
    }
}
```

Concurrent writes back to stdout are serialised with a `tokio::sync::Mutex<Stdout>`.

---

## 3. Shared memory (mmap) for large payloads

For data exceeding ~100 KB (tensors, image buffers, large arrays), Base64 over
stdio adds ~33% size overhead plus encoding/decoding CPU cost. A future extension
passes only a file path via JSON-RPC while the actual data moves through a
memory-mapped region:

- Go: `golang.org/x/sys/unix.Mmap` or `syscall.Mmap`
- Rust: `memmap2` crate (`MmapMut`)

The JSON message carries only the shared-memory file path and byte length;
the sidecar maps the file directly and processes data in-place.

---

## 4. Protocol Buffers / MessagePack for typed contracts

Replace newline-delimited JSON with a binary framing protocol:

- **MessagePack**: `vmihailenco/msgpack` (Go) + `rmp-serde` (Rust). ~2× smaller
  payloads, ~3× faster (de)serialisation. Drop-in replacement; no schema required.
- **Protocol Buffers**: `google.golang.org/protobuf` + `prost` (Rust). Strong
  versioning story; generates typed code from `.proto` schemas.
- **Cap'n Proto / FlatBuffers**: zero-copy deserialisation; best paired with the
  mmap approach above.

Binary formats require length-prefixed framing instead of newline-delimited.

---

## 5. `ts-rs`-style Go struct → Rust type sharing

Auto-generate Rust request/response structs from Go struct definitions using a
code-generation tool (e.g. `tygo` or a custom `go/ast` walker):

```
// go source:
type AddParams struct { A int64; B int64 }
// generated Rust:
#[derive(Serialize, Deserialize)]
pub struct AddParams { pub a: i64, pub b: i64 }
```

Single source of truth in Go; Rust types are always in sync without manual
maintenance.

---

## 6. Health-check and auto-restart

Add a built-in `_ping` / `_pong` method to the Rust sidecar. Go calls it on a
ticker to detect silent hangs; on failure the bridge kills the child and respawns
it, replaying idempotent in-flight requests.

---

## 7. Multi-sidecar pool (`BridgePool`)

For throughput-sensitive applications, spawn N Rust workers and load-balance with
round-robin or least-connections routing:

```go
pool := NewBridgePool(binary, N)
result, err := pool.Call("compute", params)
```

Each worker handles sequential requests; horizontal scaling comes from the pool.
Failed workers are transparently respawned and replaced.

---

## 8. OpenTelemetry trace context propagation

Propagate W3C `traceparent` headers inside the JSON-RPC envelope so that calls
across the Go↔Rust boundary appear as child spans in Jaeger, Zipkin, or any
OTLP-compatible backend:

```json
{"id":"...","method":"compute","params":{...},
 "traceparent":"00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"}
```

Both `go.opentelemetry.io/otel` and `tracing-opentelemetry` (Rust) can consume
and propagate W3C trace context.

---

## 9. WASM/WASI Rust sidecar

Compile the Rust sidecar to WASI and run it from Go using the
[`wasmtime-go`](https://github.com/bytecodealliance/wasmtime-go) bindings. This
provides strong sandboxing and deterministic execution without a separate process,
at the cost of WASM-specific build tooling and limited OS API access.
