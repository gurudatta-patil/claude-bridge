# frozen_string_literal: true

# Ghost-Bridge — test child sidecar (real implementation, no placeholders)
#
# Methods exposed:
#   echo         { value: <any> }             → { value: <any> }
#   add          { a: <num>, b: <num> }       → { sum: <num> }
#   raise_error  { message: <str> }           → JSON-RPC error -32603
#   echo_b64     { data: <base64-str> }       → { decoded: <str>, reencoded: <base64-str> }
#   slow         { ms: <int> }                → { slept_ms: <int> }  (sleeps ms milliseconds)

$stdout.sync = true
$stderr.sync = true

require 'json'
require 'base64'

# ---------------------------------------------------------------------------
# Signal traps
# ---------------------------------------------------------------------------

shutdown = false
shutdown_mu = Mutex.new

Signal.trap('TERM') { shutdown_mu.synchronize { shutdown = true } }
Signal.trap('INT')  { shutdown_mu.synchronize { shutdown = true } }

# Watchdog — exits if idle for more than 30 s (safety net for the test suite)
last_ts_mu = Mutex.new
last_ts    = Time.now

Thread.new do
  loop do
    sleep 5
    idle = last_ts_mu.synchronize { Time.now - last_ts }
    if idle > 30
      $stderr.puts '[test-child] watchdog timeout — exiting'
      exit 1
    end
  end
end

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def build_success(id, result)
  JSON.generate({ jsonrpc: '2.0', id: id, result: result })
end

def build_error(id, code, message, data: nil)
  err = { code: code, message: message }
  err[:data] = data unless data.nil?
  JSON.generate({ jsonrpc: '2.0', id: id, error: err })
end

# ---------------------------------------------------------------------------
# Dispatch
# ---------------------------------------------------------------------------

def dispatch(method, params)
  case method
  when 'echo'
    { 'value' => params['value'] }

  when 'add'
    a = Float(params.fetch('a') { raise ArgumentError, 'missing param: a' })
    b = Float(params.fetch('b') { raise ArgumentError, 'missing param: b' })
    { 'sum' => a + b }

  when 'raise_error'
    msg = params.fetch('message', 'deliberate test error')
    raise RuntimeError, msg

  when 'echo_b64'
    encoded = params.fetch('data') { raise ArgumentError, 'missing param: data' }
    decoded = Base64.strict_decode64(encoded).force_encoding('UTF-8')
    { 'decoded' => decoded, 'reencoded' => Base64.strict_encode64(decoded) }

  when 'slow'
    ms = Integer(params.fetch('ms', 100))
    sleep(ms / 1000.0)
    { 'slept_ms' => ms }

  else
    raise NoMethodError, "unknown method: #{method}"
  end
end

# ---------------------------------------------------------------------------
# Ready handshake
# ---------------------------------------------------------------------------

$stdout.puts JSON.generate({ ready: true })

# ---------------------------------------------------------------------------
# Main loop
# ---------------------------------------------------------------------------

$stdin.each_line do |raw|
  last_ts_mu.synchronize { last_ts = Time.now }
  break if shutdown_mu.synchronize { shutdown }

  raw = raw.chomp
  next if raw.empty?

  req = nil
  begin
    req    = JSON.parse(raw)
    id     = req['id']
    method = req['method']
    params = req['params'] || {}

    result = dispatch(method, params)
    $stdout.puts build_success(id, result)

  rescue JSON::ParserError => e
    $stdout.puts build_error(nil, -32_700, "Parse error: #{e.message}")
  rescue NoMethodError => e
    $stdout.puts build_error(req&.fetch('id', nil), -32_601, e.message)
  rescue ArgumentError => e
    $stdout.puts build_error(req&.fetch('id', nil), -32_602, "Invalid params: #{e.message}")
  rescue => e
    $stderr.puts e.full_message(highlight: false)
    $stdout.puts build_error(req&.fetch('id', nil), -32_603, e.message)
  end
end

$stderr.puts '[test-child] stdin EOF — exiting'
