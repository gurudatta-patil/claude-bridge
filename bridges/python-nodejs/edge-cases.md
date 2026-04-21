# Edge Cases – Python → Node.js Bridge

Known gotchas and recommended mitigations when using the Stitch Python→Node.js bridge.

---

## 1. Number precision: JavaScript `Number` vs Python `int` / `float`

JavaScript uses IEEE 754 double-precision floating-point for **all** numbers. Python has arbitrary-precision integers.

### Problem

Large Python integers lose precision after round-trip through Node.js JSON:

```python
bridge.call("echo", {"n": 2**53 + 1})
# JavaScript Number can only represent integers exactly up to 2^53
# Node returns  {"n": 9007199254740992}   ← 2^53, NOT 2^53 + 1
```

Floats with many significant digits are similarly affected:

```python
bridge.call("echo", {"x": 0.1 + 0.2})
# Underlying IEEE 754 representation is shared; result is 0.30000000000000004
```

### Mitigation

- Pass large integers as strings and parse them on the Node.js side.
- Use Python's `decimal.Decimal` for high-precision arithmetic and serialise to string.
- For Node.js 20+ you can use `BigInt`, but you must serialise it to string manually because `JSON.stringify` throws on `BigInt` values.

---

## 2. Async handlers and unhandled promise rejections

Node.js handlers are `async` functions. If a handler throws synchronously before the first `await`, the error is still caught by the `try/catch` in `dispatch`. However, if a handler spawns a **background** promise that later rejects without being awaited, Node.js will emit an `unhandledRejection` event.

### Problem

```js
// BAD – fire-and-forget rejection is invisible to the caller
doSomethingAsync: async (params) => {
  someOtherPromise().catch(() => {});   // silently swallowed
  return { started: true };
}
```

An unhandled rejection can crash the process in Node.js 15+ (`--unhandled-rejections=throw` is the default), breaking all pending and future calls.

### Mitigation

- Always `await` every `Promise` inside a handler, or attach `.catch()` handlers.
- Add a global guard in your sidecar during development:

```js
process.on('unhandledRejection', (reason) => {
  process.stderr.write(`[sidecar] unhandledRejection: ${reason}\n`);
  // Do NOT call process.exit here in production – it will orphan pending calls.
});
```

---

## 3. `Buffer` vs `bytes`: binary data over JSON

JSON does not have a binary type. Node.js `Buffer` and Python `bytes` cannot be transported directly.

### Problem

```js
// Node.js handler returns a Buffer – JSON.stringify converts it to
// {"type":"Buffer","data":[72,101,108,108,111]}   ← array of byte values
readFile: async ({ path }) => fs.readFileSync(path)  // Buffer, not string
```

Python receives a dict, not bytes.

### Mitigation

**Base64 is the standard approach** – both sides agree to use base64 strings:

```js
// Node.js
const { Buffer } = require('buffer');
readFile: async ({ path }) => ({
  data: fs.readFileSync(path).toString('base64'),
  encoding: 'base64',
}),
```

```python
# Python
import base64
result = bridge.call("readFile", {"path": "/tmp/foo.bin"})
raw_bytes = base64.b64decode(result["data"])
```

---

## 4. Non-JSON-serialisable return values

`JSON.stringify` silently drops certain values:

| Value | JSON output |
|---|---|
| `undefined` | property omitted |
| `function` | property omitted |
| `Symbol` | property omitted |
| `BigInt` | **throws** `TypeError` |
| Circular reference | **throws** `TypeError` |

### Problem

```js
badHandler: async () => ({
  fn: () => 42,        // silently dropped → Python sees {}
  n: BigInt(9007199254740993),  // throws → sidecar crashes
}),
```

A crash inside `JSON.stringify` inside `dispatch` propagates as an uncaught error; the sidecar exits and the Python bridge raises `BridgeError` or `RuntimeError("child process exited")`.

### Mitigation

- Return only plain objects, arrays, strings, numbers, booleans, and `null`.
- Convert `BigInt` to string before returning.
- Use a custom replacer function if you need to serialise complex objects:

```js
process.stdout.write(JSON.stringify(resp, (key, val) =>
  typeof val === 'bigint' ? val.toString() : val
) + '\n');
```

---

## 5. Startup latency on first call

Node.js startup time (V8 initialisation, module loading) is typically 50–150 ms. The bridge waits for `{"ready":true}` before allowing calls, so **startup cost is paid once** at `NodeBridge.start()` / `__enter__`, not on the first call.

Keep `ready_timeout` generous (default 10 s) in environments with slow filesystems (Docker with overlayfs, network mounts).

---

## 6. Newlines inside JSON strings

The protocol is **newline-delimited**: each JSON message must be a single line. `JSON.stringify` and Python's `json.dumps` both escape embedded newlines as `\n`, so normal string values are safe.

Problems arise only if you bypass the standard serialisers and write raw strings containing literal `\n` bytes to stdout. Always use `JSON.stringify` / `json.dumps` — never construct JSON by hand.

---

## 7. Process exit before all responses are sent

If the Node.js process calls `process.exit()` while there are in-flight requests, the Python bridge reader thread detects EOF and wakes every pending caller with:

```
BridgeError: [-32000] child process exited
```

Ensure your handlers complete before the process exits. Avoid calling `process.exit()` from inside a handler; throw an `Error` instead.
