"""
Stitch - shared Python bridge client base.

All Python bridge clients (python-ruby, python-rust, python-go) subclass
BridgeClientBase rather than duplicating subprocess spawn, reader thread,
pending-call dispatch, signal handlers, and context-manager boilerplate.
"""

from __future__ import annotations

import json
import os
import queue
import signal
import subprocess
import sys
import threading
import time
import uuid
from typing import Any, Generator


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

    Usage (context manager - preferred):

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

    # Default timeouts - subclasses may override.
    READY_TIMEOUT: float = 10.0
    CALL_TIMEOUT: float = 30.0

    def __init__(
        self,
        cmd: list[str],
        ready_timeout: float | None = None,
        call_timeout: float | None = None,
        env: dict[str, str] | None = None,
        auto_restart: bool = False,
        max_restarts: int = 3,
        watch_path: str | None = None,
    ) -> None:
        self._cmd = cmd
        self._ready_timeout = ready_timeout if ready_timeout is not None else self.READY_TIMEOUT
        self._call_timeout = call_timeout if call_timeout is not None else self.CALL_TIMEOUT
        self._env = env
        self._auto_restart = auto_restart
        self._max_restarts = max_restarts
        self._restart_count = 0
        self._watch_path = watch_path

        self._proc: subprocess.Popen | None = None
        self._reader_thread: threading.Thread | None = None
        self._write_lock = threading.Lock()

        # id -> threading.Event; the event is set when the response arrives.
        self._pending: dict[str, tuple[threading.Event, dict[str, Any]]] = {}
        self._pending_lock = threading.Lock()

        # Streaming support
        self._stream_pending: dict[str, queue.Queue] = {}
        self._stream_lock = threading.Lock()

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

        if self._watch_path is not None:
            threading.Thread(
                target=self._watch_loop,
                name="bridge-client-watcher",
                daemon=True,
            ).start()

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

        # Wake any stream waiters.
        with self._stream_lock:
            for sq in self._stream_pending.values():
                sq.put(("error", {"code": -32000, "message": "bridge closed"}))
            self._stream_pending.clear()

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
    # Built-in convenience methods
    # ------------------------------------------------------------------

    def ping(self) -> dict:
        """Send a built-in __ping__ call. Returns {"pong": True, "pid": <int>}."""
        return self._call("__ping__", {}, timeout=5.0)

    # ------------------------------------------------------------------
    # Protected RPC primitive
    # ------------------------------------------------------------------

    def _call(
        self,
        method: str,
        params: dict[str, Any] | None = None,
        timeout: float | None = None,
        traceparent: str | None = None,
    ) -> Any:
        """
        Send a JSON-RPC request and block until the response arrives.

        Returns the ``result`` field on success.
        Raises :class:`BridgeError` if the sidecar returns an error object.
        Raises :class:`TimeoutError` if no response arrives within the timeout.
        """
        if self._closed or self._proc is None:
            raise RuntimeError("Bridge is not running - call start() first")

        call_id = str(uuid.uuid4())
        event = threading.Event()
        holder: dict[str, Any] = {}

        with self._pending_lock:
            self._pending[call_id] = (event, holder)

        request = {"id": call_id, "method": method, "params": params or {}}
        if traceparent is not None:
            request["traceparent"] = traceparent
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

    def stream_call(
        self,
        method: str,
        params: dict[str, Any] | None = None,
        timeout: float | None = None,
        traceparent: str | None = None,
    ) -> Generator[Any, None, None]:
        """
        Send a streaming JSON-RPC call. Yields each chunk as it arrives.
        The sidecar handler must return a StreamResponse wrapping a generator.
        Raises BridgeError on remote error, TimeoutError on chunk timeout.
        """
        if self._closed or self._proc is None:
            raise RuntimeError("Bridge is not running")
        call_id = str(uuid.uuid4())
        q: queue.Queue = queue.Queue()
        with self._stream_lock:
            self._stream_pending[call_id] = q
        request: dict[str, Any] = {
            "id": call_id,
            "method": method,
            "params": params or {},
            "stream": True,
        }
        if traceparent is not None:
            request["traceparent"] = traceparent
        payload = json.dumps(request, separators=(",", ":")) + "\n"
        self._send_raw(payload)
        deadline = timeout if timeout is not None else self._call_timeout
        while True:
            try:
                kind, value = q.get(timeout=deadline)
            except queue.Empty:
                with self._stream_lock:
                    self._stream_pending.pop(call_id, None)
                raise TimeoutError(
                    f"Stream timeout for method={method!r} after {deadline}s"
                )
            if kind == "done":
                return
            elif kind == "error":
                raise BridgeError(value.get("code"), value.get("message", "stream error"))
            else:  # chunk
                yield value

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

            # Streaming chunk frame
            if "chunk" in msg and "result" not in msg and "error" not in msg:
                call_id = msg.get("id")
                with self._stream_lock:
                    q = self._stream_pending.get(call_id)
                if q:
                    q.put(("chunk", msg["chunk"]))
                continue

            # RPC response dispatch
            call_id = msg.get("id")
            if call_id is None:
                continue

            # Check stream pending first (terminal frame for a stream call)
            with self._stream_lock:
                sq = self._stream_pending.get(call_id)
            if sq is not None:
                with self._stream_lock:
                    del self._stream_pending[call_id]
                if "error" in msg:
                    sq.put(("error", msg["error"]))
                else:
                    sq.put(("done", None))
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

        # EOF - wake any remaining waiters
        with self._pending_lock:
            for event, holder in self._pending.values():
                holder["error"] = {"code": -32000, "message": "child process exited"}
                event.set()
            self._pending.clear()

        with self._stream_lock:
            for sq in self._stream_pending.values():
                sq.put(("error", {"code": -32000, "message": "child process exited"}))
            self._stream_pending.clear()

        self._ready.set()  # prevent start() from hanging if child dies early

        # Auto-restart if the child exited unexpectedly (not via explicit close()).
        if (
            not self._closed
            and self._auto_restart
            and self._restart_count < self._max_restarts
        ):
            attempt = self._restart_count + 1
            delay = min(0.1 * (2 ** self._restart_count), 10.0)
            print(
                f"[bridge] child exited unexpectedly, restarting "
                f"(attempt {attempt}/{self._max_restarts})",
                file=sys.stderr,
            )
            self._restart_count += 1
            self._proc = None
            self._reader_thread = None
            time.sleep(delay)
            if not self._closed:
                try:
                    self.start()
                except Exception as exc:
                    print(f"[bridge] restart failed: {exc}", file=sys.stderr)

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

    def _watch_loop(self) -> None:
        """Poll watch_path for mtime changes and hot-reload the sidecar."""
        assert self._watch_path is not None
        try:
            last_mtime = os.stat(self._watch_path).st_mtime
        except OSError:
            return
        while not self._closed:
            time.sleep(1.0)
            if self._closed:
                break
            try:
                mtime = os.stat(self._watch_path).st_mtime
            except OSError:
                continue
            if mtime != last_mtime:
                last_mtime = mtime
                if not self._closed:
                    print("[bridge] sidecar changed, reloading...", file=sys.stderr)
                    self.close(force=True)
                    time.sleep(0.2)
                    try:
                        self._closed = False
                        self._proc = None
                        self._reader_thread = None
                        self.start()
                    except Exception as exc:
                        print(f"[bridge] hot-reload failed: {exc}", file=sys.stderr)

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


class BridgePool:
    """
    Pool of N bridge instances for parallel execution.

    Usage:
        pool = BridgePool(MyBridge, ["ruby", "sidecar.rb"], size=4)
        pool.start()
        result = pool.call("method", params)
        pool.close()

    Or as context manager:
        with BridgePool(MyBridge, cmd, size=4) as pool:
            result = pool.call("method", params)
    """

    def __init__(
        self,
        bridge_class: type,
        cmd: list[str],
        size: int = 4,
        bridge_kwargs: dict[str, Any] | None = None,
    ) -> None:
        self._bridge_class = bridge_class
        self._cmd = cmd
        self._size = size
        self._bridge_kwargs = bridge_kwargs or {}

        self._workers: list[BridgeClientBase] = []
        # Per-worker in-flight counter; protected by _lock.
        self._inflight: list[int] = []
        self._lock = threading.Lock()

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------

    def start(self) -> None:
        """Create and start all worker bridge instances."""
        for _ in range(self._size):
            worker: BridgeClientBase = self._bridge_class(
                self._cmd, **self._bridge_kwargs
            )
            worker.start()
            self._workers.append(worker)
            self._inflight.append(0)

    def close(self) -> None:
        """Close all worker bridge instances."""
        for worker in self._workers:
            worker.close()

    # ------------------------------------------------------------------
    # Context manager
    # ------------------------------------------------------------------

    def __enter__(self) -> "BridgePool":
        self.start()
        return self

    def __exit__(self, *_: Any) -> None:
        self.close()

    # ------------------------------------------------------------------
    # Routing
    # ------------------------------------------------------------------

    def call(
        self,
        method: str,
        params: dict[str, Any] | None = None,
        timeout: float | None = None,
    ) -> Any:
        """
        Route the call to the least-busy worker and return its result.

        Thread-safe: multiple threads may call this concurrently.
        """
        worker, index = self._acquire_worker()
        try:
            return worker._call(method, params, timeout=timeout)
        finally:
            with self._lock:
                self._inflight[index] -= 1

    def _acquire_worker(self) -> tuple[BridgeClientBase, int]:
        """Return the worker with the lowest in-flight count and increment its counter."""
        with self._lock:
            index = min(range(self._size), key=lambda i: self._inflight[i])
            self._inflight[index] += 1
            return self._workers[index], index


# ---------------------------------------------------------------------------
# Module-level helpers
# ---------------------------------------------------------------------------


def make_bundler_cmd(gemfile_path: str, script_path: str) -> list[str]:
    """
    Return a command list that runs script_path with 'bundle exec ruby',
    after verifying Bundler is installed. Raises RuntimeError if not found.

    Example: make_bundler_cmd("/app/Gemfile", "sidecar.rb")
      -> ["bundle", "exec", "ruby", "sidecar.rb"]

    Automatically sets BUNDLE_GEMFILE env var - pass the result as cmd to any
    BridgeClientBase subclass, and pass env={"BUNDLE_GEMFILE": gemfile_path}.
    """
    import shutil
    if shutil.which("bundle") is None:
        raise RuntimeError("Bundler not found. Install it with: gem install bundler")
    return ["bundle", "exec", "ruby", script_path]
