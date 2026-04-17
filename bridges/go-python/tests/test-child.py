"""
test-child.py — Stitch test sidecar for the Go → Python bridge.

Methods exposed
---------------
echo          {"msg": str}                → {"echo": str}
add           {"a": number, "b": number}  → {"sum": number}
raise_error   {}                          → RPC error response
echo_b64      {"data": str}              → {"data": str}  (round-trip base64)
slow          {"ms": int}                 → {"slept_ms": int}
"""
import sys
_rpc_out = sys.stdout
sys.stdout = sys.stderr

import base64
import json
import logging
import os
import threading
import time
import traceback

logging.disable(logging.CRITICAL)

# ---------------------------------------------------------------------------
# Watchdog
# ---------------------------------------------------------------------------

def _stdin_watchdog() -> None:
    sys.stdin.read()
    os._exit(0)

threading.Thread(target=_stdin_watchdog, daemon=True).start()

# ---------------------------------------------------------------------------
# Handlers
# ---------------------------------------------------------------------------

def _handle_echo(params: dict):
    return {"echo": params.get("msg", "")}


def _handle_add(params: dict):
    a = params["a"]
    b = params["b"]
    return {"sum": a + b}


def _handle_raise_error(params: dict):
    raise ValueError("intentional test error from Python sidecar")


def _handle_echo_b64(params: dict):
    # Round-trip: decode then re-encode to prove we touched it.
    raw = base64.b64decode(params["data"])
    return {"data": base64.b64encode(raw).decode()}


def _handle_slow(params: dict):
    ms = int(params.get("ms", 100))
    time.sleep(ms / 1000.0)
    return {"slept_ms": ms}


HANDLERS = {
    "echo": _handle_echo,
    "add": _handle_add,
    "raise_error": _handle_raise_error,
    "echo_b64": _handle_echo_b64,
    "slow": _handle_slow,
}

# ---------------------------------------------------------------------------
# RPC machinery
# ---------------------------------------------------------------------------

def _send(obj: dict) -> None:
    _rpc_out.write(json.dumps(obj) + "\n")
    _rpc_out.flush()


def _dispatch(line: str) -> None:
    try:
        req = json.loads(line)
    except json.JSONDecodeError as exc:
        print(f"[test-child] JSON parse error: {exc}", file=sys.stderr)
        return

    req_id = req.get("id", "")
    method = req.get("method", "")
    params = req.get("params") or {}

    handler = HANDLERS.get(method)
    if handler is None:
        _send({
            "id": req_id,
            "error": {"message": f"Unknown method: {method!r}", "traceback": ""},
        })
        return

    try:
        result = handler(params)
        _send({"id": req_id, "result": result})
    except Exception as exc:
        _send({
            "id": req_id,
            "error": {"message": str(exc), "traceback": traceback.format_exc()},
        })


def main() -> None:
    _send({"ready": True})
    for raw_line in sys.stdin:
        line = raw_line.strip()
        if not line:
            continue
        _dispatch(line)


if __name__ == "__main__":
    main()
