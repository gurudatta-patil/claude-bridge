# Future Scope — Python → Rust Bridge

## 1. `ts-rs` for Shared Type Schema Generation

[ts-rs](https://github.com/Aleph-Alpha/ts-rs) generates TypeScript type
definitions from Rust structs.  Even in a pure Python→Rust pipeline this is
useful as an intermediate schema language:

- Derive `#[derive(TS)]` on your request/response structs.
- Generate `.ts` files with `cargo test export_types`.
- Use the TypeScript definitions as the authoritative schema documentation.
- Drive Python dataclass / `TypedDict` generation with a small transpiler
  (or directly with tools like `datamodel-code-generator` on a JSON Schema
  exported from the TS types).

This gives you a single source of truth in Rust that propagates to both
the Python caller and any future TypeScript consumers.

```rust
use ts_rs::TS;

#[derive(Serialize, Deserialize, TS)]
#[ts(export)]
pub struct AddParams {
    pub a: i64,
    pub b: i64,
}
```

---

## 2. `mmap` for Large Array / Blob Transfer

For payloads larger than ~1 MB, Base64 over a pipe becomes a bottleneck
(33 % size overhead + encoding/decoding CPU cost).  A shared memory
approach using memory-mapped files can be orders of magnitude faster:

**Protocol extension:**

1. Python allocates a temp file of the required size and maps it with
   `mmap.mmap`.
2. Python writes the raw bytes into the map and sends the bridge a request
   containing only the file path + byte length.
3. Rust opens the same file with `memmap2::MmapMut`, reads the data, and
   writes the result back (or into a second mapped file).
4. Python reads the result map.

**Crates:** [`memmap2`](https://docs.rs/memmap2) (Rust),
[`mmap`](https://docs.python.org/3/library/mmap.html) (stdlib Python).

**When to use:** audio/video frames, large numerical arrays, training data
batches — anything where latency matters and the payload is bigger than a
few hundred kilobytes.

---

## 3. C FFI Integration as an Alternative Transport

If sub-millisecond latency is required and you can tolerate a more complex
build, calling Rust directly as a C-compatible dynamic library avoids all
IPC overhead:

- Expose Rust functions with `#[no_mangle] pub extern "C" fn ...`.
- Build as `crate-type = ["cdylib"]` in `Cargo.toml`.
- Call from Python with `ctypes` or `cffi`.

**Trade-offs vs stdio bridge:**

| Concern | stdio bridge | C FFI |
|---|---|---|
| Isolation | Full process isolation | Shared address space |
| Crash safety | Child crash does not kill host | Rust panic can kill Python |
| Build complexity | Low (`cargo build`) | Medium (ABI stability, header gen) |
| Latency | ~0.1–1 ms (pipe round-trip) | ~1 µs (function call) |
| Async support | Natural (threading) | Requires careful GIL management |

**Recommended tools:**
- [`cbindgen`](https://github.com/mozilla/cbindgen) — generate C headers from Rust.
- [`cffi`](https://cffi.readthedocs.io/) — call C libraries from Python with
  automatic struct layout.
- [`PyO3`](https://pyo3.rs/) — write native Python extension modules in Rust
  (higher level than raw FFI; full Python type system).

---

## 4. Async Python Client

The current `RustBridge` uses `threading.Event` for synchronisation.  A
future `AsyncRustBridge` could use `asyncio` instead:

- Replace `threading.Event` with `asyncio.Event`.
- Replace the reader daemon thread with an `asyncio` stream reader
  (`asyncio.create_subprocess_exec` + `StreamReader`).
- Expose `async def call(...)` for use with `await`.

This removes thread overhead for I/O-bound Python callers and integrates
naturally with FastAPI, aiohttp, or any async framework.

---

## 5. Schema Validation Middleware

Insert a validation layer between the Python caller and the wire:

```python
class ValidatedRustBridge(RustBridge):
    _schemas: dict[str, type]  # method -> pydantic model

    def call(self, method, params=None, **kw):
        if method in self._schemas:
            params = self._schemas[method](**params).model_dump()
        return super().call(method, params, **kw)
```

Schemas can be auto-generated from Rust structs via `ts-rs` → JSON Schema
→ Pydantic (see item 1 above), creating a fully typed end-to-end pipeline.

---

## 6. Multiplexed Connections / Connection Pooling

A single Rust process is single-threaded on the I/O loop by default.  For
very high call rates:

- Spawn multiple sidecar processes and route requests round-robin.
- Or make the Rust sidecar multithreaded: receive on one thread, dispatch
  to a `rayon` thread pool, write results back through a `Mutex<BufWriter>`.

---

## 7. Protocol Versioning and Capability Negotiation

Extend the handshake:

```json
{"ready": true, "version": "1.2.0", "methods": ["echo", "add", "echo_b64", "slow"]}
```

The Python client can inspect `methods` and raise `NotImplementedError`
early rather than getting a `-32601` at call time.  Version negotiation
allows gradual rollout of new methods without breaking existing callers.
