# frozen_string_literal: true
#
# Ghost-Bridge: Ruby sidecar template.
#
# Replace every [CLAUDE_*] placeholder with your own logic, then drop this
# file next to your project and run it as the child process of a RubyBridge
# Python client.

require_relative '../../shared/ruby_sidecar/sidecar_base'

# ── Method registry ──────────────────────────────────────────────────────────
#
# Add your methods here.  Each handler receives the `params` hash and must
# return a value that is JSON-serialisable.  Raise StandardError (or any
# subclass) to send an error response back to the client.
#
# [CLAUDE_METHOD_REGISTRY_START]

METHODS = {
  # ── built-in example: echo ─────────────────────────────────────────────
  # "echo" => ->(params) { params["msg"] },

  # [CLAUDE_CUSTOM_METHODS]
  # Replace the line above with your own lambdas, e.g.:
  #
  #   "greet" => ->(params) { "Hello, #{params.fetch('name', 'world')}!" },
  #
  #   "add"   => ->(params) { params.fetch('a') + params.fetch('b') },
}.freeze

# [CLAUDE_METHOD_REGISTRY_END]

run_sidecar(METHODS)
