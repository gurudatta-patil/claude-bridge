# Future Scope — Rust → Ruby Bridge

## JRuby for true multi-core concurrency

**Motivation.** MRI Ruby (CRuby) has the Global VM Lock (GVL), which prevents
more than one Ruby thread from executing Ruby bytecode at a time.  For
CPU-bound sidecar workloads this is a hard ceiling; the sidecar can only
saturate one CPU core regardless of how many Rust threads send requests.

**JRuby** (Ruby on the JVM) has no GVL.  Native threads run in parallel,
enabling genuine multi-core concurrency within a single sidecar process.

**How it would work.**
- Swap `Command::new("ruby")` for `Command::new("jruby")` on the Rust side.
- The sidecar's request loop would spawn a new thread per request rather than
  processing sequentially, writing responses back through a shared,
  thread-safe output mutex.
- JSON serialisation/deserialisation is thread-safe in JRuby's `json` gem.

**Trade-offs.**
- JRuby cold-start is ~1–3 s (JVM boot + class loading), much higher than MRI.
- JRuby has a larger memory footprint (~100–300 MB resident vs ~20 MB for MRI).
- Some C-extension gems are unavailable on JRuby.
- The warm steady-state throughput for CPU-bound work can be 3–10× higher than
  MRI.

**When to use.** Long-lived sidecar processes handling many concurrent requests
that each do significant computation (e.g., templating, data transformation,
machine-learning inference via a Java library).

---

## Rutie — Rust ↔ Ruby FFI as a zero-IPC alternative

**Motivation.** For use cases where process isolation is not required, loading
the Ruby VM directly inside the Rust process eliminates all IPC overhead:
no pipes, no serialisation, no JSON parsing, no round-trip latency.

**[Rutie](https://github.com/danielpclark/rutie)** is a Rust crate that
embeds the MRI Ruby interpreter (`libruby`) and exposes a safe API for:
- Calling Ruby methods from Rust.
- Defining Ruby classes and methods implemented in Rust.
- Passing Rust values to Ruby and vice versa.

**Example sketch.**

```rust
use rutie::{RString, VM, Object};

fn main() {
    VM::init();
    VM::eval("require 'json'").unwrap();
    let result = VM::eval(r#"JSON.generate({hello: "world"})"#).unwrap();
    println!("{}", RString::from(result).to_str());
}
```

**Trade-offs vs stdio bridge.**

| Dimension          | stdio bridge              | Rutie (embedded)         |
|--------------------|---------------------------|--------------------------|
| Isolation          | Full (separate process)   | None (same address space)|
| Latency per call   | ~1–5 ms (pipe round-trip) | ~1–100 µs (FFI call)     |
| Crash safety       | Sidecar crash ≠ Rust crash| Ruby panic kills process |
| Deployment         | Ship ruby binary          | Link against libruby.so  |
| Thread safety      | Safe (per-process GVL)    | Must manage GVL manually |
| Debugging          | Separate logs per process | Mixed stack traces       |

**When to use Rutie.**
- Hot paths where serialisation overhead dominates (< 1 KB payloads, > 1000
  calls/s).
- Embedding a Ruby DSL into a Rust application (e.g., configuration, rules
  engine).
- When you control the full build environment and can link against a specific
  libruby version.

**When to keep the stdio bridge.**
- You need process isolation (sidecar bugs cannot corrupt the Rust process).
- The sidecar uses gems with C extensions that are unsafe to load in-process.
- You want to upgrade Ruby independently of the Rust binary.

---

## Other forward-looking ideas

### gRPC / Cap'n Proto transport upgrade

Replace newline-delimited JSON with a binary framing protocol
(gRPC, Cap'n Proto, or MessagePack) to reduce serialisation overhead for
large or high-frequency payloads.  The Ruby side can use the `grpc` gem or
`msgpack` gem; the Rust side uses `tonic` or `rmp-serde`.

### Connection pooling

Instead of one sidecar per bridge instance, maintain a pool of warm sidecar
processes.  Rust callers check out a bridge from the pool, make calls, and
return it.  This amortises Ruby cold-start cost across many short-lived
request bursts.

### Shared-memory channel (Unix only)

For very high-throughput scenarios, use a POSIX shared-memory region plus
`eventfd`/`kqueue` for notification instead of a pipe.  Ruby can `mmap` the
region via `Fiddle`.  This avoids kernel pipe buffer limits and achieves
near-native memory bandwidth for large payloads.

### WASM/WASI Ruby (Wruby / ruby.wasm)

Run Ruby inside a WASI sandbox embedded in the Rust process via the
`wasmtime` crate.  This combines the isolation of a separate process with
the low latency of in-process execution, at the cost of a WASM-specific Ruby
build and no C-extension support.
