# frozen_string_literal: true
#
# Stitch - shared Ruby sidecar base.
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

# ── StitchStream wrapper ──────────────────────────────────────────────────────

# Wrap an Enumerator to signal run_sidecar to send chunk frames instead of a
# single result response.
class StitchStream
  def initialize(enumerator)
    @enumerator = enumerator
  end

  def each(&block)
    @enumerator.each(&block)
  end
end

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
# Pass chunk: to send a streaming chunk frame instead of a result/error frame.
def send_response(id, result: nil, error: nil, chunk: :__not_set__)
  msg = { id: id }
  if chunk != :__not_set__
    msg[:chunk] = chunk
  elsif error
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
  debug = ENV['STITCH_DEBUG'] == '1'

  # Built-in handlers merged with user-supplied handlers.
  # User handlers take precedence if they shadow a built-in name.
  all_handlers = {
    '__ping__' => ->(_params) { { pong: true, pid: Process.pid } }
  }.merge(handlers)

  # Signal readiness, advertising all available method names.
  $stdout.puts JSON.generate({ ready: true, methods: all_handlers.keys })
  $stdout.flush

  $stdin.each_line do |raw|
    line = raw.strip
    next if line.empty?

    req = nil
    begin
      req = JSON.parse(line)
      method_name = req['method']
      params      = req['params'] || {}

      if debug
        log_entry = { dir: '→', id: req['id'], method: method_name }
        traceparent = req['traceparent']
        log_entry[:traceparent] = traceparent if traceparent
        $stderr.puts JSON.generate(log_entry)
        $stderr.flush
      end

      handler = all_handlers[method_name]
      if handler.nil?
        send_response(req['id'],
                      error: { message: "Unknown method: #{method_name.inspect}" })
        if debug
          log_entry = { dir: '←', id: req['id'], ok: false }
          traceparent = req['traceparent']
          log_entry[:traceparent] = traceparent if traceparent
          $stderr.puts JSON.generate(log_entry)
          $stderr.flush
        end
        next
      end

      result = handler.call(params)
      if result.is_a?(StitchStream)
        result.each { |chunk| send_response(req['id'], chunk: chunk) }
        send_response(req['id'], result: {})
      else
        send_response(req['id'], result: result)
      end

      if debug
        log_entry = { dir: '←', id: req['id'], ok: true }
        traceparent = req['traceparent']
        log_entry[:traceparent] = traceparent if traceparent
        $stderr.puts JSON.generate(log_entry)
        $stderr.flush
      end
    rescue => e
      send_response(
        req&.fetch('id', nil),
        error: {
          message:   e.message,
          backtrace: e.full_message(highlight: false)
        }
      )
      if debug
        $stderr.puts JSON.generate({ dir: '←', id: req&.fetch('id', nil), ok: false })
        $stderr.flush
      end
    end
  end
end

# ── Hot-reload with Zeitwerk ──────────────────────────────────────────────────
#
# For long-running sidecars, use Zeitwerk to reload handler code on SIGHUP
# without stopping the process or dropping in-flight requests.
#
# Example (in your sidecar script):
#
#   require 'zeitwerk'
#   loader = Zeitwerk::Loader.new
#   loader.push_dir('./handlers')
#   loader.enable_reloading
#   loader.setup
#
#   Signal.trap('HUP') do
#     loader.reload
#     # Re-register handlers after reload:
#     HANDLERS.replace(build_handlers)
#     $stderr.puts JSON.generate({ level: 'info', msg: 'handlers reloaded' })
#   end
#
# On the client side, send SIGHUP to trigger reload:
#   Process.kill('HUP', bridge_pid)
#
# NOTE: Zeitwerk reloading is not thread-safe by default. Add a Mutex around
# handler dispatch if using concurrent request processing.
#
# NOTE: Not supported on Windows (no SIGHUP). Use a JSON-RPC `_reload` method
# as an alternative:
#   '_reload' => ->(_) { loader.reload; build_handlers.tap { |h| HANDLERS.replace(h) }; {} }
#
# ─────────────────────────────────────────────────────────────────────────────

# Install a SIGHUP handler that reloads Zeitwerk and rebuilds the handler table.
# @param loader [Zeitwerk::Loader] A configured Zeitwerk loader.
# @param handlers_table [Hash] The mutable HANDLERS hash to update after reload.
# @param rebuild [Proc] Called after reload to produce the new handlers hash.
def install_zeitwerk_reload(loader, handlers_table, &rebuild)
  Signal.trap('HUP') do
    loader.reload
    handlers_table.replace(rebuild.call)
    $stderr.puts JSON.generate({ level: 'info', msg: 'zeitwerk reload complete', pid: Process.pid })
  end
end
