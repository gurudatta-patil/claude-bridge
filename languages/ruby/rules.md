# Language Rules — Ruby (Sidecar / Target)

Ruby acts as a **target** (child process), receiving JSON-RPC requests via stdin and writing responses to stdout.

---

## Environment

| Concern | Rule |
|---------|------|
| Isolation | Always run inside a Bundler-managed gemset or an rbenv gemset. Never `gem install` globally. |
| Minimum version | Ruby 3.1 |
| Package manager | `bundler` — generate a `Gemfile` inside `.ghost-bridge/ruby/<bridge_name>/` |
| Executable path | `.ghost-bridge/ruby/<bridge_name>/vendor/bundle` or system rbenv path |

---

## Startup Contract

1. Require gems.
2. Flush `$stdout` (`$stdout.sync = true` — **mandatory**, otherwise output is buffered).
3. Write `{"ready":true}` + newline to stdout.
4. Enter readline loop.

---

## Shutdown / Signal Rules

```ruby
# Trap SIGTERM and SIGINT
Signal.trap('TERM') { exit 0 }
Signal.trap('INT')  { exit 0 }

# Watchdog: exit when stdin closes (parent died)
Thread.new do
  loop { break if $stdin.read(1).nil? }
  exit 0
end
```

---

## stdout Discipline

- Set `$stdout.sync = true` at the very top of the script (before requiring gems).
- Never `puts` or `print` outside the JSON-RPC write path.

---

## Error Format

```ruby
rescue => e
  resp = { id: req['id'], error: { message: e.message, traceback: e.full_message } }
  $stdout.puts(resp.to_json)
  $stdout.flush
```
