# frozen_string_literal: true
#
# Stitch — shared Ruby sidecar base.
#
# All Ruby sidecars (typescript-ruby, go-ruby, python-ruby, rust-ruby) call
# +run_sidecar(handlers)+ from this file rather than duplicating the sync
# setup, signal traps, watchdog thread, and main dispatch loop.
#
# Usage in a sidecar template:
#
#   require_relative '../../shared/ruby_sidecar/sidecar_base'
#
#   HANDLERS = {
#     'my_method' => ->(params) { { result: params } },
#     # [CLAUDE_HANDLERS]
#   }.freeze
#
#   run_sidecar(HANDLERS)

# ── I/O discipline ────────────────────────────────────────────────────────────
$stdout.sync = true
$stderr.sync = true

require 'json'

# ── Signal traps ──────────────────────────────────────────────────────────────
Signal.trap('TERM') { exit 0 }
Signal.trap('INT')  { exit 0 }

# ── Stdin-EOF watchdog ────────────────────────────────────────────────────────
# Exits the sidecar automatically when the parent process closes stdin
# (e.g. parent crashes without sending SIGTERM).
Thread.new do
  loop { break if $stdin.read(1).nil? }
  exit 0
end

# ── Response helpers ──────────────────────────────────────────────────────────

# Send a single JSON line to stdout and flush immediately.
def send_response(id, result: nil, error: nil)
  msg = { id: id }
  if error
    msg[:error] = error
  else
    msg[:result] = result
  end
  $stdout.puts JSON.generate(msg)
  $stdout.flush
end

# ── Main sidecar loop ─────────────────────────────────────────────────────────

# Run the JSON-RPC sidecar main loop.
#
# @param handlers [Hash<String, #call>]
#   Map of method name => callable.  Each callable receives the parsed params
#   Hash and must return a JSON-serialisable value, or raise StandardError to
#   send an error response.
#
# This method blocks until stdin is closed.
#
# Example:
#
#   HANDLERS = {
#     'echo' => ->(params) { params },
#   }.freeze
#   run_sidecar(HANDLERS)
def run_sidecar(handlers)
  # Signal readiness — the parent blocks until it reads this line.
  $stdout.puts JSON.generate({ ready: true })
  $stdout.flush

  $stdin.each_line do |raw|
    line = raw.strip
    next if line.empty?

    req = nil
    begin
      req = JSON.parse(line)
      method_name = req['method']
      params      = req['params'] || {}

      handler = handlers[method_name]
      if handler.nil?
        send_response(req['id'],
                      error: { message: "Unknown method: #{method_name.inspect}" })
        next
      end

      result = handler.call(params)
      send_response(req['id'], result: result)
    rescue => e
      send_response(
        req&.fetch('id', nil),
        error: {
          message:   e.message,
          backtrace: e.full_message(highlight: false)
        }
      )
    end
  end
end
