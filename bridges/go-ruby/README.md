# Go → Ruby Bridge

Part of **Stitch** — seamless cross-language IPC via JSON-RPC over stdio.

This bridge lets a Go application call methods implemented in Ruby through a
lightweight subprocess protocol.  No HTTP server, no ports, no serialisation
framework beyond stdlib JSON.

---

## How it works

```
Go process
 └─ goruby.Client
      ├─ spawns:  ruby sidecar.rb
      ├─ stdin  → newline-delimited JSON requests
      └─ stdout ← newline-delimited JSON responses
```

1. The Go client spawns `ruby <script>` and waits for `{"ready":true}`.
2. Each `client.Call()` serialises a JSON-RPC request with a UUID, writes it to
   the child's stdin, and blocks on a per-call channel.
3. A background goroutine reads stdout lines and dispatches responses by UUID,
   allowing unlimited concurrent calls.
4. On `client.Close()`, stdin is closed (triggering the sidecar's EOF watchdog),
   followed by SIGTERM then SIGKILL after a 2-second grace period.

---

## Quick start

### Prerequisites

- Go 1.22+
- Ruby 2.7+ (3.x recommended; `json` gem ships in stdlib)
- `github.com/google/uuid` (see `go.mod`)

### 1. Copy the template files

```
bridges/go-ruby/
├── template.client.go   ← embed in your Go package
└── template.sidecar.rb  ← copy and fill in [CLAUDE_*] placeholders
```

### 2. Implement your Ruby handlers

In `template.sidecar.rb`, replace the `[CLAUDE_METHOD_HANDLERS]` comment with
your method lambdas:

```ruby
HANDLERS = {
  'greet' => ->(params) { { message: "Hello, #{params['name']}!" } },
}.freeze
```

### 3. Call from Go

```go
import goruby "github.com/claude-bridge/bridges/go-ruby"

client, err := goruby.New("path/to/sidecar.rb")
if err != nil { log.Fatal(err) }
defer client.Close()

var result map[string]any
err = client.Call("greet", map[string]any{"name": "World"}, &result)
fmt.Println(result["message"]) // Hello, World!
```

---

## API reference

### `goruby.New(scriptPath string, rubyArgs ...string) (*Client, error)`

Spawns `ruby [rubyArgs...] scriptPath` and waits up to 10 seconds for the
`{"ready":true}` handshake.  Returns a ready-to-use client or an error.

Optional `rubyArgs` are inserted between `ruby` and the script path, useful for
flags like `-W0` (suppress warnings) or `-rbundler/setup`.

### `(*Client).Call(method string, params map[string]any, out any) error`

Sends a JSON-RPC request and blocks until the response arrives.

- `out` — pointer to unmarshal the `result` field into, or `nil` to discard.
- Returns `*goruby.RPCError` if the sidecar returned an error frame.

### `(*Client).Close() error`

Shuts down the sidecar.  Safe to call multiple times.

---

## Protocol wire format

```jsonc
// Request (Go → Ruby)
{"id": "550e8400-...", "method": "greet", "params": {"name": "World"}}

// Success response (Ruby → Go)
{"id": "550e8400-...", "result": {"message": "Hello, World!"}}

// Error response (Ruby → Go)
{"id": "550e8400-...", "error": {"message": "oops", "backtrace": "sidecar.rb:42:..."}}
```

All messages are newline-terminated (`\n`).  The sidecar's very first write is
always `{"ready":true}\n`.

---

## Running the tests

```bash
cd bridges/go-ruby
go test ./tests/ -v -timeout 30s
```

Tests cover:

| Test | What it verifies |
|------|-----------------|
| `TestEchoRoundTrip` | Basic string round-trip |
| `TestAddRoundTrip` | Numeric parameters and result |
| `TestEchoBase64` | Binary-safe Base64 encoding |
| `TestRaiseError` | Ruby exception → Go error propagation |
| `TestUnknownMethod` | Unknown method → descriptive error |
| `TestConcurrentCalls` | 20 goroutines calling simultaneously |
| `TestSlowConcurrent` | 5 × 150 ms slow calls are pipelined, not serialised |
| `TestStdinEOF` | Closing the client causes subsequent calls to fail cleanly |

---

## Smoke-test client

A standalone smoke-test binary lives in `tests/test-client/`:

```bash
cd bridges/go-ruby/tests/test-client
go run . 
```

It exercises echo, add, raise_error, echo_b64, and slow in sequence and prints
results to stdout.

---

## Project structure

```
bridges/go-ruby/
├── template.client.go        Go client — copy into your module
├── template.sidecar.rb       Ruby sidecar template
├── go.mod                    Module definition
├── edge-cases.md             Go→Ruby specific pitfalls
├── future-scope.md           Extension ideas (JRuby, Sorbet, Async, …)
└── tests/
    ├── test-child.rb         Fully-featured test sidecar
    ├── go-ruby_test.go       Go test suite
    └── test-client/
        └── main.go           Manual smoke-test binary
```

---

## Edge cases and known limitations

See [`edge-cases.md`](edge-cases.md) for detailed notes on:

- Ruby startup latency (~100 ms MRI, ~1–3 s JRuby)
- Bundler startup overhead and how to mitigate it
- MRI GVL and IO concurrency behaviour
- Windows RubyInstaller path differences
- `json` gem availability across Ruby versions
- `rescue` vs `rescue Exception` hierarchy

---

## Future ideas

See [`future-scope.md`](future-scope.md) for ideas including JRuby parallelism,
Sorbet → Go struct code-generation, the Async gem, Unix-domain socket transport,
and streaming responses.

---

## License

Same as the parent Stitch project.
