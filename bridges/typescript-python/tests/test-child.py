"""
Stitch – test sidecar for TypeScript → Python bridge tests.

Implements:
  echo        – returns params unchanged
  add         – returns { sum: a + b }
  raise_error – raises ValueError (tests error propagation)
  echo_b64    – round-trips a Base64 payload
  slow        – sleeps params.ms milliseconds, returns { done: true }
"""

# ── stdout discipline ─────────────────────────────────────────────────────────
import sys as _sys

_rpc_out = _sys.stdout
_sys.stdout = _sys.stderr

# ── stdlib imports ─────────────────────────────────────────────────────────────
import base64 as _base64
import json as _json
import os as _os
import time as _time
import traceback as _traceback


# ── RPC helpers ───────────────────────────────────────────────────────────────

def _send(obj: dict) -> None:
    line = _json.dumps(obj, separators=(",", ":"), ensure_ascii=False) + "\n"
    _rpc_out.write(line)
    _rpc_out.flush()


def _send_result(req_id: str, result: dict) -> None:
    _send({"id": req_id, "result": result})


def _send_error(req_id: str, message: str, tb: str = "") -> None:
    _send({"id": req_id, "error": {"message": message, "traceback": tb}})


# ── Handlers ─────────────────────────────────────────────────────────────────

def handle_echo(params: dict) -> dict:
    """Return the params dict unchanged."""
    return params


def handle_add(params: dict) -> dict:
    """Add params.a and params.b, return {"sum": ...}."""
    a = params["a"]
    b = params["b"]
    return {"sum": a + b}


def handle_raise_error(params: dict) -> dict:
    """Deliberately raises a ValueError to test error propagation."""
    raise ValueError("deliberate test error")


def handle_echo_b64(params: dict) -> dict:
    """
    Round-trip a Base64 payload.
    Expects: { "data": "<base64 string>" }
    Returns: { "data": "<base64 string>" } (same bytes, re-encoded)
    """
    raw = _base64.b64decode(params["data"])
    return {"data": _base64.b64encode(raw).decode("ascii")}


def handle_slow(params: dict) -> dict:
    """Sleep for params.ms milliseconds, then return {"done": true}."""
    ms = float(params.get("ms", 0))
    _time.sleep(ms / 1_000.0)
    return {"done": True}


# ── Dispatcher ────────────────────────────────────────────────────────────────

def _dispatch(method: str, params: dict) -> dict:
    if method == "echo":
        return handle_echo(params)
    elif method == "add":
        return handle_add(params)
    elif method == "raise_error":
        return handle_raise_error(params)
    elif method == "echo_b64":
        return handle_echo_b64(params)
    elif method == "slow":
        return handle_slow(params)
    else:
        raise NotImplementedError(f"Unknown method: {method!r}")


# ── Main ─────────────────────────────────────────────────────────────────────

def main() -> None:
    _send({"ready": True})

    for raw_line in _sys.stdin:
        line = raw_line.strip()
        if not line:
            continue

        req_id = "<unknown>"
        try:
            msg = _json.loads(line)
            req_id = msg.get("id", req_id)
            method: str = msg["method"]
            params: dict = msg.get("params", {})
            result = _dispatch(method, params)
            _send_result(req_id, result)
        except _json.JSONDecodeError as exc:
            _send_error(req_id, f"JSON parse error: {exc}")
        except NotImplementedError as exc:
            _send_error(req_id, str(exc))
        except Exception as exc:
            tb = _traceback.format_exc()
            _send_error(req_id, str(exc), tb)

    # stdin reached EOF — parent closed the pipe or died.
    _os._exit(0)


if __name__ == "__main__":
    main()
