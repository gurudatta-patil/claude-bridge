"""
Ghost-Bridge: manual smoke-test client for test-child.rb.

Run directly::

    python tests/test-client.py

This file is intentionally standalone — it embeds a minimal copy of the
RubyBridge class so you can run it without installing anything.
"""

from __future__ import annotations

import base64
import json
import os
import queue
import signal
import subprocess
import sys
import threading
import uuid
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import Any


# ---------------------------------------------------------------------------
# Minimal inline bridge (same logic as template.client.py)
# ---------------------------------------------------------------------------

class BridgeError(RuntimeError):
    pass


class RubyBridge:
    def __init__(self, cmd: list[str], ready_timeout: float = 10.0, call_timeout: float = 30.0) -> None:
        self._cmd          = cmd
        self._call_timeout = call_timeout
        self._closed       = False
        self._pending: dict[str, queue.Queue] = {}
        self._pending_lock = threading.Lock()
        self._ready_event  = threading.Event()

        self._proc = subprocess.Popen(
            cmd,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=os.environ.copy(),
        )

        threading.Thread(target=self._reader_loop, daemon=True, name="reader").start()
        threading.Thread(target=self._stderr_drain, daemon=True, name="stderr").start()

        if not self._ready_event.wait(timeout=ready_timeout):
            self.close(force=True)
            raise TimeoutError(f"Sidecar did not become ready within {ready_timeout}s")

        self._install_signal_handlers()

    def call(self, method: str, params: dict | None = None) -> Any:
        if self._closed:
            raise RuntimeError("Bridge is closed")
        req_id = str(uuid.uuid4())
        q: queue.Queue = queue.Queue(maxsize=1)
        with self._pending_lock:
            self._pending[req_id] = q
        self._write_line(json.dumps({"id": req_id, "method": method, "params": params or {}}))
        try:
            resp = q.get(timeout=self._call_timeout)
        except queue.Empty:
            with self._pending_lock:
                self._pending.pop(req_id, None)
            raise TimeoutError(f"No response for {method!r} within {self._call_timeout}s")
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

    def __enter__(self) -> "RubyBridge":
        return self

    def __exit__(self, *_: Any) -> None:
        self.close()

    def _write_line(self, line: str) -> None:
        assert self._proc.stdin
        self._proc.stdin.write((line + "\n").encode("utf-8"))
        self._proc.stdin.flush()

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
                chunk = self._proc.stderr.readline()
            except Exception:
                break
            if not chunk:
                break

    def _install_signal_handlers(self) -> None:
        if threading.current_thread() is not threading.main_thread():
            return
        orig_int  = signal.getsignal(signal.SIGINT)
        orig_term = signal.getsignal(signal.SIGTERM)
        def _cleanup(signum: int, frame: Any) -> None:
            self.close()
            if signum == signal.SIGINT:
                signal.signal(signal.SIGINT, orig_int)
                os.kill(os.getpid(), signal.SIGINT)
            else:
                signal.signal(signal.SIGTERM, orig_term)
                sys.exit(0)
        signal.signal(signal.SIGINT,  _cleanup)
        signal.signal(signal.SIGTERM, _cleanup)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

TESTS_DIR = Path(__file__).parent
SIDECAR   = [sys.executable.replace("python", "ruby") or "ruby",
             str(TESTS_DIR / "test-child.rb")]

# Resolve ruby from PATH so we don't depend on sys.executable tricks.
import shutil
RUBY = shutil.which("ruby") or "ruby"
SIDECAR = [RUBY, str(TESTS_DIR / "test-child.rb")]


def header(title: str) -> None:
    print(f"\n{'─' * 60}")
    print(f"  {title}")
    print(f"{'─' * 60}")


def ok(label: str, value: Any = "") -> None:
    print(f"  [PASS]  {label}" + (f"  →  {value!r}" if value != "" else ""))


def fail(label: str, exc: Exception) -> None:
    print(f"  [FAIL]  {label}  →  {exc}", file=sys.stderr)


# ---------------------------------------------------------------------------
# Test scenarios
# ---------------------------------------------------------------------------

def test_echo(bridge: RubyBridge) -> None:
    header("echo")
    result = bridge.call("echo", {"msg": "hello from python"})
    assert result == "hello from python", f"unexpected: {result!r}"
    ok("echo round-trip", result)


def test_add(bridge: RubyBridge) -> None:
    header("add")
    result = bridge.call("add", {"a": 21, "b": 21})
    assert result == 42, f"unexpected: {result!r}"
    ok("add integers", result)

    result_float = bridge.call("add", {"a": 1.5, "b": 2.5})
    assert result_float == 4.0, f"unexpected: {result_float!r}"
    ok("add floats", result_float)


def test_raise_error(bridge: RubyBridge) -> None:
    header("raise_error")
    try:
        bridge.call("raise_error", {"message": "boom"})
        print("  [FAIL]  expected BridgeError was not raised", file=sys.stderr)
    except BridgeError as exc:
        ok("error propagated", str(exc))


def test_echo_b64(bridge: RubyBridge) -> None:
    header("echo_b64")
    data   = "Ghost-Bridge rocks"
    result = bridge.call("echo_b64", {"data": data})
    expected = base64.b64encode(data.encode()).decode()
    assert result == expected, f"unexpected: {result!r}"
    ok("base64 encoding", result)


def test_concurrent(bridge: RubyBridge, workers: int = 10) -> None:
    header(f"concurrent ({workers} threads)")
    errors: list[Exception] = []

    def call_echo(i: int) -> str:
        return bridge.call("echo", {"msg": f"concurrent-{i}"})

    with ThreadPoolExecutor(max_workers=workers) as pool:
        futures = {pool.submit(call_echo, i): i for i in range(workers)}
        for future in as_completed(futures):
            i = futures[future]
            try:
                result = future.result()
                assert result == f"concurrent-{i}", f"wrong result for {i}: {result!r}"
                ok(f"thread {i}", result)
            except Exception as exc:
                errors.append(exc)
                fail(f"thread {i}", exc)

    if errors:
        raise RuntimeError(f"{len(errors)} concurrent call(s) failed")


def test_slow(bridge: RubyBridge) -> None:
    header("slow (0.3 s)")
    import time
    start  = time.monotonic()
    result = bridge.call("slow", {"seconds": 0.3})
    elapsed = time.monotonic() - start
    assert result == "done", f"unexpected: {result!r}"
    assert elapsed >= 0.25, f"returned too fast: {elapsed:.3f}s"
    ok("slow call", f"{elapsed:.3f}s")


def test_unknown_method(bridge: RubyBridge) -> None:
    header("unknown method")
    try:
        bridge.call("no_such_method", {})
        print("  [FAIL]  expected BridgeError was not raised", file=sys.stderr)
    except BridgeError as exc:
        ok("unknown-method error", str(exc))


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def main() -> int:
    print(f"Spawning: {' '.join(SIDECAR)}")
    with RubyBridge(SIDECAR) as bridge:
        try:
            test_echo(bridge)
            test_add(bridge)
            test_raise_error(bridge)
            test_echo_b64(bridge)
            test_concurrent(bridge)
            test_slow(bridge)
            test_unknown_method(bridge)
        except Exception as exc:
            print(f"\nUnexpected failure: {exc}", file=sys.stderr)
            return 1

    print(f"\n{'═' * 60}")
    print("  All smoke tests passed.")
    print(f"{'═' * 60}\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
