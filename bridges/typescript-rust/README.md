# Stitch — TypeScript → Rust

Newline-delimited JSON-RPC over stdio between a TypeScript/Node.js parent and a
compiled Rust binary sidecar.

---

## Prerequisites

| Tool | Minimum version | Install |
|------|----------------|---------|
| Node.js | 18 LTS | <https://nodejs.org> |
| Rust / Cargo | 1.75 | `curl -sSf https://sh.rustup.rs | sh` |
| Vitest | 1.x | `npm install -D vitest` (in repo root) |

---

## Quick Start

### 1. Copy the template sidecar

```sh
cp -r bridges/typescript-rust/template.sidecar \
      .stitch/rust/my_bridge
```

Edit `.stitch/rust/my_bridge/Cargo.toml` — replace every occurrence of
`bridge_name` with `my_bridge`.

Add your methods in `src/main.rs` where the `[CLAUDE_*]` comments indicate.

### 2. Build the Rust binary

```sh
cd .stitch/rust/my_bridge
cargo build --release
# Binary: target/release/my_bridge  (target/release/my_bridge.exe on Windows)
```

### 3. Use the TypeScript client

```ts
import { RustBridgeClient } from
  "./bridges/typescript-rust/template.client";

const client = new RustBridgeClient("my_bridge");
await client.start();

const result = await client.call("echo", { text: "hello" });
console.log(result); // { text: "hello" }

await client.stop();
```

The client resolves the binary path automatically:

```
<repo-root>/.stitch/rust/<bridge>/target/release/<bridge>[.exe]
```

### 4. Run the integration tests

```sh
# Build the test sidecar first
cd bridges/typescript-rust/tests/test-child
cargo build --release
cd ../..

# Then run the Vitest suite
npx vitest run bridges/typescript-rust/tests/ts-rust.test.ts
```

The test suite builds the binary via `execSync` in `beforeAll`, so the manual
build step above is only needed if you want to iterate on the Rust code without
running the full test lifecycle.

---

## File List

```
bridges/typescript-rust/
├── template.sidecar/
│   ├── Cargo.toml            Cargo manifest template (rename bridge_name)
│   └── src/
│       └── main.rs           Rust sidecar template with [CLAUDE_*] markers
├── template.client.ts        TypeScript client — spawn + JSON-RPC
├── tests/
│   ├── test-child/
│   │   ├── Cargo.toml        Test sidecar manifest
│   │   └── src/
│   │       └── main.rs       Implements echo, add, raise_error, echo_b64, slow
│   └── ts-rust.test.ts       Vitest integration tests
├── edge-cases.md             Rust-specific gotchas
├── future-scope.md           Planned enhancements
└── README.md                 This file
```

---

## Protocol Summary

All messages are newline-delimited JSON on stdin/stdout.

```
Parent → Child   {"id":"<uuid>","method":"name","params":{...}}\n
Child  → Parent  {"id":"<uuid>","result":{...}}\n          # success
Child  → Parent  {"id":"<uuid>","error":{"message":"...","traceback":"..."}}\n
```

The child writes `{"ready":true}` as its **first** stdout line before entering
the request loop.  The child exits when stdin reaches EOF (parent died).

---

## Key Design Decisions

- **BufWriter + explicit flush** — every `writeln!` to stdout is immediately
  followed by `out.flush()`.  Forgetting this causes Node to hang waiting for
  data that is sitting in Rust's internal buffer.
- **`ctrlc` crate** — registers a SIGTERM / Ctrl-C handler so the process exits
  cleanly rather than leaving zombie processes.
- **`randomUUID()`** — the TypeScript client uses Node's built-in
  `crypto.randomUUID()` (no extra dependency).
- **SIGTERM → SIGKILL(2 s)** — `killChild()` sends SIGTERM first, then
  schedules SIGKILL with a 2-second grace period using `.unref()` so the timer
  does not prevent the Node process from exiting.

---

## See Also

- [`edge-cases.md`](./edge-cases.md) — compile step, BufWriter flush, panic
  handling, Windows `.exe`, cross-compilation, `serde_json` number types.
- [`future-scope.md`](./future-scope.md) — async Tokio, shared memory,
  `ts-rs` type sharing, WASM, process pools.
