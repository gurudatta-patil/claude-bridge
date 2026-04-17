# Ghost-Bridge — Go → Node.js

Spawn a Node.js sidecar from Go and call any JavaScript/npm function as a simple
blocking RPC call. Communication happens over newline-delimited JSON-RPC on
stdin/stdout — no network, no ports, no serialization library required.

---

## How it works

```
Go process                          Node.js child
───────────                         ─────────────
NewNodeBridge("sidecar.js")  ──▶  node sidecar.js
                             ◀──  {"ready":true}
b.Call("add", {a:3, b:4})   ──▶  {"id":"…","method":"add","params":{…}}
                             ◀──  {"id":"…","result":{"sum":7}}
b.Close()                    ──▶  stdin EOF → rl.on('close') → process.exit(0)
```

Every `Call` is multiplexed over a single stdin/stdout pipe.  Concurrent calls from
multiple goroutines are fully supported — each request carries a UUID and responses
are routed back to the correct caller.

---

## Quick start

### 1. Add the dependency

```bash
go get github.com/ghost-bridge/go-nodejs
```

### 2. Write (or copy) a sidecar

```js
// my-sidecar.js
'use strict';
const readline = require('readline');

const handlers = {
  greet: async ({ name }) => ({ message: `Hello, ${name}!` }),
};

async function dispatch(req) {
  const h = handlers[req.method];
  if (!h) return { id: req.id, error: { code: -32601, message: 'Method not found' } };
  try   { return { id: req.id, result: await h(req.params || {}) }; }
  catch (e) { return { id: req.id, error: { code: -32000, message: e.message } }; }
}

const rl = readline.createInterface({ input: process.stdin });
process.stdout.write(JSON.stringify({ ready: true }) + '\n');
rl.on('line', async (line) => {
  const req = JSON.parse(line.trim());
  process.stdout.write(JSON.stringify(await dispatch(req)) + '\n');
});
rl.on('close', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
```

### 3. Call it from Go

```go
package main

import (
    "encoding/json"
    "fmt"
    "log"

    gobridge "github.com/ghost-bridge/go-nodejs"
)

func main() {
    b, err := gobridge.NewNodeBridge("my-sidecar.js")
    if err != nil {
        log.Fatal(err)
    }
    defer b.Close()

    res, err := b.Call("greet", map[string]any{"name": "Alice"})
    if err != nil {
        log.Fatal(err)
    }

    var out struct{ Message string `json:"message"` }
    json.Unmarshal(res, &out)
    fmt.Println(out.Message) // Hello, Alice!
}
```

---

## File layout

```
bridges/go-nodejs/
├── template.client.go      # NodeBridge Go client (copy/import into your project)
├── node_lookup.go          # Cross-platform node executable lookup
├── template.sidecar.js     # Starter sidecar template
├── go.mod
├── edge-cases.md           # Go→Node.js specific gotchas
├── future-scope.md         # Roadmap ideas
└── tests/
    ├── go.mod
    ├── go-nodejs_test.go   # Integration test suite
    ├── test-child.js       # Real sidecar: echo, add, raise_error, echo_b64, slow
    └── test-client/
        ├── main.go         # Manual smoke-test binary
        └── go.mod
```

---

## API reference

### `NewNodeBridge(scriptPath string, args ...string) (*NodeBridge, error)`

Spawns `node <scriptPath> [args...]`, waits for the child to emit `{"ready":true}`,
and starts the response-dispatch goroutine.  Returns an error if `node` is not found
on `PATH` or the child fails to start.

### `(*NodeBridge).Call(method string, params map[string]any) (json.RawMessage, error)`

Sends one JSON-RPC request and blocks until the response arrives.  Thread-safe —
multiple goroutines may call `Call` concurrently.

Returns `(nil, *rpcError)` when the child returns an error object.

### `(*NodeBridge).Close() error`

Closes stdin (triggers the child's readline EOF watchdog) and calls `cmd.Wait()`.
Safe to call multiple times.

### `LookupNode() (string, error)`

Returns the absolute path of the `node` executable.  Checks `node.exe` first on
Windows.  Useful for pre-flight checks or custom `exec.Command` setups.

---

## Running the tests

```bash
cd bridges/go-nodejs/tests
go test -v -count=1 ./...
```

Requirements: `node` ≥ 14 on `PATH`.

If Node is not found the suite exits with code 0 and prints a SKIP message, so CI
environments without Node do not fail the overall build.

---

## Error handling

| Scenario | Behaviour |
|---|---|
| Method not registered in sidecar | `error.code = -32601` |
| Handler throws an exception | `error.code = -32000`, message = `err.message` |
| Child process crashes | All pending `Call()` return `error.code = -32099` |
| Malformed JSON from child | Line is silently dropped (no pending call matched) |

---

## Concurrency notes

- Go side: a single `sync.Mutex` serialises writes to stdin; responses are demuxed
  by UUID into per-call channels.
- Node side: `readline` delivers lines sequentially, but `async` handlers run
  concurrently on the event loop.  Results may arrive out of order — this is
  intentional and correct.

---

## Windows notes

- The bridge uses `LookupNode()` which tries `node.exe` before `node`.
- Ensure the Node installation directory is in the `PATH` visible to the Go process.
- Named pipes are not used; stdin/stdout handles work identically on all platforms.

---

## License

Part of the Ghost-Bridge project. See the root `LICENSE` file.
