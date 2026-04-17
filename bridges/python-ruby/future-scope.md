# Future Scope: Python → Ruby Bridge

Ideas and enhancements considered out-of-scope for the initial implementation
but worth tracking for future iterations.

---

## 1. Streaming / server-sent-event style responses

Currently every call is a single request → single response pair.  A natural
extension is **streaming results**: the sidecar emits multiple partial
response lines for a single request ID, terminated by a final `{"id":"...","done":true}`.

```jsonc
// sidecar emits:
{"id":"abc","chunk":"Hello"}
{"id":"abc","chunk":" world"}
{"id":"abc","done":true}
```

The Python client would expose an iterator or async generator:

```python
for chunk in bridge.stream("generate_text", {"prompt": "..."}):
    print(chunk, end="", flush=True)
```

---

## 2. Async / `asyncio` client variant

Replace `threading.Event` / `queue.Queue` with `asyncio.Future` and drive the
reader loop with `asyncio.StreamReader` for better integration with async
Python applications (FastAPI, Starlette, etc.).

```python
async with AsyncRubyBridge(["ruby", "sidecar.rb"]) as bridge:
    result = await bridge.call("add", {"a": 1, "b": 2})
```

---

## 3. Connection pooling / multi-process sidecar pool

For high-throughput workloads, spawn N Ruby processes and round-robin or
least-loaded dispatch calls across them.  Useful when the Ruby sidecar is CPU-
bound and the GIL is not a bottleneck on the Python side.

```python
pool = RubyBridgePool(cmd=["ruby", "sidecar.rb"], size=4)
result = pool.call("heavy_computation", {"input": data})
```

---

## 4. Automatic sidecar restart on crash

If the Ruby process exits unexpectedly, detect it in the reader thread (EOF)
and transparently respawn it, then retry in-flight calls.  Expose a
`max_restarts` and `restart_delay` option.

---

## 5. Schema / type validation layer

Add an optional declarative schema for method signatures so that both Python
and Ruby can validate params/results at the boundary:

```python
bridge.register_schema("add", params={"a": int, "b": int}, result=int)
```

On the Ruby side, a corresponding DSL:

```ruby
schema :add, params: { a: Integer, b: Integer }, result: Integer
```

---

## 6. Binary / MessagePack transport

Replace newline-delimited JSON with length-prefixed MessagePack frames for
lower serialisation overhead and native support for binary data (avoiding
Base64 round-trips for blobs).

```
[4-byte LE length][msgpack bytes]\n
```

Backwards-compatible: negotiate the codec via the `{"ready":true}` line:

```json
{"ready": true, "codec": "msgpack"}
```

---

## 7. Bundler integration helper

A `RubyBridge.from_gemfile(gemfile_path, script)` factory that:

1. Runs `bundle install --quiet` in a temp dir.
2. Sets `BUNDLE_GEMFILE` env var.
3. Spawns with `bundle exec ruby script`.
4. Reports friendly errors if Bundler is not installed.

---

## 8. Distributed tracing / OpenTelemetry

Propagate W3C `traceparent` headers inside the JSON-RPC `meta` field so that
calls across the Python↔Ruby boundary appear as child spans in Jaeger, Zipkin,
or OTLP-compatible backends.

```jsonc
{"id":"...","method":"add","params":{"a":1,"b":2},
 "meta":{"traceparent":"00-abc123-def456-01"}}
```

---

## 9. Health-check / heartbeat protocol

Add an optional periodic `ping` / `pong` exchange so the Python side can
detect a hung (but not dead) Ruby process before a real call times out:

```jsonc
// Python sends every N seconds:
{"id":"ping-uuid","method":"__ping__","params":{}}
// Ruby responds:
{"id":"ping-uuid","result":"pong"}
```

---

## 10. Windows named-pipe transport

Replace stdio with Windows named pipes (`\\.\pipe\ghost-bridge-<pid>`) for
better security isolation and compatibility with Windows services that
redirect stdio.

---

## 11. Ruby → Python reverse bridge

The symmetric complement: a Ruby client spawning a Python sidecar, following
the same JSON-RPC protocol.  Useful for Ruby-primary applications that need
to call into Python ML/data-science libraries.

---

## 12. Structured logging / debug mode

A `debug=True` constructor flag that emits structured JSON logs of every
request and response to `sys.stderr`, making it easy to replay or inspect
traffic:

```json
{"ts":"2026-04-17T10:00:00Z","dir":"→","id":"abc","method":"add","params":{"a":1,"b":2}}
{"ts":"2026-04-17T10:00:00Z","dir":"←","id":"abc","result":3,"latency_ms":1.2}
```
