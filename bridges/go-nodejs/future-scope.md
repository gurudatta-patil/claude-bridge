# Future Scope — Go → Node.js Bridge

## 1. Reuse existing npm packages in Go services

The primary motivation for this bridge is accessing the vast npm ecosystem from Go.
Some high-value targets:

- **PDF generation** — `pdfkit`, `puppeteer` (headless Chrome), `@react-pdf/renderer`
- **Rich text / DOCX** — `docx`, `officegen`
- **Image processing** — `sharp` (libvips bindings), `jimp`
- **Cryptography** — `node-forge`, `jose` (JWT/JWE)
- **Data validation** — `zod`, `ajv`
- **ML inference** — `@xenova/transformers` (ONNX Runtime in Node)

The sidecar pattern keeps these dependencies entirely on the Node side; the Go binary
stays free of cgo and native build requirements.

## 2. TypeScript sidecar with tsx

[`tsx`](https://github.com/privatenumber/tsx) is a zero-config TypeScript runner that
requires no compilation step:

```bash
npx tsx sidecar.ts
```

From Go, simply change the command:

```go
cmd := exec.Command("npx", "tsx", "sidecar.ts")
// or if tsx is globally installed:
cmd := exec.Command("tsx", "sidecar.ts")
```

This enables full type safety on the Node side including typed request/response
interfaces, without adding a build step to the deployment pipeline.

**Template skeleton (`sidecar.ts`):**
```typescript
import readline from 'node:readline';

interface RpcRequest {
  id: string;
  method: string;
  params: Record<string, unknown>;
}

interface RpcResponse {
  id: string;
  result?: unknown;
  error?: { code: number; message: string };
}

const handlers: Record<string, (p: Record<string, unknown>) => Promise<unknown>> = {
  echo: async (p) => p,
};

const rl = readline.createInterface({ input: process.stdin });
process.stdout.write(JSON.stringify({ ready: true }) + '\n');

rl.on('line', async (line) => {
  const req = JSON.parse(line.trim()) as RpcRequest;
  // ... dispatch
});
rl.on('close', () => process.exit(0));
```

## 3. Streaming results via async generators

For methods that produce large or incremental output (e.g. LLM token streaming,
file chunking), the current request/response model requires buffering the entire
result before sending it. A streaming extension could use a custom wire format:

```json
{"id": "abc", "chunk": <partial_data>, "seq": 0}
{"id": "abc", "chunk": <partial_data>, "seq": 1}
{"id": "abc", "done": true, "seq": 2}
```

On the Node side this maps naturally to an `async function*` generator:

```js
async function* streamHandler(params) {
  for await (const token of llmStream(params.prompt)) {
    yield token;
  }
}
```

The Go client would expose a `Stream(method, params) (<-chan Chunk, error)` API,
reading lines from a separate goroutine and forwarding them to the channel.

## 4. Connection pooling / multiple Node workers

For CPU-intensive Node work (e.g. synchronous crypto, canvas rendering), a single
Node process becomes a bottleneck because the event loop is single-threaded. Options:

- **Worker threads** — use `node:worker_threads` inside the sidecar; Go sees one
  process but Node distributes work internally.
- **Process pool** — the Go side spawns N sidecar processes and load-balances
  `Call()` invocations across them using a round-robin or least-outstanding-requests
  strategy.
- **Cluster module** — rarely useful for IPC; worker_threads is preferred.

## 5. Health-check / heartbeat protocol

Add an optional `ping` method to every sidecar:

```js
ping: async () => ({ pong: true, pid: process.pid, uptime: process.uptime() }),
```

The Go side can call `bridge.Call("ping", nil)` on a ticker to detect a hung event
loop (e.g. an infinite `while(true)` accidentally introduced) and restart the child.

## 6. Structured logging via stderr

Node writes to `process.stderr` which the Go bridge already redirects to `os.Stderr`.
For structured logs, emit JSON on stderr:

```js
const log = (level, msg, extra = {}) =>
  process.stderr.write(JSON.stringify({ level, msg, pid: process.pid, ...extra }) + '\n');
```

The Go side can wrap `cmd.Stderr` with a custom `io.Writer` that parses these JSON
lines and forwards them to the Go logger.

## 7. Auto-restart on crash

Wrap `NewNodeBridge` in a supervisor goroutine that calls `cmd.Wait()`, detects a
non-zero exit code, and re-spawns the child with exponential back-off. In-flight
requests should be retried (idempotent methods) or failed fast (non-idempotent).

## 8. Security: sandboxing the Node child

On Linux, use `seccomp` or `landlock` (via Go's `syscall.SysProcAttr`) to restrict
the syscalls available to the Node child. On macOS, use the `sandbox-exec` wrapper.
This limits the blast radius if an npm dependency has a supply-chain vulnerability.
