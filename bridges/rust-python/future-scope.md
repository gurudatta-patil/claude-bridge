# Future Scope — Rust→Python Bridge

## 1. Tokio async client

Replace `std::thread` + `std::sync::mpsc` with Tokio tasks and
`tokio::sync::oneshot` channels.  The reader becomes a `tokio::spawn` task
reading from a `tokio::process::ChildStdout`; each `call()` becomes an
`async fn` that `.await`s on the oneshot receiver.  This removes the blocking
reader thread and integrates naturally into async Rust applications.

```toml
[dependencies]
tokio = { version = "1", features = ["full"] }
tokio-util = { version = "0.7", features = ["codec"] }  # LinesCodec
```

## 2. PyO3 as zero-IPC alternative

[PyO3](https://pyo3.rs) embeds the CPython interpreter directly into the Rust
binary.  Method calls become direct FFI calls with no process spawning, no
pipe overhead, and no serialisation cost for types that map cleanly between
Rust and Python (integers, strings, bytes, dicts).

Trade-offs vs stdio bridge:
- No process isolation: a Python crash takes down the Rust process.
- Linking complexity: must match the exact CPython version at build time.
- GIL contention: all Python code runs under the GIL.
- Advantage: latency is sub-microsecond vs sub-millisecond for stdio.

Best suited for hot-path integrations where isolation is less critical.

## 3. Shared memory transport

For high-throughput data (audio buffers, tensors, large byte arrays), replace
JSON-over-stdio with a shared-memory ring buffer:

- Rust side: [`shared_memory`](https://crates.io/crates/shared_memory) or
  `memmap2` to create a named shared-memory segment.
- Python side: `mmap` module or `numpy` with a shared backing store.
- Keep stdio only for control messages (ready signal, method dispatch).
- The payload is a handle (offset + length) rather than serialised data.

This can reduce latency by 10–100× for large payloads.

## 4. Length-prefixed binary framing

Replace newline-delimited JSON with a 4-byte little-endian length prefix
followed by MessagePack or CBOR.  Benefits:
- Binary payloads without Base64 overhead.
- Faster (de)serialisation for numeric arrays.
- No need to escape newlines in string values.

Crates: [`rmp-serde`](https://crates.io/crates/rmp-serde) (Rust),
`msgpack` (Python).

## 5. Multiplexed transport over a Unix socket

For multiple concurrent callers, stdio serialises all writes through a single
file descriptor.  A Unix domain socket with length-prefixed framing allows
true concurrent writes from multiple Rust threads without a Mutex around the
write path.

## 6. Health-check and auto-restart

Add a background Rust thread that sends a `ping` every N seconds.  If the
sidecar does not respond within a deadline, kill it and restart.  Expose the
bridge behind a `RwLock`-guarded `Option<PythonBridge>` so callers
transparently retry after a restart.

## 7. Structured logging with `tracing`

Replace `eprintln!` in the reader thread with
[`tracing`](https://crates.io/crates/tracing) spans and events.  The sidecar's
stderr can be captured and re-emitted as structured log records by spawning a
thread that reads `child.stderr` and parses JSON log lines (e.g., `structlog`
on the Python side).

## 8. Cross-platform packaging

Bundle the Python sidecar as a frozen executable using PyInstaller or
[Nuitka](https://nuitka.net/) to eliminate the Python runtime dependency.
The Rust side then spawns a single self-contained binary with no venv path
resolution needed.

## 9. gRPC / Cap'n Proto for typed contracts

Define the API in a `.proto` or `.capnp` schema.  Generate Rust stubs with
`tonic` and Python stubs with `grpcio`.  Benefits: strong typing, generated
documentation, easy versioning.  The stdio transport can be replaced by a
loopback TCP or Unix-socket gRPC channel.

## 10. WASI / WASM sidecar

Compile the Python sidecar to WebAssembly via
[Pyodide](https://pyodide.org/) or [wasm-pack](https://rustwasm.github.io/).
Run it in a WASM sandbox from Rust using
[Wasmtime](https://wasmtime.dev/).  Provides strong isolation, deterministic
execution, and portability without requiring a Python installation on the host.
