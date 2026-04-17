# Go → Ruby Bridge: Future Scope

Ideas for extending and improving the Go→Ruby bridge beyond its current
stdio-based, single-threaded design.

---

## 1. JRuby for true thread-level concurrency

MRI Ruby's GVL serialises bytecode execution.  [JRuby](https://www.jruby.org/)
runs Ruby on the JVM with **no GVL**, giving genuine multi-threaded
parallelism.

Potential bridge changes:
- Dispatch each incoming RPC request to a `java.util.concurrent.ThreadPoolExecutor`
  (exposed via JRuby's Java interop) and write results asynchronously from
  worker threads using a mutex-protected `$stdout`.
- Startup time is higher (~1–3 s JVM cold start) but throughput on CPU-bound
  workloads can be 10–20× better.
- The Go client already supports concurrent `Call()` invocations; the sidecar
  change is self-contained.

**Trade-offs:** JVM memory overhead (~100–300 MB), slower startup, more complex
deployment.  Best suited for long-lived server processes, not short-lived
scripts.

---

## 2. Sorbet type annotations → Go struct generation

[Sorbet](https://sorbet.org/) adds a static type system to Ruby via inline
annotations (`sig { params(x: Integer).returns(String) }`).

Idea: a code-generation step that:
1. Parses Sorbet `sig` blocks from the Ruby handler file.
2. Maps Sorbet types to Go types (`Integer → int64`, `String → string`,
   `T::Array[Float] → []float64`, etc.).
3. Emits a typed Go wrapper for each handler, replacing the
   `map[string]any` API with concrete structs.

Benefits:
- Compile-time type safety on the Go call-site.
- Auto-generated marshalling code.
- Serve as a design contract between the Go caller and Ruby implementor.

This mirrors what gRPC/Protobuf does, but using idiomatic Ruby type annotations
rather than a separate IDL.

---

## 3. Async handlers using the Async gem

[Async](https://github.com/socketry/async) provides structured concurrency for
Ruby built on non-blocking IO (io-event / libev).

A future sidecar design:
```ruby
require 'async'

Async do
  $stdin.each_line do |raw|
    Async do          # each request in its own async task
      msg    = JSON.parse(raw)
      result = HANDLERS[msg['method']].call(msg['params'])
      send_result(msg['id'], result)
    end
  end
end
```

Benefits:
- Non-blocking IO within handlers (HTTP, DB) without threads or the GVL.
- Overlapping slow handlers without JRuby.
- Compatible with MRI Ruby 3.x Fiber scheduler.

**Trade-offs:** Adds a gem dependency; handlers must use Async-aware IO
libraries (e.g. `async-http`, `async-postgres`).

---

## 4. Unix-domain socket transport (optional upgrade path)

The current bridge uses stdio (one pipe pair per subprocess).  For
high-throughput use-cases a Unix-domain socket allows:
- Multiple concurrent connections from different Go goroutines to the same Ruby
  process without serialising writes through a single pipe.
- Easier load-balancing across a pool of Ruby worker processes.

The Go client would be updated to `net.Dial("unix", socketPath)` instead of
`cmd.StdinPipe()`, and the Ruby sidecar would use `Socket` / `UNIXServer`.
The JSON-RPC framing and UUID correlation are unchanged.

---

## 5. Streaming / server-push responses

The protocol currently supports only request→response (one result per request).
A future extension could add streaming:

- Client sends `{"id": "...", "method": "stream_data", "params": {...}}`
- Sidecar sends multiple `{"id": "...", "chunk": {...}}` frames followed by a
  terminal `{"id": "...", "result": {}}`.

On the Go side this maps naturally to a channel:
```go
ch, err := client.Stream("stream_data", params)
for chunk := range ch { ... }
```

No changes to the sidecar's stdio framing are required; only the client-side
multiplexer needs to detect `"chunk"` vs `"result"` frames.
