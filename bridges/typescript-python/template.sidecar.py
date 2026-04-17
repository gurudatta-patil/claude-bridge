"""
Ghost-Bridge – TypeScript → Python sidecar template.

Slot markers (replaced by the code-generation layer):
  [CLAUDE_IMPORTS_HERE]          – third-party / stdlib imports
  [CLAUDE_HANDLER_FUNCTIONS_HERE] – async-safe handler functions
  [CLAUDE_LOGIC_ROUTING_HERE]    – elif branches that route method → handler
"""

# ──────────────────────────────────────────────────────────────────────────────
# STDOUT DISCIPLINE — must happen before ANY third-party import.
# Redirect the real sys.stdout to stderr so that library print() calls never
# corrupt the JSON-RPC channel.  All RPC writes use the saved _rpc_out handle.
# ──────────────────────────────────────────────────────────────────────────────
import sys as _sys

_rpc_out = _sys.stdout          # save the real stdout for JSON-RPC writes
_sys.stdout = _sys.stderr       # redirect; library noise goes to stderr

# ──────────────────────────────────────────────────────────────────────────────
# [CLAUDE_IMPORTS_HERE]
# ──────────────────────────────────────────────────────────────────────────────


# ──────────────────────────────────────────────────────────────────────────────
# [CLAUDE_HANDLER_FUNCTIONS_HERE]
#
# Define your handler functions here.  Each function receives the "params"
# dict from the incoming request and should return a plain dict that will be
# sent back as "result".  Raise any Exception to propagate an error response.
#
# Example:
#
#   def handle_echo(params: dict) -> dict:
#       return params
#
# ──────────────────────────────────────────────────────────────────────────────


# ──────────────────────────────────────────────────────────────────────────────
# Handler registry — maps method names to callables.
# ──────────────────────────────────────────────────────────────────────────────

HANDLERS = {
    # [CLAUDE_LOGIC_ROUTING_HERE]
    #
    # Replace / extend this dict with your own handlers, e.g.:
    #   "echo": handle_echo,
    #   "add":  handle_add,
}

# ──────────────────────────────────────────────────────────────────────────────
# Entry-point — delegates all boilerplate to the shared sidecar base.
# ──────────────────────────────────────────────────────────────────────────────

import sys as _sys2
import os as _os
_sys2.path.insert(0, _os.path.join(_os.path.dirname(__file__), '..', '..', 'shared', 'python_sidecar'))
from sidecar_base import run_sidecar, set_rpc_out  # noqa: E402

set_rpc_out(_rpc_out)

if __name__ == "__main__":
    run_sidecar(HANDLERS)
