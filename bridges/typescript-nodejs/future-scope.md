# Future Scope - TypeScript → Node.js Bridge

A TypeScript → Node.js bridge is useful when you need to isolate a Node.js
subprocess for a specific capability — for example, running a different Node
version, a legacy CommonJS-only package, a security-sandboxed subprocess, or a
CPU-intensive workload that would block the parent's event loop.

---

## 1. Isolation via separate Node.js version or runtime

Use a child Node.js process pinned to a specific version (via `nvm`, `volta`,
or a full path like `/usr/local/bin/node18`) to access APIs that are
incompatible with the parent runtime:

```typescript
const bridge = new NodeBridge("/home/user/.nvm/versions/node/v18.20.0/bin/node", "sidecar.js");
```

Useful for packages that require a specific engine version (e.g. `node >= 18`
for native `fetch`, or `node < 16` for a legacy CJS package with no ESM build).

---

## 2. Worker-thread pool as an upgrade path

For pure CPU work (image processing, crypto, parsing), the child process can
internally use `node:worker_threads` and distribute incoming requests across
a thread pool, while the parent TypeScript process sees a single stdio JSON-RPC
interface:

```js
// sidecar.js — distributes work across worker threads
import { Worker, isMainThread, workerData, parentPort } from 'node:worker_threads';
```

The TypeScript client is unchanged; the sidecar handles concurrency internally.

---

## 3. TypeScript sidecar with `tsx` (zero build step)

Run a TypeScript sidecar directly using [`tsx`](https://github.com/privatenumber/tsx):

```typescript
const bridge = new NodeBridge("npx", ["tsx", "sidecar.ts"]);
// or with tsx globally installed:
const bridge = new NodeBridge("tsx", ["sidecar.ts"]);
```

This enables full type safety in the child process without a compilation step,
making it easy to share `interface` definitions between parent and child.

---

## 4. Sandboxing via `--experimental-permission` (Node 20+)

Node.js 20 introduced a Permission Model (`--experimental-permission`) that
restricts filesystem access, network access, and child process spawning:

```typescript
const bridge = new NodeBridge("node", [
  "--experimental-permission",
  "--allow-fs-read=/tmp/sandbox",
  "--allow-fs-write=/tmp/sandbox",
  "sidecar.js"
]);
```

This limits the blast radius of a compromised npm dependency in the child
process without requiring Docker or a full VM.

---

## 5. Streaming via async generators

For LLM token streaming, file chunking, or progress events, add a `stream`
flag to the protocol:

```typescript
for await (const chunk of bridge.stream("generateText", { prompt })) {
  process.stdout.write(chunk.token);
}
```

The sidecar emits multiple `{"id":"...","chunk":{...}}` lines followed by a
terminal `{"id":"...","result":{}}`, and the client exposes an `AsyncIterable`.

---

## 6. Shared `node_modules` via workspace symlinks

When the parent and child are in the same npm workspace, the child sidecar can
be started with `--require ./path/to/register.js` pointing at the workspace's
shared `node_modules`, avoiding redundant installs.

---

## 7. Auto-restart with exponential back-off

Wrap the bridge startup in a supervisor loop that detects `exit` events and
re-spawns with increasing delays (100 ms → 200 ms → 400 ms → cap at 30 s).
In-flight calls whose `id` is known are retried automatically for idempotent
methods; non-idempotent calls are failed immediately.

---

## 8. Unix-domain socket transport for high concurrency

For high message rates, replace stdio with a Unix domain socket so multiple
TypeScript call-sites can write to the child concurrently without serialising
through a single `stdin` pipe:

```typescript
// child binds a Unix socket; parent connects N times
const sock = net.createConnection(socketPath);
```

The JSON-RPC framing and UUID correlation are unchanged; only the transport
layer is replaced.
