# Go → Ruby Bridge: Edge Cases

This document catalogues Go→Ruby-specific pitfalls that are not covered by the
generic Stitch protocol specification.

---

## 1. Ruby startup time (~100 ms)

MRI Ruby starts in roughly 50–150 ms on modern hardware.  That latency is paid
once when `goruby.New()` spawns the subprocess, not on every RPC call.

**Recommendations:**
- Call `goruby.New()` at application startup (or in an `init`-like phase) and
  keep the client alive for the lifetime of the process.
- Do **not** create a new client per request in a hot path.
- If startup latency is critical, consider pre-forking (see `future-scope.md`)
  or switching to JRuby (which has higher startup overhead but better
  steady-state throughput).

---

## 2. Bundler adds ~500 ms to startup

If the sidecar uses `require 'bundler/setup'` or a `Gemfile`, Bundler resolves
the dependency graph before any user code runs, adding ~300–700 ms.

**Recommendations:**
- Run `bundle install --standalone` (or `bundle exec ruby sidecar.rb`) once
  during MCP setup/provision, not at runtime.
- Cache the `.bundle` directory in CI and Docker layers.
- For production sidecars that don't need Bundler, remove the `require
  'bundler/setup'` line entirely and rely on system gems.
- Use `BUNDLE_WITHOUT` to skip development/test groups in production.

---

## 3. Ruby's GVL and IO concurrency

MRI Ruby's Global VM Lock (GVL, also called GIL) prevents true parallel
execution of Ruby bytecode.  However, the GVL is **released during blocking
IO** — including `$stdin.read`, `sleep`, and most network operations.

Practical implications for this bridge:
- The sidecar processes one JSON-RPC request at a time (the `$stdin.each_line`
  loop is single-threaded).
- Concurrent `Call()` invocations from Go are multiplexed by the Go client; the
  sidecar serialises them naturally through the loop.
- If a handler does blocking IO (HTTP requests, database queries, file reads),
  the GVL is released and other threads can run — but the RPC loop is blocked
  until that handler returns.
- **True handler-level concurrency requires either JRuby or a multi-threaded
  dispatcher in the sidecar** (dispatch each request to a thread-pool and write
  responses asynchronously — see `future-scope.md`).

---

## 4. Windows Ruby path differences

On Windows the Ruby executable location depends heavily on how Ruby was
installed:

| Installer        | Typical `ruby` path                          |
|------------------|----------------------------------------------|
| RubyInstaller    | `C:\Ruby33-x64\bin\ruby.exe`                 |
| rbenv (WSL only) | `/home/<user>/.rbenv/shims/ruby`             |
| Scoop            | `C:\Users\<user>\scoop\shims\ruby.exe`       |
| Chocolatey       | `C:\tools\ruby33\bin\ruby.exe`               |

**Recommendations:**
- Do not hard-code `"ruby"` as the executable if shipping cross-platform.  Let
  users configure the path via an environment variable (e.g. `RUBY_BIN`) and
  fall back to `"ruby"` on PATH.
- On Windows, `exec.Command("ruby", ...)` requires `ruby.exe` to be on `%PATH%`
  — verify this in your MCP setup documentation.
- Line endings: use `\n` (LF) for the newline delimiter even on Windows; the Go
  client and Ruby sidecar both write LF.  Do **not** rely on `\r\n`.

---

## 5. JSON gem vs stdlib json

| Ruby version | `require 'json'` availability |
|--------------|-------------------------------|
| 1.9+         | Bundled as a default gem (always available without installation) |
| 2.x          | Default gem, upgraded separately via `gem update json` |
| 3.x          | Default gem, ships with C extension for performance |

`require 'json'` should work without `gem install json` on any Ruby ≥ 1.9.
However:
- Some stripped-down Docker base images (e.g. `ruby:3-alpine`) may omit
  non-essential default gems.  Run `ruby -e "require 'json'"` to verify.
- If you need a specific JSON gem version (e.g. for `JSON.parse` options added
  in 2.7), pin it in your `Gemfile`.
- The C extension (`json`) is significantly faster than the pure-Ruby fallback
  (`json/pure`).  Prefer it for high-throughput sidecars.

---

## 6. Exception vs StandardError hierarchy in `rescue`

Ruby has two main rescue-able branches:

```
Exception
├── ScriptError       (SyntaxError, LoadError, …)
├── SignalException   (Interrupt, …)
├── SystemExit
└── StandardError     ← rescue catches this by default
    ├── RuntimeError
    ├── ArgumentError
    ├── TypeError
    ├── IOError
    └── … (most application errors)
```

The sidecar template uses `rescue => e`, which is equivalent to
`rescue StandardError => e`.  This is intentional:

- It will NOT catch `SystemExit` or `SignalException`, so `Signal.trap` and
  `exit` still work correctly.
- It will NOT catch `NoMemoryError` or `Interrupt` — these should propagate and
  kill the process rather than returning an RPC error.
- If you call `rescue Exception => e` you risk swallowing `SystemExit` and
  preventing clean shutdown.

**Do not change `rescue => e` to `rescue Exception => e`** in the sidecar
dispatch loop.
