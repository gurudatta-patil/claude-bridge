# Edge Cases — Rust → Node.js Bridge

## 1. JavaScript number precision (f64 / i64 coercion)

JavaScript has a single `Number` type (IEEE 754 double, 64-bit float). All JSON
numbers — integers and floats alike — are deserialized to `f64` by V8.

**Implication:** integers larger than 2⁵³ (`Number.MAX_SAFE_INTEGER = 9007199254740991`)
cannot be represented exactly as a JS `Number` and will be silently rounded.

```js
// JS side — receives 9007199254740993 but stores 9007199254740992
add: async ({ a, b }) => ({ sum: a + b }),
```

**Mitigation options:**
- Keep integer values within `±2⁵³` on both sides.
- Pass large integers as JSON strings and parse them in the handler
  (`BigInt(params.value)`), returning them as strings back to Rust.
- Use `serde_json`'s `arbitrary_precision` feature on the Rust side if you need
  lossless i64 round-trips.

---

## 2. Async handlers and concurrency within the sidecar

Node.js is single-threaded but the event loop processes microtasks between
`await` points. If multiple requests arrive while a slow async handler is in
flight (e.g. `slow`), they queue up in the event loop and are served
interleaved, not in parallel.

**Implication:** a single sidecar instance is effectively concurrent for I/O-bound
work but is serial for CPU-bound work. Long synchronous handlers (no `await`)
block all pending requests.

**Mitigation options:**
- Keep handlers async and I/O-bound. Offload CPU-heavy work to worker threads
  via `worker_threads` and wrap the result in a `Promise`.
- Spawn multiple sidecar instances from Rust and load-balance across them if
  true parallelism is required.

---

## 3. `Buffer` / `Uint8Array` vs. Rust byte slices

`JSON.stringify` does **not** serialise `Buffer` or `Uint8Array` as a JSON
array or base-64 string — it emits an object like `{"0":72,"1":101,...}` for
`Buffer` and an empty object `{}` for `Uint8Array`, which is almost certainly
not what you want.

```js
// WRONG — Buffer does not serialise as expected
return { data: Buffer.from('hello') }; // → {"data":{"0":104,"1":101,...}}
```

**Mitigation:** always convert binary data to a base-64 string before returning
it to Rust, and accept base-64 strings as input:

```js
// Sidecar
return { data: someBuffer.toString('base64') };

// Rust
let bytes = base64::decode(result["data"].as_str().unwrap())?;
```

---

## 4. Non-serialisable return values

Values that `JSON.stringify` cannot represent become `null` or are silently
dropped, which leads to confusing `{"result":null}` responses:

| JS value | JSON output |
|---|---|
| `undefined` | field omitted (becomes `null` result) |
| `function` | omitted |
| `Symbol` | omitted |
| `Infinity` / `NaN` | `null` |
| `BigInt` | **throws** `TypeError` (crashes the handler) |
| `Map` / `Set` | `{}` |

**Mitigation:**
- Validate handler return values before writing to stdout.
- Wrap the `JSON.stringify` call in a try/catch and return a `-32000` error on
  serialisation failure (the dispatch loop in the template already does this via
  the `catch` block around `await handler(...)`).
- Convert `Map`/`Set` to plain objects/arrays, convert `BigInt` to string.

---

## 5. Sidecar startup latency and ready-signal timing

`NodeBridge::spawn` blocks until `{"ready":true}` is received or the timeout
(default 5 s) elapses. Node.js startup is typically fast (< 200 ms) but can
be slower in constrained environments (Docker, low-RAM VMs, large `require`
chains at the top of the sidecar file).

**Mitigation:**
- Keep `require` calls inside handler functions if they are expensive and
  infrequently used (lazy loading).
- Increase `ready_timeout` in `NodeBridge::spawn` for cold-start environments.
- Use `node --max-old-space-size` and similar flags if the sidecar is
  memory-constrained.

---

## 6. Stderr vs stdout mixing

The bridge reads only stdout for JSON-RPC messages. Anything the sidecar writes
to stderr (e.g. `console.error`, uncaught exception stack traces) goes directly
to the parent process's stderr via `Stdio::inherit()` and does **not** affect
the protocol.

**Implication:** uncaught exceptions in async callbacks outside the dispatch
loop (e.g. an unhandled promise rejection) may print to stderr and silently
crash Node.js without sending an error response, leaving the Rust caller
blocked until its `recv_timeout` fires.

**Mitigation:**
- Add a global unhandled rejection handler:
  ```js
  process.on('unhandledRejection', (reason) => {
    process.stderr.write('[sidecar] unhandledRejection: ' + reason + '\n');
    process.exit(1);
  });
  ```
- The Rust `bridge_client` reader thread will drain pending callers with a
  `"child process exited unexpectedly"` error when stdout closes.
