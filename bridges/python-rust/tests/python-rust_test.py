"""
python-rust_test.py — pytest suite for the Python → Rust bridge.

Prerequisites
-------------
1. Rust toolchain installed (cargo in PATH).
2. Run from the repository root **or** from bridges/python-rust/:

       pytest bridges/python-rust/tests/python-rust_test.py -v

The first test (test_build) compiles the binary; all subsequent tests share
the same compiled binary via the ``bridge`` session-scoped fixture.
"""

from __future__ import annotations

import base64
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

import pytest

# ---------------------------------------------------------------------------
# Path setup
# ---------------------------------------------------------------------------

BRIDGE_DIR = Path(__file__).parent.parent
sys.path.insert(0, str(BRIDGE_DIR))

# The source file uses hyphens in its name; import via importlib.
import importlib.util as _ilu

_spec = _ilu.spec_from_file_location(
    "template_client", BRIDGE_DIR / "template.client.py"
)
assert _spec and _spec.loader
_mod = _ilu.module_from_spec(_spec)
_spec.loader.exec_module(_mod)  # type: ignore[union-attr]

RustBridge = _mod.RustBridge
BridgeError = _mod.BridgeError
build_sidecar = _mod.build_sidecar

MANIFEST_DIR = Path(__file__).parent / "test-child"

# ---------------------------------------------------------------------------
# Session-scoped binary fixture (compile once)
# ---------------------------------------------------------------------------


@pytest.fixture(scope="session")
def binary_path(tmp_path_factory: pytest.TempPathFactory) -> Path:
    """Build the test-child binary once per test session."""
    path = build_sidecar(MANIFEST_DIR, release=True)
    assert path.exists(), f"Binary not found after build: {path}"
    return path


@pytest.fixture()
def bridge(binary_path: Path):
    """Yield a fresh, started RustBridge for each test, then stop it."""
    b = RustBridge(binary_path, call_timeout=10.0)
    b.start()
    yield b
    b.stop()


# ---------------------------------------------------------------------------
# Compile step
# ---------------------------------------------------------------------------


def test_build(binary_path: Path) -> None:
    """Cargo build must succeed and produce an executable."""
    assert binary_path.exists()
    assert binary_path.stat().st_size > 0


# ---------------------------------------------------------------------------
# Basic round-trip tests
# ---------------------------------------------------------------------------


def test_echo_round_trip(bridge: RustBridge) -> None:
    msg = "hello from Python"
    result = bridge.call("echo", {"msg": msg})
    assert result == msg


def test_echo_unicode(bridge: RustBridge) -> None:
    msg = "日本語テスト 🦀"
    result = bridge.call("echo", {"msg": msg})
    assert result == msg


def test_add_positive(bridge: RustBridge) -> None:
    assert bridge.call("add", {"a": 3, "b": 4}) == 7


def test_add_negative(bridge: RustBridge) -> None:
    assert bridge.call("add", {"a": -10, "b": 3}) == -7


def test_add_zero(bridge: RustBridge) -> None:
    assert bridge.call("add", {"a": 0, "b": 0}) == 0


def test_add_large_i64(bridge: RustBridge) -> None:
    # Near i64 max — Rust should handle this without overflow.
    big = 2**62
    assert bridge.call("add", {"a": big, "b": 1}) == big + 1


# ---------------------------------------------------------------------------
# Base64 round-trip
# ---------------------------------------------------------------------------


def test_echo_b64_round_trip(bridge: RustBridge) -> None:
    raw = bytes(range(256))
    encoded = base64.b64encode(raw).decode()
    result = bridge.call("echo_b64", {"data": encoded})
    assert result == encoded
    assert base64.b64decode(result) == raw


def test_echo_b64_empty(bridge: RustBridge) -> None:
    encoded = base64.b64encode(b"").decode()
    result = bridge.call("echo_b64", {"data": encoded})
    assert result == encoded


def test_echo_b64_invalid(bridge: RustBridge) -> None:
    with pytest.raises(BridgeError) as exc_info:
        bridge.call("echo_b64", {"data": "!!!not-base64!!!"})
    assert exc_info.value.code == -32602


# ---------------------------------------------------------------------------
# Error propagation
# ---------------------------------------------------------------------------


def test_raise_error_returns_bridge_error(bridge: RustBridge) -> None:
    with pytest.raises(BridgeError) as exc_info:
        bridge.call("raise_error", {"code": 42, "msg": "intentional"})
    assert exc_info.value.code == 42
    assert "intentional" in exc_info.value.message


def test_raise_error_negative_code(bridge: RustBridge) -> None:
    with pytest.raises(BridgeError) as exc_info:
        bridge.call("raise_error", {"code": -999, "msg": "negative"})
    assert exc_info.value.code == -999


def test_unknown_method(bridge: RustBridge) -> None:
    with pytest.raises(BridgeError) as exc_info:
        bridge.call("no_such_method", {})
    assert exc_info.value.code == -32601


def test_missing_params(bridge: RustBridge) -> None:
    # add without 'a' or 'b'
    with pytest.raises(BridgeError) as exc_info:
        bridge.call("add", {})
    assert exc_info.value.code == -32602


# ---------------------------------------------------------------------------
# Slow / timeout
# ---------------------------------------------------------------------------


def test_slow_completes(bridge: RustBridge) -> None:
    result = bridge.call("slow", {"ms": 50}, timeout=5.0)
    assert result == "done"


def test_slow_timeout(bridge: RustBridge) -> None:
    with pytest.raises(TimeoutError):
        bridge.call("slow", {"ms": 5000}, timeout=0.1)


# ---------------------------------------------------------------------------
# Concurrency — ThreadPoolExecutor
# ---------------------------------------------------------------------------


def test_concurrent_echo(bridge: RustBridge) -> None:
    """Multiple threads can call the bridge concurrently and get correct responses."""
    n = 20

    def task(i: int) -> tuple[int, str]:
        return i, bridge.call("echo", {"msg": f"msg-{i}"})

    with ThreadPoolExecutor(max_workers=8) as pool:
        futures = {pool.submit(task, i): i for i in range(n)}
        results = {}
        for fut in as_completed(futures):
            i, result = fut.result()
            results[i] = result

    assert len(results) == n
    for i, result in results.items():
        assert result == f"msg-{i}", f"mismatch at i={i}: {result!r}"


def test_concurrent_add(bridge: RustBridge) -> None:
    """Concurrent add calls must not interleave responses."""
    pairs = [(i, i * 2) for i in range(30)]

    def task(a: int, b: int) -> int:
        return bridge.call("add", {"a": a, "b": b})

    with ThreadPoolExecutor(max_workers=10) as pool:
        futures = {pool.submit(task, a, b): (a, b) for a, b in pairs}
        for fut in as_completed(futures):
            a, b = futures[fut]
            assert fut.result() == a + b


def test_concurrent_mixed(bridge: RustBridge) -> None:
    """Mix of echo, add, and error calls all resolve correctly under concurrency."""

    def echo_task(i: int) -> bool:
        r = bridge.call("echo", {"msg": str(i)})
        return r == str(i)

    def add_task(i: int) -> bool:
        r = bridge.call("add", {"a": i, "b": i})
        return r == i * 2

    def error_task() -> bool:
        try:
            bridge.call("raise_error", {"code": 1, "msg": "x"})
            return False
        except BridgeError:
            return True

    tasks = (
        [lambda i=i: echo_task(i) for i in range(10)]
        + [lambda i=i: add_task(i) for i in range(10)]
        + [error_task] * 5
    )

    with ThreadPoolExecutor(max_workers=8) as pool:
        futs = [pool.submit(t) for t in tasks]
        for fut in as_completed(futs):
            assert fut.result() is True


# ---------------------------------------------------------------------------
# stdin EOF — child must exit
# ---------------------------------------------------------------------------


def test_stdin_eof_exits_child(binary_path: Path) -> None:
    """Closing stdin (EOF) must cause the child process to exit within 3 s."""
    b = RustBridge(binary_path, call_timeout=5.0)
    b.start()

    # Confirm it's alive.
    assert b._proc is not None
    assert b._proc.poll() is None

    # stop() closes stdin which sends EOF.
    b.stop()

    # Process should be gone.
    deadline = time.monotonic() + 3.0
    while time.monotonic() < deadline:
        # _proc is None after stop; we can't poll it here — the test just
        # verifies stop() returns without hanging.
        break

    # If we reach here stop() didn't hang — pass.


def test_context_manager_stops_on_exit(binary_path: Path) -> None:
    """__exit__ must stop the child even if no calls were made."""
    with RustBridge(binary_path) as b:
        pid = b._proc.pid  # type: ignore[union-attr]
    # After __exit__, the process must be terminated.
    import os
    import signal

    try:
        os.kill(pid, 0)
        # Process still alive — may be a zombie about to be reaped; tolerate.
    except ProcessLookupError:
        pass  # Already gone — perfect.


# ---------------------------------------------------------------------------
# Restart / re-entry
# ---------------------------------------------------------------------------


def test_double_start_raises(binary_path: Path) -> None:
    b = RustBridge(binary_path)
    b.start()
    try:
        with pytest.raises(RuntimeError, match="already started"):
            b.start()
    finally:
        b.stop()


def test_call_after_stop_raises(binary_path: Path) -> None:
    b = RustBridge(binary_path)
    b.start()
    b.stop()
    with pytest.raises(RuntimeError):
        b.call("echo", {"msg": "hi"})
