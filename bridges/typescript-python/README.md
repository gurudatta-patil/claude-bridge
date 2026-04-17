# Stitch: TypeScript → Python

Spawn a Python sidecar from Node.js and call it as if it were a local async function. All communication goes over newline-delimited JSON-RPC on stdio — no HTTP server, no network port, no serialisation library required on either side.

---

## When to Use This Bridge

| Scenario | Good fit? |
|---|---|
| Run a Python ML model from a TypeScript API server | Yes |
| Call numpy/scipy/pandas from Node.js | Yes |
| Use Python async libraries (aiohttp, asyncpg) from TS | Yes (with async sidecar variant) |
| Replace a Python microservice that handles < 1 req/s | Yes |
| High-frequency, sub-millisecond RPC (> 10 000 req/s) | No — use native addons or HTTP/2 |
| Transfer tensors > 10 MB per call routinely | No — use the fd[3] binary channel (future) |

---

## Quick Start

### 1. Copy the templates

```
bridges/typescript-python/
  template.sidecar.py   ← copy and fill in your handlers
  template.client.ts    ← copy and fill in your public methods
```

### 2. Fill in the Python sidecar

Replace the three slot markers in `template.sidecar.py`:

```python
# [CLAUDE_IMPORTS_HERE]
import numpy as np

# [CLAUDE_HANDLER_FUNCTIONS_HERE]
def handle_add(params: dict) -> dict:
    return {"sum": params["a"] + params["b"]}

# [CLAUDE_LOGIC_ROUTING_HERE]  (inside _dispatch)
if method == "add":
    return handle_add(params)
else:
    raise NotImplementedError(f"Unknown method: {method!r}")
```

### 3. Fill in the TypeScript client

Replace the two slot markers in `template.client.ts`:

```ts
// [CLAUDE_TYPE_DEFINITIONS_HERE]
export interface AddResult { sum: number }

// [CLAUDE_PUBLIC_METHODS_HERE]  (inside PythonBridge class)
async add(a: number, b: number): Promise<AddResult> {
  return this.call<AddResult>("add", { a, b });
}
```

### 4. Use it

```ts
import { PythonBridge } from "./template.client";
import * as path from "path";

const bridge = new PythonBridge(
  path.resolve(__dirname, "my_sidecar.py"),
);
await bridge.start();

const result = await bridge.add(3, 4);
console.log(result.sum); // 7

await bridge.stop();
```

---

## Files in This Package

| File | Purpose |
|---|---|
| `template.sidecar.py` | Production-ready Python sidecar template with stdout discipline, watchdog, ready signal, and JSON-RPC loop |
| `template.client.ts` | Production-ready TypeScript client template with chunked buffer, `randomUUID`, `killChild`, and process cleanup hooks |
| `tests/test-child.py` | Runnable test sidecar implementing `echo`, `add`, `raise_error`, `echo_b64`, and `slow` |
| `tests/ts-python.test.ts` | Vitest integration tests covering round-trip, concurrency, error propagation, EOF watchdog, and Base64 |
| `edge-cases.md` | TypeScript→Python-specific edge cases (GIL, buffering, Windows paths, startup latency, stdout contamination) |
| `future-scope.md` | Future improvement ideas (asyncio sidecar, Pydantic→Zod, hot-reload, binary channel, process pool, Jupyter) |

---

## Running the Tests

```bash
# From the repo root or the bridge directory:
npm install        # install vitest if not already present
npx vitest run bridges/typescript-python/tests/ts-python.test.ts
```

The tests automatically detect `.venv/bin/python` (or `.venv/Scripts/python.exe` on Windows) and fall back to `python3` if no venv is present.

---

## Further Reading

- [Edge cases specific to this bridge](./edge-cases.md)
- [Future improvement ideas](./future-scope.md)
- [Top-level Stitch README](../../README.md)
