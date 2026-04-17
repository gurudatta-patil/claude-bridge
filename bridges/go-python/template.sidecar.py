"""
template.sidecar.py — Ghost-Bridge: Python (target) sidecar template.

HOW TO USE
----------
1. Copy this file into your project and rename it (e.g. sidecar.py).
2. Replace every section marked  # ← IMPLEMENT  with your own logic.
3. The dispatch table ``HANDLERS`` maps method names to callables.
   Each handler receives a dict (params) and must return a JSON-serialisable value.
   Raise any Exception to send an error response back to the caller.

RULES (do not remove)
---------------------
- _rpc_out / stdout redirect MUST stay as the very first executable lines.
- logging.disable keeps Python's internal noise off the RPC channel.
- The watchdog thread ensures the sidecar exits when the parent Go process dies.
- Ready signal MUST be emitted before entering the request loop.
"""

# ---------------------------------------------------------------------------
# 0. Redirect stdout → stderr BEFORE any other import so that stray prints
#    never corrupt the RPC channel.
# ---------------------------------------------------------------------------
import sys
_rpc_out = sys.stdout          # the real stdout used for JSON-RPC
sys.stdout = sys.stderr        # everything else (print, tracebacks) → stderr

# ---------------------------------------------------------------------------
# 1. Standard imports (safe now that stdout is redirected)
# ---------------------------------------------------------------------------
import logging
import os

# Silence ALL Python logging — nothing must leak onto the RPC channel.
logging.disable(logging.CRITICAL)

# ---------------------------------------------------------------------------
# 2. PLACEHOLDER — import your own modules here
# ---------------------------------------------------------------------------
# Example:
#   import numpy as np
#   from mypackage import heavy_model
# ← IMPLEMENT (or leave empty)

# ---------------------------------------------------------------------------
# 3. Handler registry
# ---------------------------------------------------------------------------

def _handle_echo(params: dict):
    """Built-in smoke-test handler.  Remove or override in your project."""
    return {"echo": params.get("msg", "")}


# ← IMPLEMENT: add your own handlers below and register them in HANDLERS.
#
# def _handle_my_method(params: dict):
#     value = params["input"]
#     result = do_something(value)
#     return {"output": result}


HANDLERS: dict = {
    "echo": _handle_echo,
    # "my_method": _handle_my_method,   # ← IMPLEMENT
}

# ---------------------------------------------------------------------------
# 4. Entry-point — delegates all boilerplate to the shared sidecar base.
# ---------------------------------------------------------------------------

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..', 'shared', 'python_sidecar'))
from sidecar_base import run_sidecar, set_rpc_out  # noqa: E402

set_rpc_out(_rpc_out)

if __name__ == "__main__":
    run_sidecar(HANDLERS)
