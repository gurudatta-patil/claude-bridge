# Ghost-Bridge — TypeScript → Go

Spawn a compiled Go binary as a long-lived sidecar and communicate over
newline-delimited JSON-RPC on stdin/stdout.  The Go binary starts in ~5 ms,
handles requests in a tight `bufio.Scanner` loop, and exits cleanly on
stdin EOF or OS signal.

---

## Prerequisites

| Tool | Minimum version |
|------|----------------|
| Node.js | 18 |
| Go | 1.22 |
| (optional) vitest | 1.x |

---

## Build the sidecar

Every Go sidecar must be compiled before it can be spawned.  The TypeScript
client expects the binary at:

```
.ghost-bridge/go/<bridgeName>/bridge        # POSIX
.ghost-bridge/go/<bridgeName>/bridge.exe    # Windows
```

Example for a bridge called `my-bridge`:

```sh
mkdir -p .ghost-bridge/go/my-bridge
go build -o .ghost-bridge/go/my-bridge/bridge ./bridges/typescript-go/template.sidecar
```

Disable CGo to produce a fully static binary:

```sh
CGO_ENABLED=0 go build -o .ghost-bridge/go/my-bridge/bridge ./bridges/typescript-go/template.sidecar
```

---

## Quick-start

```ts
import { GoBridgeClient } from "./bridges/typescript-go/template.client";

const client = new GoBridgeClient("my-bridge");
await client.ready();

const result = await client.call("your_method", { field: "value" });
console.log(result);

await client.close();
```

Process-level cleanup hooks (SIGINT, SIGTERM, uncaughtException, exit) are
registered automatically — you do not need to call `close()` in a signal
handler yourself.

---

## Running the tests

```sh
# From the repo root:
npx vitest run bridges/typescript-go/tests/ts-go.test.ts
```

The test suite compiles `tests/test-child` automatically via `execSync` and
cleans up the binary on completion.

---

## File list

```
bridges/typescript-go/
├── template.client.ts          TypeScript client (spawn + JSON-RPC)
├── template.sidecar/
│   ├── main.go                 Go sidecar template (dispatch TODO stub)
│   └── go.mod
├── tests/
│   ├── test-child/
│   │   ├── main.go             Runnable Go test sidecar (echo, add, …)
│   │   └── go.mod
│   └── ts-go.test.ts           Vitest integration tests
├── edge-cases.md               Go-specific gotchas
├── future-scope.md             Ideas for future enhancements
└── README.md                   This file
```

---

## Protocol summary

| Direction | Format |
|-----------|--------|
| Parent → child | `{"id":"<uuid>","method":"name","params":{...}}\n` |
| Child → parent (success) | `{"id":"...","result":{...}}\n` |
| Child → parent (error) | `{"id":"...","error":{"message":"...","traceback":"..."}}\n` |
| Child startup | `{"ready":true}\n` emitted before entering the request loop |

All messages are newline-delimited.  The parent buffers chunks and splits on
`\n` — it never parses a raw `data` event as JSON directly.

---

## Adding a new method to the sidecar

1. Open `template.sidecar/main.go`.
2. Add a handler function (`func handleFoo(req Request) { ... }`).
3. Add a `case "foo":` branch in the `dispatch` switch.
4. Recompile the binary.

See `tests/test-child/main.go` for worked examples of all five built-in
methods (`echo`, `add`, `raise_error`, `echo_b64`, `slow`).
