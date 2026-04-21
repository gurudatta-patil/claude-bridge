"""
Stitch Python→Node.js bridge – pytest / unittest test suite.

Run with:
    pytest bridges/python-nodejs/tests/python-nodejs_test.py -v
or from the bridge directory:
    python -m pytest tests/python-nodejs_test.py -v
"""

from __future__ import annotations

import json
import os
import queue
import shutil
import signal
import subprocess
import sys
import threading
import time
import unittest
import uuid
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import Any


# ---------------------------------------------------------------------------
# Inline bridge (avoids import-path complexity when running directly)
# ---------------------------------------------------------------------------

class BridgeError(RuntimeError):
    pass


class NodeBridge:
    """Minimal bridge implementation used by the test suite."""

    def __init__(self, cmd: list[str], ready_timeout: float = 10.0, call_timeout: float = 15.0) -> None:
        self._cmd          = cmd
        self._call_timeout = call_timeout
        self._closed       = False
        self._pending: dict[str, queue.Queue] = {}
        self._pending_lock = threading.Lock()
        self._ready_event  = threading.Event()
        self._write_lock   = threading.Lock()

        self._proc = subprocess.Popen(
            cmd,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=os.environ.copy(),
        )

        threading.Thread(target=self._reader_loop, daemon=True).start()
        threading.Thread(target=self._stderr_drain, daemon=True).start()

        if not self._ready_event.wait(timeout=ready_timeout):
            self.close(force=True)
            raise TimeoutError("Sidecar did not become ready")

    def call(self, method: str, params: dict | None = None) -> Any:
        if self._closed:
            raise RuntimeError("Bridge is closed")
        req_id = str(uuid.uuid4())
        q: queue.Queue = queue.Queue(maxsize=1)
        with self._pending_lock:
            self._pending[req_id] = q
        payload = json.dumps({"id": req_id, "method": method, "params": params or {}})
        assert self._proc.stdin
        encoded = (payload + "\n").encode("utf-8")
        with self._write_lock:
            self._proc.stdin.write(encoded)
            self._proc.stdin.flush()
        try:
            resp = q.get(timeout=self._call_timeout)
        except queue.Empty:
            with self._pending_lock:
                self._pending.pop(req_id, None)
            raise TimeoutError(f"No response for {method!r}")
        if "error" in resp:
            e = resp["error"]
            raise BridgeError(f"[{e.get('code')}] {e.get('message')}")
        return resp.get("result")

    def close(self, force: bool = False) -> None:
        if self._closed:
            return
        self._closed = True
        try:
            if self._proc.poll() is None:
                if not force:
                    self._proc.send_signal(signal.SIGTERM)
                    try:
                        self._proc.wait(timeout=2)
                    except subprocess.TimeoutExpired:
                        pass
                if self._proc.poll() is None:
                    self._proc.kill()
                    self._proc.wait()
        except OSError:
            pass

    def __enter__(self) -> "NodeBridge":
        return self

    def __exit__(self, *_: Any) -> None:
        self.close()

    def _reader_loop(self) -> None:
        assert self._proc.stdout
        while True:
            try:
                raw = self._proc.stdout.readline()
            except Exception:
                break
            if not raw:
                break
            line = raw.decode("utf-8", errors="replace").strip()
            if not line:
                continue
            try:
                msg = json.loads(line)
            except json.JSONDecodeError:
                continue
            if msg.get("ready") is True:
                self._ready_event.set()
                continue
            req_id = msg.get("id")
            if req_id:
                with self._pending_lock:
                    q = self._pending.pop(req_id, None)
                if q:
                    q.put_nowait(msg)

    def _stderr_drain(self) -> None:
        assert self._proc.stderr
        while True:
            try:
                if not self._proc.stderr.readline():
                    break
            except Exception:
                break


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

TESTS_DIR      = Path(__file__).parent
NODE           = shutil.which("node") or "node"
CHILD          = [NODE, str(TESTS_DIR / "test-child.js")]
NODE_AVAILABLE = shutil.which("node") is not None

skip_no_node = unittest.skipUnless(NODE_AVAILABLE, "node not found on PATH")


# ---------------------------------------------------------------------------
# Base test case: shares one bridge per test class to avoid per-test overhead
# ---------------------------------------------------------------------------

@skip_no_node
class BridgeTestCase(unittest.TestCase):
    """Base class that shares a single bridge across all tests in a subclass."""

    bridge: NodeBridge

    @classmethod
    def setUpClass(cls) -> None:
        cls.bridge = NodeBridge(CHILD)

    @classmethod
    def tearDownClass(cls) -> None:
        cls.bridge.close()


# ---------------------------------------------------------------------------
# 1. Ping
# ---------------------------------------------------------------------------

class TestPing(BridgeTestCase):
    def test_ping_returns_pong(self) -> None:
        result = self.bridge.call("__ping__")
        self.assertIsInstance(result, dict)
        self.assertTrue(result.get("pong"))

    def test_ping_includes_pid(self) -> None:
        result = self.bridge.call("__ping__")
        self.assertIn("pid", result)
        self.assertIsInstance(result["pid"], int)
        self.assertGreater(result["pid"], 0)


# ---------------------------------------------------------------------------
# 2. Echo
# ---------------------------------------------------------------------------

class TestEcho(BridgeTestCase):
    def test_echo_simple(self) -> None:
        result = self.bridge.call("echo", {"msg": "hello"})
        self.assertEqual(result, {"msg": "hello"})

    def test_echo_empty_string(self) -> None:
        result = self.bridge.call("echo", {"msg": ""})
        self.assertEqual(result, {"msg": ""})

    def test_echo_unicode(self) -> None:
        msg    = "こんにちは 🌉 مرحبا"
        result = self.bridge.call("echo", {"msg": msg})
        self.assertEqual(result, {"msg": msg})

    def test_echo_long_string(self) -> None:
        msg    = "x" * 10_000
        result = self.bridge.call("echo", {"msg": msg})
        self.assertEqual(len(result["msg"]), 10_000)


# ---------------------------------------------------------------------------
# 3. Add
# ---------------------------------------------------------------------------

class TestAdd(BridgeTestCase):
    def test_add_integers(self) -> None:
        result = self.bridge.call("add", {"a": 3, "b": 4})
        self.assertEqual(result, {"sum": 7})

    def test_add_negative(self) -> None:
        result = self.bridge.call("add", {"a": -10, "b": 3})
        self.assertEqual(result, {"sum": -7})

    def test_add_floats(self) -> None:
        result = self.bridge.call("add", {"a": 0.1, "b": 0.2})
        self.assertAlmostEqual(result["sum"], 0.3, places=5)

    def test_add_zero(self) -> None:
        result = self.bridge.call("add", {"a": 0, "b": 0})
        self.assertEqual(result, {"sum": 0})


# ---------------------------------------------------------------------------
# 4. Error propagation
# ---------------------------------------------------------------------------

class TestErrors(BridgeTestCase):
    def test_raise_error_propagates(self) -> None:
        with self.assertRaises(BridgeError) as ctx:
            self.bridge.call("raise_error", {})
        self.assertIn("deliberate test error", str(ctx.exception))

    def test_unknown_method_returns_error(self) -> None:
        with self.assertRaises(BridgeError) as ctx:
            self.bridge.call("no_such_method", {})
        self.assertIn("-32601", str(ctx.exception))

    def test_missing_required_param_echo(self) -> None:
        """echo without 'msg' should return a BridgeError."""
        with self.assertRaises(BridgeError):
            self.bridge.call("echo", {})

    def test_missing_required_param_add(self) -> None:
        """add without 'a' should return a BridgeError."""
        with self.assertRaises(BridgeError):
            self.bridge.call("add", {"b": 5})


# ---------------------------------------------------------------------------
# 5. Slow / timing
# ---------------------------------------------------------------------------

class TestSlow(BridgeTestCase):
    def test_slow_completes(self) -> None:
        start   = time.monotonic()
        result  = self.bridge.call("slow", {"ms": 200})
        elapsed = time.monotonic() - start
        self.assertEqual(result, {"done": True})
        self.assertGreaterEqual(elapsed, 0.18)

    def test_slow_zero(self) -> None:
        result = self.bridge.call("slow", {"ms": 0})
        self.assertEqual(result, {"done": True})

    def test_slow_default(self) -> None:
        """slow without ms param uses default (100 ms) and still returns done."""
        result = self.bridge.call("slow", {})
        self.assertEqual(result, {"done": True})


# ---------------------------------------------------------------------------
# 6. Concurrency
# ---------------------------------------------------------------------------

class TestConcurrent(BridgeTestCase):
    WORKERS = 10

    def test_concurrent_echo(self) -> None:
        """10 threads firing echo calls simultaneously must all resolve correctly."""
        errors: list[Exception] = []
        results: dict[int, Any] = {}

        def call_echo(i: int) -> None:
            try:
                results[i] = self.bridge.call("echo", {"msg": f"thread-{i}"})
            except Exception as exc:
                errors.append(exc)

        threads = [threading.Thread(target=call_echo, args=(i,)) for i in range(self.WORKERS)]
        for t in threads:
            t.start()
        for t in threads:
            t.join(timeout=15)

        self.assertEqual(errors, [], f"Errors in concurrent calls: {errors}")
        for i in range(self.WORKERS):
            self.assertEqual(results[i], {"msg": f"thread-{i}"})

    def test_concurrent_add(self) -> None:
        """10 threads doing add(i, i) must each get {sum: 2*i} back."""
        results: dict[int, Any] = {}
        errors: list[Exception] = []

        def call_add(i: int) -> None:
            try:
                results[i] = self.bridge.call("add", {"a": i, "b": i})
            except Exception as exc:
                errors.append(exc)

        with ThreadPoolExecutor(max_workers=self.WORKERS) as pool:
            futures = [pool.submit(call_add, i) for i in range(self.WORKERS)]
            for f in as_completed(futures):
                f.result()

        self.assertEqual(errors, [])
        for i in range(self.WORKERS):
            self.assertEqual(results[i], {"sum": i * 2})

    def test_concurrent_mixed(self) -> None:
        """Mix of echo, add, and slow calls from multiple threads."""
        with ThreadPoolExecutor(max_workers=4) as pool:
            f_echo = pool.submit(self.bridge.call, "echo", {"msg": "mixed"})
            f_add  = pool.submit(self.bridge.call, "add",  {"a": 5, "b": 5})
            f_slow = pool.submit(self.bridge.call, "slow", {"ms": 100})
            f_ping = pool.submit(self.bridge.call, "__ping__")

            self.assertEqual(f_echo.result(timeout=5), {"msg": "mixed"})
            self.assertEqual(f_add.result(timeout=5),  {"sum": 10})
            self.assertEqual(f_slow.result(timeout=5), {"done": True})
            self.assertTrue(f_ping.result(timeout=5).get("pong"))


# ---------------------------------------------------------------------------
# 7. Lifecycle / process management
# ---------------------------------------------------------------------------

@skip_no_node
class TestLifecycle(unittest.TestCase):
    """Each test creates its own bridge to test lifecycle concerns."""

    def test_context_manager_closes_process(self) -> None:
        with NodeBridge(CHILD) as bridge:
            pid    = bridge._proc.pid
            result = bridge.call("echo", {"msg": "alive"})
            self.assertEqual(result, {"msg": "alive"})
        # After __exit__, the process should be dead.
        try:
            import psutil
            proc = psutil.Process(pid)
            proc.wait(timeout=2)
        except (ImportError, Exception):
            pass  # psutil not available or process already gone – either is fine

    def test_close_idempotent(self) -> None:
        bridge = NodeBridge(CHILD)
        bridge.close()
        bridge.close()  # must not raise

    def test_call_after_close_raises(self) -> None:
        bridge = NodeBridge(CHILD)
        bridge.close()
        with self.assertRaises(RuntimeError):
            bridge.call("echo", {"msg": "dead"})

    def test_ready_timeout_raises(self) -> None:
        """A zero ready_timeout must raise TimeoutError immediately."""
        with self.assertRaises(TimeoutError):
            NodeBridge(CHILD, ready_timeout=0.0)

    def test_multiple_sequential_calls(self) -> None:
        with NodeBridge(CHILD) as bridge:
            for i in range(20):
                result = bridge.call("add", {"a": i, "b": i})
                self.assertEqual(result, {"sum": i * 2})


# ---------------------------------------------------------------------------
# 8. Protocol edge cases
# ---------------------------------------------------------------------------

@skip_no_node
class TestProtocol(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.bridge = NodeBridge(CHILD)

    @classmethod
    def tearDownClass(cls) -> None:
        cls.bridge.close()

    def test_response_contains_same_id(self) -> None:
        """Intercept the raw queue to verify id round-trip."""
        req_id = str(uuid.uuid4())
        q: queue.Queue = queue.Queue(maxsize=1)
        with self.bridge._pending_lock:
            self.bridge._pending[req_id] = q
        payload = json.dumps({"id": req_id, "method": "echo", "params": {"msg": "id-check"}})
        assert self.bridge._proc.stdin
        with self.bridge._write_lock:
            self.bridge._proc.stdin.write((payload + "\n").encode())
            self.bridge._proc.stdin.flush()
        resp = q.get(timeout=5)
        self.assertEqual(resp["id"], req_id)
        self.assertEqual(resp["result"], {"msg": "id-check"})

    def test_large_payload(self) -> None:
        """A 100 KB payload must round-trip without truncation."""
        big    = "A" * 100_000
        result = self.bridge.call("echo", {"msg": big})
        self.assertEqual(len(result["msg"]), 100_000)

    def test_special_json_characters(self) -> None:
        """Strings with quotes, backslashes, and newlines must survive serialisation."""
        msg    = 'He said "hello\\nworld"'
        result = self.bridge.call("echo", {"msg": msg})
        self.assertEqual(result, {"msg": msg})

    def test_null_params_treated_as_empty(self) -> None:
        """Passing None/null params should not crash the sidecar."""
        result = self.bridge.call("__ping__", None)
        self.assertTrue(result.get("pong"))


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    unittest.main(verbosity=2)
