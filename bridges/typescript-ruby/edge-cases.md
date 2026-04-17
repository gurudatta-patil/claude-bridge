# Ruby-Specific Edge Cases

This document catalogues edge cases that are unique to the TypeScript → Ruby
bridge and that do not apply to other Stitch language pairs.

---

## 1. Ruby GVL (Global VM Lock) and I/O Concurrency

Ruby MRI (CRuby) has a Global VM Lock (GVL, formerly GIL) that prevents true
parallel execution of Ruby bytecode across threads. However, the GVL **is
released** during blocking I/O, including:

- `IO#read` / `IO#gets` / `$stdin.each_line`
- `sleep`
- Most C-extension network calls

**Implication for the bridge:** The sidecar processes requests sequentially
because the main loop blocks on `$stdin.each_line`. Concurrent requests queued
in the pipe are dispatched one at a time. For CPU-bound handlers this is fine;
for long-running I/O handlers (e.g. HTTP calls), consider spawning a Thread per
request or migrating to the `async` gem (see `future-scope.md`).

**Mitigation:** For strictly I/O-bound sidecars, Ruby threads work well because
the GVL is released. Use `Thread.new { handler.call(params) }` inside the loop
and write responses back via a Mutex-protected write.

---

## 2. Bundler Load Time and Gem Path Resolution

When a sidecar uses `require 'bundler/setup'` or `Bundler.require`, the first
startup can take **50–300 ms** while Bundler resolves the gem graph. Strategies:

- Pre-warm with `bundle exec ruby sidecar.rb` so the bundle is locked.
- Use `BUNDLE_GEMFILE=/path/to/Gemfile bundle exec ruby …` if the script lives
  outside the project root.
- For gems with C extensions, the first `require` triggers `.so` / `.bundle`
  loading — profile with `ruby -e "require 'bundler/setup'; require 'pg'"`.
- Stitch places each bridge's Gemfile under
  `.stitch/ruby/<bridge>/Gemfile`. Ensure `BUNDLE_GEMFILE` is exported
  before spawning, or pass it in the `env` option of `child_process.spawn`.

---

## 3. `$stdout.sync` vs `IO#flush` Differences

| Mechanism | Behaviour |
|---|---|
| `$stdout.sync = true` | Auto-flush after **every write**. Equivalent to `C`'s `setbuf(stdout, NULL)`. |
| `$stdout.flush` | One-shot manual flush at the call site. |
| `IO#write` | Does **not** append a newline; safe for framing. |
| `$stdout.puts` | Appends `\n` if not already present. Safe for single-line JSON, **dangerous** if the JSON string itself contains an embedded newline (it won't — `JSON.generate` escapes them, but worth knowing). |

**Rule:** Always set `$stdout.sync = true` as the very first line. Do not rely
on `flush` calls scattered throughout handlers — they are easy to miss after
refactoring.

---

## 4. Windows: Ruby on Windows — UTF-8 BOM and CRLF

On Windows, the default console code page is often **CP1252** or **CP932**
(Japanese). Ruby respects `Encoding.default_external`, which may not be UTF-8.

**Problems:**

- `JSON.parse` will raise `Encoding::UndefinedConversionError` on non-ASCII
  bytes if the pipe encoding is wrong.
- Windows pipes can emit **CRLF** (`\r\n`) as line endings. Splitting on `\n`
  in the TypeScript client leaves a trailing `\r`, which corrupts `JSON.parse`.
- Some Windows Ruby installers write a **UTF-8 BOM** (`\xEF\xBB\xBF`) at the
  start of stdio, which breaks the ready-line JSON parse.

**Mitigations:**

```ruby
# Force UTF-8 at the top of the sidecar (after $stdout.sync = true)
$stdout.set_encoding('UTF-8')
$stdin.set_encoding('UTF-8')
```

In the TypeScript client, strip `\r` when splitting lines:

```typescript
const lines = this.buffer.split('\n').map(l => l.replace(/\r$/, ''));
```

---

## 5. Ruby Exception Hierarchy

Ruby's exception tree differs from most languages:

```
Exception
├── ScriptError   (SyntaxError, LoadError — cannot rescue with rescue => e)
├── SignalException
│   └── Interrupt
└── StandardError   ← rescue => e catches this and subclasses only
    ├── RuntimeError  (default for `raise "message"`)
    ├── ArgumentError
    ├── NoMethodError
    ├── TypeError
    └── …
```

**Critical:** `rescue => e` only catches `StandardError` and its descendants.
A `LoadError` (missing gem) or `SyntaxError` will **not** be caught and will
terminate the sidecar without sending a JSON-RPC error response. The TypeScript
client will see the process exit and reject all pending calls via the `exit`
handler — which is correct behaviour, but add logging to `$stderr` so the cause
is visible.

To catch everything (use sparingly):

```ruby
rescue Exception => e   # catches LoadError, SignalException, etc.
```

---

## 6. `puts` vs `write` Differences — Framing Safety

| Method | Newline behaviour | Framing risk |
|---|---|---|
| `$stdout.puts s` | Adds `\n` if `s` does not end with `\n`; adds **two** newlines if `s` already ends with one | Safe for a compact JSON object with no trailing newline |
| `$stdout.write s` | Writes bytes exactly as given | Must manually append `"\n"` |
| `$stdout.print s` | Like `write` but calls `to_s` | Must manually append `"\n"` |

**Recommendation:** Use `$stdout.puts JSON.generate(...)` consistently.
`JSON.generate` never emits a trailing newline, so `puts` adds exactly one `\n`,
giving clean newline-delimited framing. Avoid `p obj` in handlers — it writes
`inspect` output with a newline to stdout and will corrupt the framing.
