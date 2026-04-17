# Future Scope — TypeScript → Ruby Bridge

Ideas and improvements that are out of scope for the initial implementation but
are worth pursuing as the project matures.

---

## 1. Sorbet / RBS Type Definitions → TypeScript Interface Generation

Ruby 3.0 introduced **RBS** (Ruby Signature), a standard type-definition format
for Ruby. The **Sorbet** type-checker uses a similar `.rbi` annotation format.

**Opportunity:** Auto-generate TypeScript interfaces for each handler's params
and result types from RBS / Sorbet signatures.

Example RBS:

```rbs
# add.rbs
type AddParams  = { a: Integer, b: Integer }
type AddResult  = { sum: Integer }
```

Generated TypeScript:

```typescript
export interface AddParams  { a: number; b: number }
export interface AddResult  { sum: number }
```

**Implementation sketch:**

- Parse `.rbs` files using the [`rbs` gem](https://github.com/ruby/rbs) CLI
  (`rbs parse`) to produce a JSON AST.
- Walk the AST in a Ghost-Bridge code-gen script and emit TypeScript interfaces.
- Inject the interfaces into the client template so `call('add', params)` is
  fully typed end-to-end.

---

## 2. Async I/O Using the `async` Gem (Samuel Williams)

The [`async` gem](https://github.com/socketry/async) provides a fibre-based
concurrency model for Ruby similar to Node.js's event loop. Combined with the
[`async-io`](https://github.com/socketry/async-io) gem, sidecars can handle
many concurrent JSON-RPC requests without spawning OS threads:

```ruby
require 'async'
require 'async/io/stream'

Async do |task|
  $stdin.each_line do |line|
    task.async { handle(line) }
  end
end
```

**Benefit:** True concurrent handler execution with low memory overhead,
bypassing the GVL limitation for I/O-bound workloads without JRuby.

**Prerequisite:** Add `gem 'async'` and `gem 'async-io'` to the bridge Gemfile.

---

## 3. JRuby for True Thread Parallelism

[JRuby](https://www.jruby.org/) runs on the JVM and has **no GVL**. All Ruby
threads run in parallel on separate OS threads, which is ideal for CPU-bound
sidecar handlers.

**Changes required to support JRuby:**

- Detect `RUBY_PLATFORM` (`java`) and adjust spawn command to `jruby` or
  the full JRuby path.
- Account for longer startup time (~1–3 s JVM warm-up); increase the ready
  handshake timeout in the TypeScript client.
- Some C-extensions have no JRuby equivalent — audit gem dependencies before
  migrating.
- Signal handling differences: JRuby signal traps work but `Thread#kill` 
  semantics differ slightly.

**Ghost-Bridge support:** Add a `{ runtime: 'jruby' }` option to the client
constructor that substitutes `jruby` for `ruby` in the spawn command.

---

## 4. Hot Gem Reload via Zeitwerk

[Zeitwerk](https://github.com/fxn/zeitwerk) is Ruby's standard autoloader
(used by Rails). A long-running sidecar could use Zeitwerk's reloading support
to pick up new handler code without restarting:

```ruby
loader = Zeitwerk::Loader.new
loader.push_dir('./handlers')
loader.enable_reloading
loader.setup

# On SIGHUP, reload all handler files
Signal.trap('HUP') { loader.reload }
```

**Use case:** Hot-patching a production sidecar with a bug fix without dropping
in-flight requests. The TypeScript parent would send `SIGHUP` instead of
restarting the child.

**Caveats:**

- Zeitwerk reloading is not thread-safe without additional locks.
- Handler constants that cache state (e.g. database connection pools) must be
  re-initialised after reload.
- Not supported on Windows (no `SIGHUP`); fall back to a JSON-RPC `reload`
  method instead.

---

## 5. Structured Logging over stderr

Currently, sidecars write unstructured text to `$stderr`. A future enhancement
would emit newline-delimited JSON log lines on `$stderr`:

```ruby
def log(level, message, **context)
  $stderr.puts JSON.generate({ ts: Time.now.iso8601(3), level:, message:, **context })
end
```

The TypeScript parent could capture `stderr` and forward logs to the host
application's logger, making distributed tracing across language boundaries
easier.

---

## 6. Protocol Buffers / MessagePack Transport (Binary Mode)

JSON parsing becomes a bottleneck at very high message rates (>50 k/s). A future
`typescript-ruby-msgpack` bridge variant could:

- Use [`msgpack` gem](https://github.com/msgpack/msgpack-ruby) on the Ruby side.
- Use [`@msgpack/msgpack`](https://github.com/msgpack/msgpack-javascript) on the
  TypeScript side.
- Frame messages with a 4-byte little-endian length prefix instead of newlines,
  eliminating the need for newline escaping.

This would be a separate bridge pair rather than a modification of the existing
one, preserving JSON compatibility for standard use cases.
