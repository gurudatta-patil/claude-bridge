# Future Scope - Rust → Node.js Bridge

A Rust → Node.js bridge lets Rust applications delegate to the npm ecosystem
for capabilities that have no native Rust equivalent or where an existing
Node.js library is the de-facto standard: Puppeteer/Playwright for headless
browsers, `sharp` for image processing, `docx`/`pdfkit` for document generation,
or `@xenova/transformers` for ONNX-runtime inference.

---

## 1. High-value npm targets from Rust

Packages where the Node.js implementation is the industry standard with no
comparable Rust crate:

- **Headless browser** — `puppeteer`, `playwright` (screenshot, PDF, DOM automation)
- **Image processing** — `sharp` (libvips; faster than most Rust alternatives for
  common resize/crop operations without unsafe C bindings)
- **PDF generation** — `pdfkit`, `@react-pdf/renderer`
- **Office documents** — `docx`, `officegen`
- **ML inference** — `@xenova/transformers` (ONNX Runtime in Node via WASM)
- **Cryptography / JWT** — `jose`, `node-forge`
- **Data validation** — `zod`, `ajv`

---

## 2. Tokio async Rust client

Replace `std::thread` + `std::sync::mpsc` with Tokio tasks for zero-overhead
async integration with Rust async runtimes:

```rust
use tokio::sync::oneshot;

struct AsyncNodeBridge {
    stdin: tokio::process::ChildStdin,
    pending: Arc<Mutex<HashMap<String, oneshot::Sender<RpcResponse>>>>,
}

impl AsyncNodeBridge {
    pub async fn call(&self, method: &str, params: serde_json::Value)
        -> Result<serde_json::Value, BridgeError> { ... }
}
```

The reader loop becomes a `tokio::spawn`-ed task reading `ChildStdout` via
`AsyncBufReadExt::lines()`.

---

## 3. TypeScript sidecar with `tsx` (no compilation step)

From Rust, spawn a TypeScript sidecar directly:

```rust
let cmd = Command::new("npx").args(["tsx", "sidecar.ts"]);
// or with tsx globally installed:
let cmd = Command::new("tsx").arg("sidecar.ts");
```

This gives type safety on the Node side without a build step, and allows
sharing Rust-generated `.d.ts` type definitions (via `ts-rs`) with the sidecar.

---

## 4. Shared memory (`memmap2 + mmap`) for large payloads

For payloads exceeding ~1 MB (image frames, tensors, audio buffers), bypass
stdio and use a memory-mapped file:

1. Rust writes data to a temp file and maps it with `memmap2::MmapMut`.
2. JSON-RPC message carries only the file path and byte length.
3. Node sidecar reads the data with `fs.readFileSync` or maps it with `mmap-io`.
4. Result is written back to a second mapped file; Rust reads it.

Eliminates Base64 overhead (~33% size penalty) and serialisation CPU cost.

---

## 5. Sandboxed Node child with `--experimental-permission` (Node 20+)

Restrict the child process's filesystem and network access to limit the blast
radius of a compromised npm dependency:

```rust
let cmd = Command::new("node")
    .args([
        "--experimental-permission",
        "--allow-fs-read=/tmp/sandbox",
        "--allow-fs-write=/tmp/sandbox",
        "sidecar.js",
    ]);
```

No Docker / container runtime required; the restriction is enforced by the
Node.js runtime itself.

---

## 6. Streaming / server-push via async iterator

For incremental results (LLM token streaming, progress events):

```rust
// Rust caller:
let mut stream = bridge.stream("generateText", json!({"prompt": prompt})).await?;
while let Some(chunk) = stream.next().await {
    print!("{}", chunk["token"].as_str().unwrap_or(""));
}
```

The Node sidecar emits multiple `{"id":"...","chunk":{...}}` frames; Rust
delivers them through a `tokio::sync::mpsc::Receiver<serde_json::Value>`.

---

## 7. `ts-rs`-driven type sharing (Rust → TypeScript)

Derive TypeScript types from Rust request/response structs:

```rust
#[derive(Serialize, Deserialize, TS)]
#[ts(export)]
pub struct GenerateParams { pub prompt: String, pub max_tokens: u32 }
```

The exported `.ts` file is imported by the Node sidecar, giving end-to-end type
safety without manually keeping Rust and TypeScript interfaces in sync.

---

## 8. Process pool for multi-core throughput

Node's event loop is single-threaded. For CPU-bound work, spawn N Node workers
and distribute requests with round-robin or least-connections routing:

```rust
let pool = NodeBridgePool::new(binary, n_workers);
let result = pool.call("heavyTask", params).await?;
```

Each worker is an identical Node process; the pool handles health-checking and
transparent restarts of crashed workers.

---

## 9. WASM/WASI Node.js module as alternative transport

For pure-compute kernels that happen to have Node.js implementations, compile
the sidecar logic to WASI and run it from Rust via the `wasmtime` crate. This
eliminates the process spawn overhead and provides strong sandboxing, at the
cost of limited OS API access and no native `node:` module support.
