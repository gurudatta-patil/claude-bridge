"""
Stitch — shared Python sidecar base.

All Python sidecars (typescript-python, go-python, rust-python) call
`run_sidecar(handlers)` from this module rather than duplicating the
stdout-redirect discipline, watchdog thread, and main JSON-RPC loop.

Import pattern in a sidecar template:
    import sys as _sys
    _rpc_out = _sys.stdout
    _sys.stdout = _sys.stderr
    # ... then at the bottom:
    from stitch_sidecar import run_sidecar
    run_sidecar(HANDLERS)

NOTE: The stdout redirect MUST happen before any other import, which is why
the sidecar template files do it themselves at the top.  This module sets it
up again only if it has not already been done (i.e. if _rpc_out is not yet
defined in the caller's globals).
"""

import io as _io
import json as _json
import os as _os
import sys as _sys
import traceback as _traceback

# ─────────────────────────────────────────────────────────────────────────────
# RPC output handle
#
# When a sidecar template imports this module it has already redirected
# sys.stdout → sys.stderr and saved the real stdout in _rpc_out.  We look
# for _rpc_out in the caller's global namespace via the import mechanism.
# For the shared base we just keep a module-level reference that templates
# set explicitly, or fall back to the current sys.stdout (which the template
# should have redirected to the real stdout pipe before calling run_sidecar).
# ─────────────────────────────────────────────────────────────────────────────

# The template sets _rpc_out before importing this module.  We expose a
# setter so it can be injected.
_rpc_handle: _io.TextIOWrapper | None = None


def set_rpc_out(handle) -> None:
    """Point the sidecar base at the real stdout handle saved by the template."""
    global _rpc_handle
    _rpc_handle = handle


def _get_rpc_out():
    """Return the RPC output handle, falling back to the original sys.stdout."""
    if _rpc_handle is not None:
        return _rpc_handle
    # If the template called `_sys.stdout = _sys.stderr` the saved handle is
    # wherever the template stored it.  As a last resort use stderr so we at
    # least see the output somewhere.
    return _sys.__stdout__


# ─────────────────────────────────────────────────────────────────────────────
# RPC I/O helpers
# ─────────────────────────────────────────────────────────────────────────────

def _send(obj: dict) -> None:
    """Serialise *obj* as a newline-terminated JSON line on the RPC channel."""
    line = _json.dumps(obj, separators=(",", ":"), ensure_ascii=False) + "\n"
    out = _get_rpc_out()
    out.write(line)
    out.flush()


def _send_result(req_id: str, result) -> None:
    _send({"id": req_id, "result": result})


def _send_error(req_id: str, message: str, tb: str = "") -> None:
    _send({"id": req_id, "error": {"message": message, "traceback": tb}})


# ─────────────────────────────────────────────────────────────────────────────
# Main sidecar loop
# ─────────────────────────────────────────────────────────────────────────────

def run_sidecar(handlers: dict) -> None:
    """
    Run the JSON-RPC sidecar main loop.

    Parameters
    ----------
    handlers:
        Mapping of method name → callable.  Each callable receives a ``dict``
        of params and must return a JSON-serialisable value, or raise an
        exception to send an error response.

    This function blocks until stdin is closed (parent process exit).

    Example::

        def handle_echo(params):
            return params

        run_sidecar({"echo": handle_echo})

    Note on zombie-prevention: rather than a competing watchdog thread that
    races with readline() for the BufferedReader lock, we rely on the fact
    that ``for raw_line in sys.stdin`` exits when stdin reaches EOF (parent
    closed the pipe).  We call ``os._exit(0)`` after the loop — no separate
    thread needed, no race condition possible.
    """
    # 1. Signal readiness.  The parent waits for this line before sending
    #    the first request.
    _send({"ready": True})

    # 2. Line-by-line JSON-RPC loop.  Exits cleanly when stdin is closed.
    for raw_line in _sys.stdin:
        line = raw_line.strip()
        if not line:
            continue

        req_id: str = "<unknown>"
        try:
            msg = _json.loads(line)
            req_id = msg.get("id", req_id)
            method: str = msg["method"]
            params: dict = msg.get("params") or {}

            handler = handlers.get(method)
            if handler is None:
                _send_error(req_id, f"Unknown method: {method!r}")
                continue

            result = handler(params)
            _send_result(req_id, result)

        except _json.JSONDecodeError as exc:
            _send_error(req_id, f"JSON parse error: {exc}")
        except Exception as exc:
            tb = _traceback.format_exc()
            _send_error(req_id, str(exc), tb)

    # 3. stdin reached EOF — parent closed the pipe or died.  Exit cleanly.
    _os._exit(0)
