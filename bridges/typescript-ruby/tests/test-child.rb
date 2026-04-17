# Ghost-Bridge — Ruby test sidecar
# Used by ts-ruby.test.ts to exercise the full JSON-RPC bridge.

$stdout.sync = true
$stderr.sync = true

require 'json'
require 'base64'

Signal.trap('TERM') { exit 0 }
Signal.trap('INT')  { exit 0 }

# Stdin-EOF watchdog — exits when parent closes stdin
Thread.new do
  loop { break if $stdin.read(1).nil? }
  exit 0
end

HANDLERS = {
  # Return params unchanged
  'echo' => ->(params) { params },

  # Add two numbers
  'add' => lambda { |params|
    a = params['a']
    b = params['b']
    raise ArgumentError, "params 'a' and 'b' must be numeric" unless a.is_a?(Numeric) && b.is_a?(Numeric)
    { 'sum' => a + b }
  },

  # Deliberately raise a RuntimeError so tests can verify error bubbling
  'raise_error' => lambda { |params|
    message = params['message'] || 'intentional test error'
    raise RuntimeError, message
  },

  # Base64 round-trip: encode a string, return the encoded value and decoded confirmation
  'echo_b64' => lambda { |params|
    input = params['input'].to_s
    encoded = Base64.strict_encode64(input)
    decoded = Base64.strict_decode64(encoded)
    { 'encoded' => encoded, 'decoded' => decoded }
  },

  # Sleep for params['ms'] milliseconds then return {done: true}
  'slow' => lambda { |params|
    ms = params['ms']
    raise ArgumentError, "params 'ms' must be numeric" unless ms.is_a?(Numeric)
    sleep(ms / 1000.0)
    { 'done' => true }
  },
}.freeze

# Ready signal — parent blocks until it reads this line
$stdout.puts JSON.generate({ ready: true })

# JSON-RPC main loop
$stdin.each_line do |line|
  line = line.strip
  next if line.empty?

  begin
    req    = JSON.parse(line)
    method = req['method']
    params = req['params'] || {}

    handler = HANDLERS[method]
    raise NoMethodError, "Unknown method: #{method.inspect}" if handler.nil?

    result = handler.call(params)
    $stdout.puts JSON.generate({ id: req['id'], result: result })
  rescue => e
    $stdout.puts JSON.generate({
      id:    req&.fetch('id', nil),
      error: {
        message:   e.message,
        backtrace: e.full_message
      }
    })
  end
end
