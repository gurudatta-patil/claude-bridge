# Future Scope – TypeScript → Python Bridge

Ideas that are out of scope for the v1 template but are valuable future improvements specific to this language pair.

---

## 1. Async Python Sidecar (`asyncio`)

Replace the blocking `for line in sys.stdin` loop with a fully async main loop:

```python
import asyncio, sys, json

async def main():
    loop = asyncio.get_event_loop()
    reader = asyncio.StreamReader()
    await loop.connect_read_pipe(lambda: asyncio.StreamReaderProtocol(reader), sys.stdin)

    _send({"ready": True})
    while True:
        raw = await reader.readline()
        if not raw:
            break
        msg = json.loads(raw)
        asyncio.create_task(handle(msg))   # non-blocking dispatch
```

Benefits:
- Multiple I/O-bound handlers run concurrently inside a single Python process without threads.
- `asyncio.to_thread` (Python 3.9+) offloads blocking handlers without spawning OS threads manually.
- Composes naturally with async database drivers (`asyncpg`, `motor`), HTTP clients (`aiohttp`, `httpx`), and ML inference servers.

Considerations:
- Requires Python ≥ 3.7; `asyncio.to_thread` requires 3.9.
- CPU-bound handlers still block the event loop unless dispatched via `loop.run_in_executor`.

---

## 2. Type-Sharing: Pydantic → Zod Schema Generation

Maintain a single source of truth in Python (`pydantic` models) and auto-generate matching TypeScript types:

```
handlers/models.py          →  (codegen step)  →  generated/models.ts
class AddParams(BaseModel):                         export interface AddParams {
    a: float                                            a: number;
    b: float                                            b: number;
                                                    }
```

Implementation sketch:
1. Write a small Python script that imports all Pydantic models and calls `model.model_json_schema()`.
2. Feed the JSON Schema output into `json-schema-to-zod` (npm) to produce Zod validators.
3. Run the script as a pre-build step (`package.json` `prebuild` hook).

This eliminates the manual synchronisation of types between the two languages and enables runtime validation on both sides.

---

## 3. Hot-Reload: Watch `.py` and Restart Sidecar on Change

During development, any edit to the sidecar Python file should be immediately reflected without restarting the TypeScript process:

```ts
import { watch } from "fs";

watch(scriptPath, () => {
  console.error("[PythonBridge] file changed – restarting sidecar");
  bridge.stop();
  bridge = new PythonBridge(scriptPath);
  await bridge.start();
});
```

Additional concerns:
- In-flight requests at the time of the restart must be rejected gracefully (not left dangling).
- A debounce (e.g. 300 ms) prevents multiple restarts from rapid file-save events.
- The watcher should be disabled in production builds.

---

## 4. Binary Channel via fd[3] for Large Tensor / Image Data

The JSON-RPC channel (stdio) is inefficient for large binary payloads. Add a dedicated binary pipe on file descriptor 3:

```
TypeScript parent                Python sidecar
───────────────                  ──────────────
fd 0 (stdin)   ←── JSON-RPC ───  writes JSON to fd 1
fd 1 (stdout)  ──► JSON-RPC ───  reads JSON from fd 0
fd 3 (pipe[0]) ←── binary  ───   writes raw bytes to fd 3 write-end
fd 4 (pipe[1]) ──► binary  ───   reads raw bytes from fd 4 read-end
```

RPC messages reference binary payloads by handle ID: `{"id": "...", "result": {"binaryHandle": "abc123", "length": 1048576}}`. The TypeScript side reads the binary from fd 3 using the handle as a framing marker.

Benefits:
- Eliminates Base64 overhead entirely (~33 % size reduction).
- Bypasses JSON serialisation for large arrays (numpy, PIL images, audio tensors).

Complexity: significant. Requires framing protocol on the binary channel (e.g. 4-byte length prefix), careful fd management on Windows, and synchronisation between the JSON and binary channels.

---

## 5. Process Pool for Parallel Python Workers

For CPU-bound workloads, a single Python sidecar is limited by the GIL. A pool of N worker processes each handle a subset of requests:

```
TypeScript parent
  └─ PoolManager (round-robin or work-stealing)
       ├─ PythonBridge instance 0  (python sidecar.py)
       ├─ PythonBridge instance 1  (python sidecar.py)
       └─ PythonBridge instance N  (python sidecar.py)
```

Implementation:
- `PoolManager` maintains N `PythonBridge` instances.
- `call()` routes to the least-busy bridge (track in-flight count per worker).
- On worker death, the manager restarts it and re-routes pending calls.
- Pool size defaults to `os.cpus().length - 1`; configurable.

This gives near-linear CPU scaling for independent requests and eliminates GIL contention between workers (separate processes, separate GILs).

---

## 6. Jupyter Kernel Integration

Reuse an existing IPython kernel as the sidecar rather than a bare Python script:

```ts
// Instead of spawning a raw python script, connect to a kernel:
const kernel = await KernelManager.startNew({ name: "python3" });
const result = await kernel.requestExecute({ code: "2 + 2" }).done;
```

Alternatively, implement the bridge inside a Jupyter extension so that notebook code can call TypeScript services and vice versa, with the kernel acting as the Python side of the bridge.

Use cases:
- Interactive data-science workflows where the analyst controls the Python environment from a notebook.
- Sharing kernel-level state (loaded dataframes, trained models) across multiple TypeScript callers without reloading.
- Live introspection: TypeScript can call `kernel.requestInspect` to get docs/types for Python objects at runtime.
