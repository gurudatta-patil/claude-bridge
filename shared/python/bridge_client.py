"""
Stitch — shared Python bridge client base.

All Python bridge clients (python-ruby, python-rust, python-go) subclass
BridgeClientBase rather than duplicating subprocess spawn, reader thread,
pending-call dispatch, signal handlers, and context-manager boilerplate.
"""

from __future__ import annotations

import json
import os
import signal
import subprocess
import sys
import threading
import uuid
from typing import Any


class BridgeError(Exception):
    """Raised when the remote sidecar returns a JSON-RPC error object."""

    def __init__(self, code: int | None, message: str) -> None:
        super().__init__(f"[{code}] {message}")
        self.code = code
        self.message = message


class BridgeClientBase:
    """
    Abstract base for Python bridge clients.

    Subclasses must call super().__init__(cmd) and may add typed public methods
    that delegate to self._call(method, params).

    Usage (context manager — preferred):

        class MyBridge(BridgeClientBase):
            def add(self, a, b):
                return self._call("add", {"a": a, "b": b})

        with MyBridge(["ruby", "sidecar.rb"]) as bridge:
            result = bridge.add(1, 2)

    Usage (manual):

        bridge = MyBridge(["./sidecar"])
        bridge.start()
        result = bridge._call("echo", {"msg": "hi"})
        bridge.close()
    """

    # Default timeouts — subclasses may override.
    READY_TIMEOUT: float = 10.0
    CALL_TIMEOUT: float = 30.0

    def __init__(
        self,
        cmd: list[str],
        ready_timeout: float | None = None,
        call_timeout: float | None = None,
        env: dict[str, str] | None = None,
    ) -> None:
        self._cmd = cmd
        self._ready_timeout = ready_timeout if ready_timeout is not None else self.READY_TIMEOUT
        self._call_timeout = call_timeout if call_timeout is not None else self.CALL_TIMEOUT
        self._env = env

        self._proc: subprocess.Popen | None = None
        self._reader_thread: threading.Thread | None = None
        self._write_lock = threading.Lock()

        # id -> threading.Event; the event is set when the response arrives.
        self._pending: dict[str, tuple[threading.Event, dict[str, Any]]] = {}
        self._pending_lock = threading.Lock()

        self._ready = threading.Event()
        self._closed = False

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------

    def start(self) -> None:
        """Spawn the sidecar process and wait for the {"ready":true} handshake."""
        if self._proc is not None:
            return

        env = {**os.environ, **(self._env or {})}
        self._proc = subprocess.Popen(
            self._cmd,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=env,
        )

        self._closed = False
        self._ready.clear()

        self._reader_thread = threading.Thread(
            target=self._reader_loop,
            name="bridge-client-reader",
            daemon=True,
        )
        self._reader_thread.start()

        # Drain stderr in the background so the pipe never fills.
        threading.Thread(
            target=self._stderr_drain,
            name="bridge-client-stderr",
            daemon=True,
        ).start()

        if not self._ready.wait(timeout=self._ready_timeout):
            self.close(force=True)
            raise TimeoutError(
                f"Sidecar did not emit {{\"ready\":true}} within {self._ready_timeout}s. "
                f"Command: {self._cmd}"
            )

        self._install_signal_handlers()

    def close(self, force: bool = False) -> None:
        """Gracefully terminate the child process (SIGTERM → 2 s → kill)."""
        if self._closed:
            return
        self._closed = True

        # Wake any callers still waiting.
        with self._pending_lock:
            for event, holder in self._pending.values():
                holder["error"] = {"code": -32000, "message": "bridge closed"}
                event.set()
            self._pending.clear()

        if self._proc is None:
            return

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

    # ------------------------------------------------------------------
    # Context manager
    # ------------------------------------------------------------------

    def __enter__(self) -> "BridgeClientBase":
        self.start()
        return self

    def __exit__(self, *_: Any) -> None:
        self.close()

    # ------------------------------------------------------------------
    # Protected RPC primitive
    # ------------------------------------------------------------------

    def _call(
        self,
        method: str,
        params: dict[str, Any] | None = None,
        timeout: float | None = None,
    ) -> Any:
        """
        Send a JSON-RPC request and block until the response arrives.

        Returns the ``result`` field on success.
        Raises :class:`BridgeError` if the sidecar returns an error object.
        Raises :class:`TimeoutError` if no response arrives within the timeout.
        """
        if self._closed or self._proc is None:
            raise RuntimeError("Bridge is not running — call start() first")

        call_id = str(uuid.uuid4())
        event = threading.Event()
        holder: dict[str, Any] = {}

        with self._pending_lock:
            self._pending[call_id] = (event, holder)

        request = {"id": call_id, "method": method, "params": params or {}}
        payload = json.dumps(request, separators=(",", ":")) + "\n"
        self._send_raw(payload)

        deadline = timeout if timeout is not None else self._call_timeout
        if not event.wait(timeout=deadline):
            with self._pending_lock:
                self._pending.pop(call_id, None)
            raise TimeoutError(
                f"No response for method={method!r} within {deadline}s"
            )

        if "error" in holder:
            err = holder["error"]
            raise BridgeError(err.get("code"), err.get("message", "unknown error"))

        return holder.get("result")

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    def _send_raw(self, line: str) -> None:
        if self._proc is None or self._proc.stdin is None:
            raise RuntimeError("Child stdin is not available")
        encoded = line.encode("utf-8")
        with self._write_lock:
            try:
                self._proc.stdin.write(encoded)
                self._proc.stdin.flush()
            except (BrokenPipeError, OSError) as exc:
                raise RuntimeError("Child stdin pipe is broken") from exc

    def _reader_loop(self) -> None:
        assert self._proc is not None
        stdout = self._proc.stdout
        if stdout is None:
            return

        for raw_line in stdout:
            line = raw_line.decode("utf-8", errors="replace").strip()
            if not line:
                continue

            try:
                msg: dict[str, Any] = json.loads(line)
            except json.JSONDecodeError:
                continue

            # Ready handshake
            if msg.get("ready") is True:
                self._ready.set()
                continue

            # RPC response dispatch
            call_id = msg.get("id")
            if call_id is None:
                continue

            with self._pending_lock:
                entry = self._pending.pop(call_id, None)

            if entry is None:
                continue

            event, holder = entry
            if "error" in msg:
                holder["error"] = msg["error"]
            else:
                holder["result"] = msg.get("result")
            event.set()

        # EOF — wake any remaining waiters
        with self._pending_lock:
            for event, holder in self._pending.values():
                holder["error"] = {"code": -32000, "message": "child process exited"}
                event.set()
            self._pending.clear()

        self._ready.set()  # prevent start() from hanging if child dies early

    def _stderr_drain(self) -> None:
        if self._proc is None or self._proc.stderr is None:
            return
        while True:
            try:
                chunk = self._proc.stderr.readline()
            except Exception:
                break
            if not chunk:
                break

    def _install_signal_handlers(self) -> None:
        """
        Install SIGINT/SIGTERM handlers so the child is cleaned up on exit.
        Only installs when called from the main thread.
        """
        if threading.current_thread() is not threading.main_thread():
            return

        original_sigint = signal.getsignal(signal.SIGINT)
        original_sigterm = signal.getsignal(signal.SIGTERM)

        def _cleanup(signum: int, frame: Any) -> None:
            self.close()
            if signum == signal.SIGINT:
                signal.signal(signal.SIGINT, original_sigint)
                os.kill(os.getpid(), signal.SIGINT)
            else:
                signal.signal(signal.SIGTERM, original_sigterm)
                sys.exit(0)

        signal.signal(signal.SIGINT, _cleanup)
        signal.signal(signal.SIGTERM, _cleanup)
