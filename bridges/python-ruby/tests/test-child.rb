# frozen_string_literal: true
#
# Ghost-Bridge test child (Ruby sidecar).
# Spawned by tests/test-client.py.
#
# Methods
# -------
#   echo(msg)            → msg
#   add(a, b)            → a + b
#   raise_error(message) → error response
#   echo_b64(data)       → base64(data)
#   slow(seconds)        → "done" after sleeping

require 'json'
require 'base64'

$stdout.sync = true

# Watchdog: exit when parent closes stdin
watchdog = Thread.new do
  # The main loop consumes stdin; this thread watches for the pipe itself
  # to become broken/closed from underneath us.
  sleep
rescue Exception
  exit 0
end

%w[INT TERM].each { |s| trap(s) { exit 0 } }

def write_response(hash)
  $stdout.print(hash.to_json + "\n")
  $stdout.flush
end

METHODS = {
  'echo' => lambda { |p|
    msg = p.fetch('msg') { raise ArgumentError, "missing param: msg" }
    msg
  },

  'add' => lambda { |p|
    a = p.fetch('a') { raise ArgumentError, "missing param: a" }
    b = p.fetch('b') { raise ArgumentError, "missing param: b" }
    a + b
  },

  'raise_error' => lambda { |p|
    message = p.fetch('message', 'intentional test error')
    raise RuntimeError, message
  },

  'echo_b64' => lambda { |p|
    data = p.fetch('data') { raise ArgumentError, "missing param: data" }
    Base64.strict_encode64(data.to_s)
  },

  'slow' => lambda { |p|
    seconds = p.fetch('seconds', 0.5).to_f
    sleep(seconds)
    'done'
  },
}.freeze

# ── Ready sentinel ────────────────────────────────────────────────────────────
write_response({ ready: true })

# ── Main loop ─────────────────────────────────────────────────────────────────
while (line = $stdin.gets)
  line = line.strip
  next if line.empty?

  begin
    req = JSON.parse(line)
  rescue JSON::ParserError => e
    $stderr.puts "[test-child] parse error: #{e.message}"
    next
  end

  req_id = req['id']
  method = req['method']
  params = req['params'] || {}

  handler = METHODS[method]
  if handler.nil?
    write_response({ id: req_id, error: { code: -32_601, message: "Method not found: #{method}" } })
    next
  end

  begin
    result = handler.call(params)
    write_response({ id: req_id, result: result })
  rescue StandardError => e
    write_response({ id: req_id, error: { code: -32_000, message: e.message } })
  end
end

exit 0
