# Future Scope — TypeScript → Rust Bridge

## 1. Async Rust with Tokio

The current sidecar uses synchronous blocking I/O (`stdin.lock().lines()`),
which is sufficient for CPU-bound or short-lived handlers but blocks the single
OS thread while sleeping or awaiting external I/O.  Replacing it with
`tokio::io::AsyncBufReadExt` and an async main runtime allows the sidecar to
handle multiple outstanding requests concurrently without spawning extra threads:

```rust
#[tokio::main]
async fn main() {
    let stdin = tokio::io::stdin();
    let mut reader = tokio::io::BufReader::new(stdin).lines();
    while let Some(line) = reader.next_line().await.unwrap() {
        tokio::spawn(async move { /* handle line */ });
    }
}
```

This pairs naturally with connection-pool use-cases where a single sidecar
instance services many concurrent Node workers.

## 2. Shared Memory via `memmap2` for Zero-Copy Large Data

For payloads exceeding ~100 KB (images, embeddings, large buffers), JSON
serialisation over stdio becomes a bottleneck.  The `memmap2` crate allows both
the Node parent and the Rust child to map the same anonymous or file-backed
memory region.  The JSON-RPC message then only carries the shared-memory
descriptor (file path or OS-level handle), not the data itself, achieving
near-zero copy overhead for large transfers.

## 3. Type Sharing: Rust Structs → TypeScript Interfaces via `ts-rs`

The `ts-rs` crate (<https://github.com/Aleph-Alpha/ts-rs>) derives TypeScript
interface definitions directly from Rust structs annotated with `#[derive(TS)]`.
Integrating this into the build step generates `.d.ts` files that can be
imported by the TypeScript client, giving end-to-end type safety without
manually keeping two type definitions in sync:

```rust
#[derive(Serialize, Deserialize, TS)]
#[ts(export)]
struct EchoParams { text: String }
```

Produces `EchoParams.ts` which can be used in the client for fully typed
`call("echo", params: EchoParams)` invocations.

## 4. WASM Compilation as an Alternative to Binary Spawn

Rust code can be compiled to WebAssembly and executed inside the Node.js
process via the `@wasmer/wasi` or native `node:wasm` APIs.  This eliminates the
spawn overhead entirely and removes platform/architecture concerns.  Trade-offs:

- WASM does not have native thread support (WASI threads are experimental).
- Some system APIs (sockets, mmap) are unavailable or sandboxed.
- Start-up time for a WASM module is typically 1–10 ms — comparable to a
  native binary, but without the cross-compilation complexity.

Useful for pure-compute kernels (hashing, compression, parsing) that do not
need OS access.

## 5. Process Pool with Multiple Rust Workers

A single-process sidecar serialises all requests.  For CPU-intensive workloads,
the TypeScript client can spawn a pool of `N` Rust worker processes and
distribute calls with a round-robin or least-busy scheduler:

```
Node parent ──┬──► worker-0 stdin/stdout
              ├──► worker-1 stdin/stdout
              └──► worker-N stdin/stdout
```

Each worker is an identical binary; the pool manager in TypeScript handles
routing, back-pressure, and health-checking (restarting workers that crash).
This approach gets full multi-core parallelism without requiring async Rust
inside the sidecar itself.
