"""
test-client.py — manual smoke-test script that spawns the compiled test-child
binary and exercises every method.

Run:
    python tests/test-client.py

You must have already built the binary:
    cargo build --release --manifest-path tests/test-child/Cargo.toml
"""

from __future__ import annotations

import base64
import os
import sys
from pathlib import Path

# Allow importing the bridge from the parent directory.
sys.path.insert(0, str(Path(__file__).parent.parent))
from template_client import RustBridge, BridgeError, build_sidecar  # type: ignore

MANIFEST_DIR = Path(__file__).parent / "test-child"


def resolve_binary() -> Path:
    """Build (if needed) and return the path to the test-child binary."""
    binary = build_sidecar(MANIFEST_DIR, release=True)
    print(f"[test-client] binary: {binary}")
    return binary


def run_smoke_tests(bridge: RustBridge) -> None:
    # ---- echo ---------------------------------------------------------------
    result = bridge.call("echo", {"msg": "hello, Rust!"})
    assert result == "hello, Rust!", f"echo failed: {result!r}"
    print(f"[OK] echo -> {result!r}")

    # ---- add ----------------------------------------------------------------
    result = bridge.call("add", {"a": 7, "b": 35})
    assert result == 42, f"add failed: {result!r}"
    print(f"[OK] add  -> {result!r}")

    # ---- raise_error --------------------------------------------------------
    try:
        bridge.call("raise_error", {"code": 1234, "msg": "boom"})
        print("[FAIL] raise_error should have raised BridgeError")
        sys.exit(1)
    except BridgeError as exc:
        assert exc.code == 1234
        assert "boom" in exc.message
        print(f"[OK] raise_error -> BridgeError({exc.code}, {exc.message!r})")

    # ---- echo_b64 -----------------------------------------------------------
    raw = b"\x00\x01\x02\x03\xff\xfe"
    encoded = base64.b64encode(raw).decode()
    result = bridge.call("echo_b64", {"data": encoded})
    assert result == encoded, f"echo_b64 round-trip failed: {result!r}"
    print(f"[OK] echo_b64 -> {result!r}")

    # ---- slow ---------------------------------------------------------------
    result = bridge.call("slow", {"ms": 200}, timeout=5.0)
    assert result == "done", f"slow failed: {result!r}"
    print(f"[OK] slow  -> {result!r}")

    # ---- unknown method -----------------------------------------------------
    try:
        bridge.call("does_not_exist", {})
        print("[FAIL] unknown method should have raised BridgeError")
        sys.exit(1)
    except BridgeError as exc:
        assert exc.code == -32601
        print(f"[OK] unknown method -> BridgeError({exc.code}, {exc.message!r})")


def main() -> None:
    binary = resolve_binary()

    print("\n=== RustBridge smoke tests ===\n")
    with RustBridge(binary) as bridge:
        run_smoke_tests(bridge)

    print("\nAll smoke tests passed.")


if __name__ == "__main__":
    main()
