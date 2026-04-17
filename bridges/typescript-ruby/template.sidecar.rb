# [CLAUDE_BRIDGE_HEADER]
# Ghost-Bridge Ruby sidecar template
# Generated for bridge: [CLAUDE_BRIDGE_NAME]
# Do NOT edit — regenerate via Ghost-Bridge CLI

require_relative '../../shared/ruby_sidecar/sidecar_base'

# ── Handler registry ────────────────────────────────────────────────────────
# Populate this hash with method_name => lambda { |params| result_hash }
# Every handler receives the parsed `params` hash and MUST return a Hash.
# Raise any StandardError subclass to send a JSON-RPC error response.
HANDLERS = {
  # [CLAUDE_HANDLERS]
}.freeze

run_sidecar(HANDLERS)
