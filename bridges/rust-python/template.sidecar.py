"""
Ghost-Bridge — Python sidecar template.

Replace every section marked TODO with your own logic.

Protocol
--------
- On startup, write {"ready":true} to stdout BEFORE any other output.
- Read newline-delimited JSON requests from stdin.
- Write newline-delimited JSON replies to stdout.
- Exit cleanly when stdin reaches EOF.

Request format:  {"id":"<uuid>","method":"<name>","params":{...}}
Success reply:   {"id":"<uuid>","result":<any>}
Error reply:     {"id":"<uuid>","error":{"code":<int>,"message":"<str>"}}

Important: stdout is redirected to stderr BEFORE imports so that any
accidental print() calls in library code do not corrupt the JSON stream.
"""

# ── stdout redirect MUST be first ────────────────────────────────────────────
import sys
_rpc_out = sys.stdout          # keep the real stdout for RPC replies
sys.stdout = sys.stderr        # swallow stray prints into the log stream

# ── stdlib imports (after redirect) ──────────────────────────────────────────
import os

# TODO: add your own imports here (they are safe after the redirect above)


# ── Method registry ───────────────────────────────────────────────────────────
# Register handlers here.  Each handler receives a dict `params` and
# returns a JSON-serialisable value, or raises an exception.

def _handle_echo(params: dict):
    """TODO: replace with your own logic or remove."""
    return {"echo": params.get("message", "")}


def _handle_ping(_params: dict):
    return "pong"


# TODO: register additional methods here.
_HANDLERS: dict = {
    "echo": _handle_echo,
    "ping": _handle_ping,
}

# ── Entry-point — delegates all boilerplate to the shared sidecar base ────────

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..', 'shared', 'python_sidecar'))
from sidecar_base import run_sidecar, set_rpc_out  # noqa: E402

set_rpc_out(_rpc_out)

if __name__ == "__main__":
    run_sidecar(_HANDLERS)
