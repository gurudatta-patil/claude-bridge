"""
test-client.py — minimal manual smoke-test that spawns the compiled Go test-child
binary and exercises each method once.

Run
---
    # 1. build the sidecar first
    cd tests/test-child && go build -o ../test-child-bin .
    # 2. run this script
    python bridges/python-go/tests/test-client.py
"""
from __future__ import annotations

import base64
import os
import sys
import time

# Allow running from the repo root without installing anything
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from template_client import GoBridge, GoBridgeError  # type: ignore

BINARY = os.path.join(os.path.dirname(__file__), "test-child-bin")
if sys.platform == "win32":
    BINARY += ".exe"


def _sep(title: str) -> None:
    print(f"\n{'─' * 60}")
    print(f"  {title}")
    print("─" * 60)


def main() -> None:
    if not os.path.exists(BINARY):
        print(f"ERROR: binary not found at {BINARY}")
        print("Build it first:  cd tests/test-child && go build -o ../test-child-bin .")
        sys.exit(1)

    with GoBridge(BINARY) as bridge:
        # ------------------------------------------------------------------ echo
        _sep("echo")
        result = bridge.call("echo", {"message": "hello, Go!"})
        print(f"echo result: {result!r}")
        assert result == "hello, Go!", f"unexpected: {result!r}"

        # ------------------------------------------------------------------ add
        _sep("add")
        result = bridge.call("add", {"a": 7, "b": 35})
        print(f"add result: {result!r}")
        assert result == 42, f"unexpected: {result!r}"

        # ------------------------------------------------------------------ echo_b64
        _sep("echo_b64")
        payload = "binary\x00data\xff"
        encoded = base64.b64encode(payload.encode("latin-1")).decode()
        result = bridge.call("echo_b64", {"data": encoded})
        print(f"echo_b64 result: {result!r}")
        decoded = base64.b64decode(result).decode("latin-1")
        assert decoded == payload, f"unexpected: {decoded!r}"

        # ------------------------------------------------------------------ slow
        _sep("slow (1 s sleep)")
        t0 = time.monotonic()
        result = bridge.call("slow", {"seconds": 1}, timeout=5.0)
        elapsed = time.monotonic() - t0
        print(f"slow result: {result!r}  (elapsed: {elapsed:.2f}s)")
        assert elapsed >= 0.9, f"too fast: {elapsed:.2f}s"

        # ------------------------------------------------------------------ raise_error
        _sep("raise_error")
        try:
            bridge.call("raise_error", {"message": "intentional test error"})
            print("ERROR: expected GoBridgeError but got nothing")
            sys.exit(1)
        except GoBridgeError as exc:
            print(f"Got expected GoBridgeError: code={exc.code} message={exc.message!r}")
            assert exc.code == 42
            assert "intentional test error" in exc.message

    print("\n✓ All smoke tests passed.")


if __name__ == "__main__":
    main()
