# frozen_string_literal: true

# Stitch — Ruby sidecar template
#
# Replace every [CLAUDE_*] placeholder before deploying:
#   [CLAUDE_METHOD_NAME]   — the JSON-RPC method this sidecar handles
#   [CLAUDE_METHOD_BODY]   — Ruby expression that produces the "result" value
#                            (receives `params` as a Hash with string keys)
#   [CLAUDE_EXTRA_REQUIRES] — additional require lines, or delete this section
#
# Protocol (newline-delimited JSON over stdio):
#   1. Write {"ready":true} immediately on startup.
#   2. Read requests line-by-line from $stdin.
#   3. Write a success or error response for every request.
#   4. Exit cleanly when $stdin is closed (EOF) or on SIGTERM/SIGINT.

require 'base64'
# [CLAUDE_EXTRA_REQUIRES]

require_relative '../../shared/ruby_sidecar/sidecar_base'

# ---------------------------------------------------------------------------
# Method dispatch
# [CLAUDE_METHOD_NAME] implementation lives here.
# ---------------------------------------------------------------------------

HANDLERS = {
  '[CLAUDE_METHOD_NAME]' => lambda do |params|
    # [CLAUDE_METHOD_BODY]
    # Example: return params  (echo)
    raise NotImplementedError, 'replace [CLAUDE_METHOD_BODY] with a real implementation'
  end,
}.freeze

run_sidecar(HANDLERS)
