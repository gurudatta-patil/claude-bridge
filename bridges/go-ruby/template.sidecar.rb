# frozen_string_literal: true

require_relative '../../shared/ruby_sidecar/sidecar_base'

# ── Method registry ────────────────────────────────────────────────────────────
# Replace or extend these handler lambdas with your own logic.
# Each lambda receives the parsed params hash and must return a JSON-serialisable value.
HANDLERS = {
  # [CLAUDE_METHOD_HANDLERS]
  #
  # Example:
  #   'ping' => ->(params) { { pong: true } },
}.freeze

run_sidecar(HANDLERS)
