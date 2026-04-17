"""
python-go_test.py — pytest test suite for the Python → Go bridge.

Prerequisites
-------------
The test-child binary must be compiled before running:

    cd bridges/python-go/tests/test-child
    go build -o ../test-child-bin .

Then run from the repo root:

    pytest bridges/python-go/tests/python-go_test.py -v
"""
from __future__ import annotations

import base64
import concurrent.futures
import os
import sys
import time

import pytest

# Allow importing template_client.py from the parent directory regardless of
# how pytest was invoked.
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

# template.client.py uses a dash which is not a valid Python identifier;
# import via importlib to work around the filename.
import importlib.util

_spec = importlib.util.spec_from_file_location(
    "template_client",
    os.path.join(os.path.dirname(__file__), "..", "template.client.py"),
)
_mod = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_mod)

GoBridge = _mod.GoBridge
GoBridgeError = _mod.GoBridgeError

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

BINARY = os.path.join(os.path.dirname(__file__), "test-child-bin")
if sys.platform == "win32":
    BINARY += ".exe"


def _require_binary() -> None:
    if not os.path.exists(BINARY):
        pytest.skip(
            f"test-child binary not found at {BINARY}. "
            "Build it: cd tests/test-child && go build -o ../test-child-bin ."
        )


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture(scope="module")
def bridge() -> GoBridge:
    """Module-scoped bridge — started once, shared across tests."""
    _require_binary()
    b = GoBridge(BINARY)
    b.start()
    yield b
    b.stop()


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


class TestRoundTrip:
    """Basic per-method round-trip tests."""

    def test_echo_string(self, bridge: GoBridge) -> None:
        result = bridge.call("echo", {"message": "hello, world"})
        assert result == "hello, world"

    def test_echo_empty_string(self, bridge: GoBridge) -> None:
        result = bridge.call("echo", {"message": ""})
        assert result == ""

    def test_echo_unicode(self, bridge: GoBridge) -> None:
        msg = "こんにちは 🌏"
        result = bridge.call("echo", {"message": msg})
        assert result == msg

    def test_add_integers(self, bridge: GoBridge) -> None:
        assert bridge.call("add", {"a": 3, "b": 4}) == 7

    def test_add_floats(self, bridge: GoBridge) -> None:
        result = bridge.call("add", {"a": 1.5, "b": 2.5})
        assert abs(result - 4.0) < 1e-9

    def test_add_large_integers(self, bridge: GoBridge) -> None:
        result = bridge.call("add", {"a": 1_000_000, "b": 2_000_000})
        assert result == 3_000_000

    def test_echo_b64_round_trip(self, bridge: GoBridge) -> None:
        original = bytes(range(256))  # all byte values 0x00–0xFF
        encoded = base64.b64encode(original).decode()
        result = bridge.call("echo_b64", {"data": encoded})
        assert base64.b64decode(result) == original

    def test_echo_b64_large_payload(self, bridge: GoBridge) -> None:
        """256 KiB payload — tests scanner buffer enlargement."""
        original = os.urandom(256 * 1024)
        encoded = base64.b64encode(original).decode()
        result = bridge.call("echo_b64", {"data": encoded})
        assert base64.b64decode(result) == original


class TestConcurrency:
    """10 parallel calls; verifies that IDs are matched correctly."""

    def test_concurrent_echo(self, bridge: GoBridge) -> None:
        n = 10
        messages = [f"concurrent-{i}" for i in range(n)]

        def _call(msg: str) -> str:
            return bridge.call("echo", {"message": msg})

        with concurrent.futures.ThreadPoolExecutor(max_workers=n) as pool:
            futs = [pool.submit(_call, m) for m in messages]
            results = [f.result(timeout=10) for f in futs]

        assert sorted(results) == sorted(messages)

    def test_concurrent_add(self, bridge: GoBridge) -> None:
        n = 10
        pairs = [(i, i * 2) for i in range(n)]
        expected = [a + b for a, b in pairs]

        def _call(pair):
            a, b = pair
            return bridge.call("add", {"a": a, "b": b})

        with concurrent.futures.ThreadPoolExecutor(max_workers=n) as pool:
            results = list(pool.map(_call, pairs, timeout=10))

        assert results == expected

    def test_concurrent_mixed_methods(self, bridge: GoBridge) -> None:
        """Mix of echo and add calls issued concurrently."""
        tasks = [
            ("echo", {"message": f"msg-{i}"}) for i in range(5)
        ] + [
            ("add", {"a": i, "b": i}) for i in range(5)
        ]

        def _call(task):
            method, params = task
            return bridge.call(method, params)

        with concurrent.futures.ThreadPoolExecutor(max_workers=len(tasks)) as pool:
            results = list(pool.map(_call, tasks, timeout=10))

        for i, (method, params) in enumerate(tasks):
            if method == "echo":
                assert results[i] == params["message"]
            else:
                assert results[i] == params["a"] + params["b"]


class TestErrors:
    """Error propagation tests."""

    def test_raise_error_returns_go_bridge_error(self, bridge: GoBridge) -> None:
        with pytest.raises(GoBridgeError) as exc_info:
            bridge.call("raise_error", {"message": "boom"})
        err = exc_info.value
        assert err.code == 42
        assert "boom" in err.message

    def test_unknown_method_returns_method_not_found(self, bridge: GoBridge) -> None:
        with pytest.raises(GoBridgeError) as exc_info:
            bridge.call("no_such_method", {})
        assert exc_info.value.code == -32601

    def test_malformed_params_returns_invalid_params(self, bridge: GoBridge) -> None:
        # 'add' expects {"a": ..., "b": ...}; send a string instead.
        with pytest.raises(GoBridgeError) as exc_info:
            bridge.call("add", "not an object")
        assert exc_info.value.code == -32602

    def test_error_does_not_break_subsequent_calls(self, bridge: GoBridge) -> None:
        """After a remote error the bridge must remain usable."""
        with pytest.raises(GoBridgeError):
            bridge.call("raise_error", {"message": "intentional"})
        # Bridge should still work
        assert bridge.call("echo", {"message": "still alive"}) == "still alive"


class TestSlowCall:
    """Timing-related tests."""

    def test_slow_completes_within_timeout(self, bridge: GoBridge) -> None:
        t0 = time.monotonic()
        result = bridge.call("slow", {"seconds": 0.5}, timeout=5.0)
        elapsed = time.monotonic() - t0
        assert result == "done"
        assert elapsed >= 0.4  # allow small timer jitter


class TestStdinEOF:
    """Verify that closing stdin causes the child to exit without hanging."""

    def test_stop_sends_eof_and_child_exits(self) -> None:
        _require_binary()
        b = GoBridge(BINARY)
        b.start()
        # Verify the child is running
        assert b.call("echo", {"message": "ping"}) == "ping"
        # stop() closes stdin; the child should exit
        b.stop()
        # Child process should be gone
        assert b._proc.wait(timeout=3) is not None  # returncode is set

    def test_bridge_raises_after_stop(self) -> None:
        _require_binary()
        b = GoBridge(BINARY)
        b.start()
        b.stop()
        with pytest.raises(RuntimeError, match="not started"):
            b.call("echo", {"message": "should fail"})

    def test_context_manager_closes_on_exception(self) -> None:
        _require_binary()
        try:
            with GoBridge(BINARY) as b:
                assert b.call("echo", {"message": "ok"}) == "ok"
                raise ValueError("test exception")
        except ValueError:
            pass  # exception should propagate
        # Bridge should be stopped
        assert not b._started


class TestContextManager:
    """Context manager lifecycle tests."""

    def test_enter_exit_normal(self) -> None:
        _require_binary()
        with GoBridge(BINARY) as b:
            assert b.call("add", {"a": 1, "b": 1}) == 2
        assert not b._started

    def test_double_start_is_idempotent(self) -> None:
        _require_binary()
        b = GoBridge(BINARY)
        b.start()
        pid_before = b._proc.pid
        b.start()  # should be a no-op
        assert b._proc.pid == pid_before
        b.stop()
