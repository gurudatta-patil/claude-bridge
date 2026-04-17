# frozen_string_literal: true

$stdout.sync = true
$stderr.sync = true

require 'json'
require 'base64'

# ── Signal handlers ────────────────────────────────────────────────────────────
Signal.trap('TERM') { exit 0 }
Signal.trap('INT')  { exit 0 }

# ── EOF watchdog ───────────────────────────────────────────────────────────────
Thread.new { loop { break if $stdin.read(1).nil? }; exit 0 }

# ── Helpers ────────────────────────────────────────────────────────────────────
def send_response(hash)
  $stdout.print(hash.to_json + "\n")
  $stdout.flush
end

def send_result(id, result)
  send_response({ id: id, result: result })
end

def send_error(id, message, backtrace = '')
  send_response({ id: id, error: { message: message, backtrace: backtrace } })
end

# ── Method handlers ────────────────────────────────────────────────────────────

# echo — returns params[:text] unchanged.
def handle_echo(params)
  { text: params['text'] }
end

# add — sums two numbers a and b.
def handle_add(params)
  a = params['a']
  b = params['b']
  raise ArgumentError, "params 'a' and 'b' must be numeric" unless a.is_a?(Numeric) && b.is_a?(Numeric)
  { sum: a + b }
end

# raise_error — always raises with the provided message, useful for testing
# error propagation across the bridge.
def handle_raise_error(params)
  msg = params['msg'] || 'test error'
  raise RuntimeError, msg
end

# echo_b64 — decodes a Base64-encoded string, then re-encodes it.
# Useful for validating binary-safe round-trips.
def handle_echo_b64(params)
  encoded = params['data'] || ''
  decoded = Base64.strict_decode64(encoded)
  { decoded: decoded, re_encoded: Base64.strict_encode64(decoded) }
end

# slow — sleeps for `ms` milliseconds, then echoes the duration.
# Used by concurrency tests to verify pipelined calls are not serialised on
# the Go side.
def handle_slow(params)
  ms = (params['ms'] || 100).to_i
  sleep(ms / 1000.0)
  { slept_ms: ms }
end

HANDLERS = {
  'echo'        => method(:handle_echo),
  'add'         => method(:handle_add),
  'raise_error' => method(:handle_raise_error),
  'echo_b64'    => method(:handle_echo_b64),
  'slow'        => method(:handle_slow),
}.freeze

# ── Ready signal ───────────────────────────────────────────────────────────────
send_response({ ready: true })

# ── Main loop ──────────────────────────────────────────────────────────────────
$stdin.each_line do |raw|
  msg = nil
  begin
    msg    = JSON.parse(raw.chomp)
    id     = msg['id']
    method = msg['method']
    params = msg['params'] || {}

    handler = HANDLERS[method]
    if handler.nil?
      send_error(id, "unknown method: #{method}")
      next
    end

    result = handler.call(params)
    send_result(id, result)
  rescue => e
    send_error(
      (msg&.fetch('id', nil) rescue nil),
      e.message,
      e.backtrace&.join("\n").to_s
    )
  end
end
