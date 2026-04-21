# Future Scope - Python → Node.js Bridge

A Python → Node.js bridge lets Python applications access the npm ecosystem —
particularly packages with no Python equivalent: Puppeteer for headless Chrome,
sharp for libvips image processing, `@xenova/transformers` for ONNX inference,
or any Node.js-native library.

---

## 1. High-value npm targets from Python

The primary motivation is reaching npm packages that have no Python equivalent
or that have significantly better implementations on the Node side:

- **PDF generation** — `pdfkit`, `puppeteer`, `@react-pdf/renderer`
- **Image processing** — `sharp` (libvips bindings, ~5× faster than Pillow for resizing)
- **Rich text / DOCX** — `docx`, `officegen`
- **Headless browser** — `playwright`, `puppeteer` (screenshot, PDF, scraping)
- **ML inference** — `@xenova/transformers` (ONNX Runtime in Node, WASM-ready)
- **Data validation** — `zod`, `ajv`
- **Cryptography** — `node-forge`, `jose` (JWT/JWE)

The sidecar pattern keeps npm dependencies entirely on the Node side; the Python
binary has zero npm footprint.

---

## 2. `asyncio` Python client variant

Replace `threading.Event` + `queue.Queue` with `asyncio` primitives for
better integration with async Python frameworks (FastAPI, Starlette, aiohttp):

```python
async with AsyncNodeBridge(["node", "sidecar.js"]) as bridge:
    result = await bridge.call("generatePdf", {"html": html})
```

The reader loop becomes an `asyncio.StreamReader` coroutine; pending calls are
keyed to `asyncio.Future` objects rather than `threading.Event`.

---

## 3. TypeScript sidecar with `tsx` (no build step)

Run a TypeScript sidecar from Python using `tsx`:

```python
bridge = NodeBridge(["npx", "tsx", "sidecar.ts"])
```

This gives full TypeScript type safety on the Node side without a compilation
step, and allows sharing TypeScript interfaces via `.d.ts` files inspected
at bridge-generation time.

---

## 4. Streaming results via Python generators

For workloads that produce incremental output (LLM tokens, progress events,
file chunks), expose a streaming API:

```python
for chunk in bridge.stream("generateText", {"prompt": prompt}):
    print(chunk["token"], end="", flush=True)
```

The Node sidecar emits multiple `{"id":"...","chunk":{...}}` frames followed by
a terminal `{"id":"...","result":{}}`, and the Python client yields each chunk
as a generator value.

---

## 5. Process pool for parallel Node workers

Node.js event loop is single-threaded for synchronous CPU work. A pool of N
Node.js sidecar processes handles parallel Python requests with true concurrency:

```python
pool = NodeBridgePool(cmd=["node", "sidecar.js"], size=4)
result = pool.call("heavyComputation", {"input": data})
```

The pool uses least-connections routing and restarts crashed workers transparently.

---

## 6. Bundler integration (`npm ci` auto-setup)

A `NodeBridge.from_package_json(package_json_path, script)` factory that:
1. Runs `npm ci --quiet` in the sidecar directory.
2. Sets `NODE_PATH` appropriately.
3. Spawns `node script.js` with the correct working directory.
4. Reports friendly errors if Node/npm is not installed.

---

## 7. Auto-restart with in-flight request retry

Detect `EOF` on the Node child's stdout (process crashed) and transparently
re-spawn, replaying idempotent in-flight requests:

```python
bridge = NodeBridge(cmd, auto_restart=True, max_restarts=3, restart_delay=0.1)
```

Non-idempotent calls (e.g. file write) are failed immediately; idempotent calls
(e.g. pure computation, read) are retried against the fresh sidecar.

---

## 8. Structured logging over stderr

The Node sidecar emits structured JSON to `process.stderr`:

```js
const log = (level, msg, meta = {}) =>
  process.stderr.write(JSON.stringify({ level, msg, pid: process.pid, ...meta }) + '\n');
```

The Python bridge captures `stderr` and forwards log entries to Python's
`logging` module so Node-side events appear in the parent's log stream with
correlation IDs linking them to specific `call()` invocations.

---

## 9. Health-check / heartbeat

Add a built-in `__ping__` handler to every Node sidecar. Python polls it every
N seconds; if no response arrives within the deadline, the bridge kills and
restarts the child before any real call fails:

```python
# Python sends every 30 s:
bridge.call("__ping__", {})  # Node responds: {"pong": True}
```
