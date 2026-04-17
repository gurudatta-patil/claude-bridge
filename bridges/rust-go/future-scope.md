# Future Scope — Rust → Go Bridge

Ideas and directions for evolving the Stitch Rust-to-Go implementation
beyond its current JSON-RPC-over-stdio baseline.

---

## 1. Shared Memory (mmap) IPC

The current design serialises every call to JSON and ships bytes through an OS
pipe.  For latency-sensitive or high-throughput workloads a shared-memory
channel can reduce copies dramatically.

### Concept

Both Rust and Go have mature mmap primitives:

- **Rust:** `memmap2` crate (`MmapMut`) — safe, cross-platform.
- **Go:** `golang.org/x/sys/unix.Mmap` or `syscall.Mmap` on Linux/macOS;
  `CreateFileMapping` / `MapViewOfFile` on Windows.

A possible design:

```
┌──────────────────────────────────────────────┐
│  Rust process                                │
│  ┌─────────────┐     mmap region             │
│  │  caller     │ ──► [header|request bytes]  │
│  └─────────────┘                             │
│        ▲            futex / eventfd signal   │
│        │ ◄──────────[header|response bytes]  │
└──────────────────────────────────────────────┘
         shared file or anonymous mapping
         ▲
┌────────┴────────────────────────────────────┐
│  Go process                                 │
│  reads request → dispatches → writes result │
└─────────────────────────────────────────────┘
```

Synchronisation options:
- **POSIX semaphores / futex** — lowest latency, Linux-only.
- **Named pipe / eventfd** — still a syscall but zero copy for the payload.
- **Busy-poll ring buffer** (LMAX Disruptor style) — sub-microsecond, burns a
  CPU core.

**Trade-offs:** mmap IPC is far more complex to implement correctly (memory
ordering, crash safety, cache coherency on ARM) and only pays off when
serialisation dominates (payloads > ~10 KB at > ~10 000 calls/s).  Benchmark
before committing.

---

## 2. Compare with CGo as an Alternative

Before choosing Stitch, it is worth understanding where CGo fits:

| Dimension | Stitch (stdio) | CGo |
|---|---|---|
| Language boundary | Process boundary | In-process function call |
| Overhead per call | ~0.2 ms (JSON + pipe) | ~100 ns (CGo call overhead) |
| Type safety | JSON schema (runtime) | C ABI (compile-time) |
| Crash isolation | Full — Go panic cannot kill Rust | None — Go panic kills the whole process |
| Memory sharing | Explicit (mmap or copy) | Direct pointer passing |
| Build complexity | Two separate binaries | Single binary, `cgo` toolchain required |
| Cross-compilation | Easy for both | Hard — needs a C cross-compiler |
| Windows support | Full | Requires MinGW/MSVC |
| Deployment | Two files | One file |

**When to prefer CGo:**
- You need sub-millisecond call latency AND you can tolerate the crash coupling.
- You have an existing C-compatible Go library (`export "C"` annotation).

**When to prefer Stitch:**
- Crash isolation is a hard requirement.
- You want independent deployability and upgrades of the sidecar.
- You need to run the sidecar on a different machine or in a container.
- You are targeting platforms where CGo is not available (e.g., WebAssembly).

---

## 3. Async / Non-Blocking Rust Client

The current `GoBridge` uses a blocking `SyncSender` and spawns one OS thread
per bridge instance.  A Tokio-based async variant would allow:

- Multiplexing thousands of in-flight requests over a single sidecar with
  `tokio::sync::oneshot`.
- Integrating naturally with async MCP server frameworks.
- Back-pressure via `tokio::sync::Semaphore` to cap concurrent in-flight calls.

Sketch:

```rust
use tokio::{io::{AsyncBufReadExt, AsyncWriteExt}, process::Command};
use tokio::sync::oneshot;

struct AsyncBridge {
    stdin: tokio::process::ChildStdin,
    pending: Arc<Mutex<HashMap<String, oneshot::Sender<RpcResponse>>>>,
}
```

The reader loop becomes a `tokio::spawn`-ed task reading lines with
`AsyncBufReadExt::lines()`.

---

## 4. Bidirectional / Server-Push Notifications

The current protocol is strictly request/response.  Future work could add a
`notify` message type (no `id` field, no response expected) so the Go sidecar
can push events to Rust:

```json
{"method": "on_event", "params": {"type": "heartbeat", "ts": 1713312000}}
```

The Rust reader thread would route messages without an `id` to a registered
callback or a `tokio::sync::broadcast` channel.

---

## 5. Protocol Buffer / MessagePack Alternative

Replacing JSON with a binary encoding reduces serialisation CPU and payload
size:

- **MessagePack:** `rmp-serde` (Rust) + `vmihailenco/msgpack` (Go).  Drop-in
  replacement for most use-cases; ~2× smaller payloads, ~3× faster encode.
- **Protocol Buffers:** `prost` (Rust) + `google.golang.org/protobuf` (Go).
  Requires a schema; strong versioning story.
- **Cap'n Proto / FlatBuffers:** zero-copy deserialisation; attractive for the
  mmap path described in section 1.

Changing the encoding requires updating the framing layer (length-prefixed
instead of newline-delimited for binary formats).

---

## 6. Health-Check and Auto-Restart

For daemon-style deployments, the bridge could:

1. Send a periodic `{"id":"hb-<n>","method":"ping","params":null}` every N
   seconds.
2. If no response arrives within a timeout, kill the child and respawn it.
3. Re-play any in-flight requests against the new child (requires idempotency
   guarantees from the Go side).

This turns a one-shot sidecar into a supervised subprocess, similar to how
Erlang/OTP supervises workers.

---

## 7. Multi-Sidecar Load Balancing

A `BridgePool` could maintain N Go sidecar instances and round-robin or
least-connections-route calls across them, providing horizontal throughput
scaling without changing the protocol:

```rust
struct BridgePool {
    bridges: Vec<Arc<Mutex<GoBridge>>>,
    next: AtomicUsize,
}
```

Each sidecar is single-threaded on the Go side (sequential dispatch), so
`GOMAXPROCS=1` should be set to avoid scheduler overhead when running many
sidecar instances.

---

## 8. Structured Logging and Tracing

Add OpenTelemetry trace context propagation through the JSON-RPC layer:

```json
{
  "id": "...",
  "method": "add",
  "params": {...},
  "traceparent": "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"
}
```

Both `tracing` (Rust) and `go.opentelemetry.io/otel` (Go) can consume and
propagate W3C trace context, enabling end-to-end distributed tracing across
the process boundary.
