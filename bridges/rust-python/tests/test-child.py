"""
Stitch — test sidecar for the Rust test-runner.

Methods
-------
echo(message)         → {"echo": message}
add(a, b)             → {"sum": a + b}
raise_error(message)  → RPC error -32603
echo_b64(data)        → {"b64": base64(data)}
slow(seconds)         → {"slept": seconds}  (sleeps before replying)
"""

# stdout redirect MUST happen before any other import
import sys
_rpc_out = sys.stdout
sys.stdout = sys.stderr

import base64
import json
import os
import signal
import threading
import time


# ── Watchdog ──────────────────────────────────────────────────────────────────

def _watchdog() -> None:
    try:
        sys.stdin.read()
    except Exception:
        pass
    finally:
        os.kill(os.getpid(), signal.SIGTERM)


threading.Thread(target=_watchdog, daemon=True).start()


# ── RPC helpers ───────────────────────────────────────────────────────────────

def _send(obj: dict) -> None:
    _rpc_out.write(json.dumps(obj) + "\n")
    _rpc_out.flush()


def _ok(req_id: str, result) -> None:
    _send({"id": req_id, "result": result})


def _err(req_id: str, code: int, msg: str) -> None:
    _send({"id": req_id, "error": {"code": code, "message": msg}})


# ── Handlers ──────────────────────────────────────────────────────────────────

def handle_echo(p: dict):
    return {"echo": p.get("message", "")}


def handle_add(p: dict):
    a = p["a"]
    b = p["b"]
    return {"sum": a + b}


def handle_raise_error(p: dict):
    msg = p.get("message", "intentional test error")
    raise RuntimeError(msg)


def handle_echo_b64(p: dict):
    data = p.get("data", "")
    encoded = base64.b64encode(data.encode()).decode()
    return {"b64": encoded}


def handle_slow(p: dict):
    seconds = float(p.get("seconds", 1.0))
    time.sleep(seconds)
    return {"slept": seconds}


HANDLERS = {
    "echo":        handle_echo,
    "add":         handle_add,
    "raise_error": handle_raise_error,
    "echo_b64":    handle_echo_b64,
    "slow":        handle_slow,
}


# ── Main loop ─────────────────────────────────────────────────────────────────

def main() -> None:
    _send({"ready": True})

    for raw in sys.stdin:
        raw = raw.strip()
        if not raw:
            continue
        try:
            req = json.loads(raw)
        except json.JSONDecodeError as exc:
            print(f"[test-child] bad JSON: {exc}", file=sys.stderr)
            continue

        req_id = req.get("id", "")
        method = req.get("method", "")
        params = req.get("params") or {}

        handler = HANDLERS.get(method)
        if handler is None:
            _err(req_id, -32601, f"Method not found: {method!r}")
            continue

        try:
            _ok(req_id, handler(params))
        except Exception as exc:  # noqa: BLE001
            _err(req_id, -32603, str(exc))


if __name__ == "__main__":
    main()
