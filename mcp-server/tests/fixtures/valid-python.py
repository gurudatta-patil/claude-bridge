import sys as _sys

_rpc_out = _sys.stdout
_sys.stdout = _sys.stderr

import logging
logging.disable(logging.CRITICAL)

import json as _json
import os as _os
import threading as _threading
import traceback as _traceback


def handle_echo(params: dict) -> dict:
    return params


def handle_add(params: dict) -> dict:
    return {"sum": params["a"] + params["b"]}


HANDLERS = {
    "echo": handle_echo,
    "add": handle_add,
}


def main() -> None:
    def _watchdog():
        raw = _sys.stdin.buffer if hasattr(_sys.stdin, "buffer") else _sys.stdin
        while True:
            if raw.read(1) == b"":
                _os._exit(0)

    t = _threading.Thread(target=_watchdog, daemon=True)
    t.start()

    _rpc_out.write('{"ready":true}\n')
    _rpc_out.flush()

    for line in _sys.stdin:
        line = line.strip()
        if not line:
            continue
        req_id = "<unknown>"
        try:
            msg = _json.loads(line)
            req_id = msg.get("id", req_id)
            result = HANDLERS[msg["method"]](msg.get("params", {}))
            _rpc_out.write(_json.dumps({"id": req_id, "result": result}) + "\n")
            _rpc_out.flush()
        except Exception as exc:
            tb = _traceback.format_exc()
            _rpc_out.write(_json.dumps({"id": req_id, "error": {"message": str(exc), "traceback": tb}}) + "\n")
            _rpc_out.flush()


if __name__ == "__main__":
    main()
