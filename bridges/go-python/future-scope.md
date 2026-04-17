# Future Scope — Go → Python Bridge

Ideas and roadmap items for the Stitch Go → Python transport.

---

## 1. Context-aware calls with timeout: `CallContext(ctx, method, params)`

The current `Call` method blocks until the Python sidecar responds with no way
for the caller to cancel mid-flight.

A `CallContext` variant would:

- Accept a `context.Context` from the caller.
- Race the `resp := <-ch` receive against `ctx.Done()`.
- On cancellation, remove the pending entry and return `ctx.Err()`.

```go
func (b *Bridge) CallContext(
    ctx context.Context,
    method string,
    params interface{},
) (json.RawMessage, error) {
    // ... register pending as usual ...
    select {
    case resp := <-ch:
        if resp.Error != nil {
            return nil, resp.Error
        }
        return resp.Result, nil
    case <-ctx.Done():
        b.mu.Lock()
        delete(b.pending, id)
        b.mu.Unlock()
        return nil, ctx.Err()
    }
}
```

Note: the Python side still executes the full call; cancellation is
Go-side only.  True server-side cancellation would require a separate
`cancel` RPC method and cooperative Python handlers.

---

## 2. Streaming responses via multiple JSON objects per call

Some workloads (token-by-token LLM output, progress events) need the server
to emit multiple partial results for a single request.

Design sketch:
- Introduce a `"stream": true` flag in the request.
- Python emits zero or more `{"id": "...", "chunk": {...}}` lines followed by
  a terminal `{"id": "...", "result": {...}}` (or error).
- The Go client delivers chunks via a `chan json.RawMessage` returned from
  `Stream(method, params)`.

This keeps newline-delimited JSON as the wire format and requires no changes
to the framing layer.

---

## 3. Connection pooling: multiple Python workers, round-robin dispatch

A single Python process is single-threaded for CPU-bound work (GIL).  For
throughput-sensitive applications, spawn N sidecars and distribute calls
across them:

```
Pool
 ├── worker[0] — Bridge instance
 ├── worker[1] — Bridge instance
 └── worker[N] — Bridge instance
```

The pool's `Call` method picks the next worker using an atomic counter
(`sync/atomic`) for lock-free round-robin, or a weighted scheme based on
in-flight call count.

Failure handling: if a worker dies, the pool respawns it transparently and
routes pending calls to healthy workers.

---

## 4. Protobuf over stdio for type safety

JSON type coercion (section 3 of edge-cases.md) is a recurring source of
bugs.  Replacing JSON with Protocol Buffers would give:

- Strong typing end-to-end (no float64 surprise for integers).
- Smaller wire payloads for binary data (no base64 overhead).
- Generated code for both Go and Python via `protoc`.

Wire format change: prefix each message with a 4-byte big-endian length, then
the proto bytes, instead of newline-delimited JSON.  The framing layer in both
Go (`bufio.Reader`) and Python (`struct.unpack`) would need updating.

Trade-off: adds a build step (`protoc`) and schema management; keeps JSON for
development simplicity until payload size or type safety becomes a bottleneck.

---

## 5. Health-check / ping method

Add a lightweight built-in `_ping` method to the sidecar template that returns
`{"pong": true}`.  The Go bridge can use it to:

- Verify the child is alive before the first real call.
- Implement a periodic keep-alive to detect silent child crashes early.
- Expose a `bridge.Ping() error` convenience method for callers.

---

## 6. Structured logging with correlation IDs

Thread the request ID through the Python sidecar's log output so that errors
emitted to stderr can be correlated with the Go-side call that triggered them.

Python handler pattern:

```python
import logging
logger = logging.getLogger(__name__)

def _handle_my_method(params, *, req_id=""):
    logger.debug("[%s] my_method called", req_id)
    ...
```

The dispatcher passes `req_id` as a keyword argument when calling handlers.
