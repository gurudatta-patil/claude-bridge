# Rust → Node.js Bridge

A Stitch IPC bridge that lets a **Rust** application call functions implemented in a **Node.js** sidecar process over newline-delimited JSON-RPC on stdin/stdout.

## What it does

The Rust client (`NodeBridge`) spawns a Node.js child process, waits for its `{"ready":true}` handshake, then routes `call(method, params)` invocations as JSON-RPC requests over the child's stdin. Responses are matched by UUID and returned to the caller. Closing stdin (or dropping the bridge) signals EOF to Node.js, which exits cleanly.

```
Rust process                       Node.js sidecar
    │                                    │
    │── spawn ──────────────────────────>│
    │<── {"ready":true}\n ───────────────│
    │── {"id":"…","method":"…","params":{…}}\n ──>│
    │<── {"id":"…","result":{…}}\n ──────│
    │── close stdin ─────────────────────│ (EOF → process.exit(0))
```

## Prerequisites

- **Rust** stable (1.65+)
- **Node.js** 18+ (works with Node 14+ but 18 is recommended)
- `node` must be on `PATH` when the Rust binary runs

## Quick start

### 1 — Copy the sidecar template

```
cp bridges/rust-nodejs/template.sidecar.js my-sidecar.js
```

Add your handlers inside the `handlers` object:

```js
const handlers = {
  __ping__: async () => ({ pong: true, pid: process.pid }),

  greet: async ({ name }) => ({ greeting: `Hello, ${name}!` }),
  // add more handlers here…
};
```

### 2 — Copy and configure the Rust client

```
cp -r bridges/rust-nodejs/template.client my-client
```

Open `my-client/src/main.rs` and replace the placeholders:

| Placeholder | Replace with |
|---|---|
| `[CLAUDE_SIDECAR_PATH]` | Path to your `.js` sidecar file |
| `[CLAUDE_METHOD]` | The method name to call, e.g. `"greet"` |
| `[CLAUDE_PARAMS]` | JSON params, e.g. `{"name":"world"}` |

Also copy the shared bridge module next to `main.rs`:

```
cp shared/rust/bridge_client.rs my-client/src/bridge_client.rs
```

### 3 — Run

```bash
cd my-client
cargo run
```

Expected output:
```
[client] Node.js sidecar ready
result: {"greeting":"Hello, world!"}
[client] done
```

## Template slots

| Marker | File | Purpose |
|---|---|---|
| `[CLAUDE_SIDECAR_PATH]` | `src/main.rs` | Path passed to `NodeBridge::spawn` |
| `[CLAUDE_METHOD]` | `src/main.rs` | Method name for the demo call |
| `[CLAUDE_PARAMS]` | `src/main.rs` | JSON params for the demo call |
| `[CLAUDE_HANDLER_STRUCTS_HERE]` | `src/main.rs` | Add Rust structs for typed params/results |
| `[CLAUDE_DISPATCH_CASES_HERE]` | `src/main.rs` | Add typed dispatch logic |
| `[CLAUDE_HANDLER_IMPLEMENTATIONS_HERE]` | `template.sidecar.js` | Add JS handler functions |

## Running the tests

```bash
cd bridges/rust-nodejs/tests/test-runner
TEST_NODE_SCRIPT=../test-child.js cargo run
```

Or as Rust integration tests:

```bash
cd bridges/rust-nodejs/tests/test-runner
TEST_NODE_SCRIPT=../test-child.js cargo test --test rust-nodejs_test 2>/dev/null
# (copy rust-nodejs_test.rs into the crate's tests/ dir first)
```

## Protocol reference

- Transport: child stdin/stdout, newline-delimited JSON
- Ready signal: `{"ready":true}` — first line the sidecar writes
- Request: `{"id":"<uuidv4>","method":"<name>","params":{…}}`
- Success: `{"id":"<same>","result":{…}}`
- Error: `{"id":"<same>","error":{"code":<int>,"message":"<str>"}}`
- Shutdown: Rust closes stdin → Node.js `readline` emits `close` → `process.exit(0)`
