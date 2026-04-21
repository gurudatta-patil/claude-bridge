"""
Stitch - asyncio-based Python bridge client.

Provides AsyncBridgeClientBase for use with async Python frameworks
(FastAPI, aiohttp, Starlette, etc.).

Usage:
    class MyBridge(AsyncBridgeClientBase):
        async def add(self, a: float, b: float) -> dict:
            return await self._call("add", {"a": a, "b": b})

    async with MyBridge(["ruby", "sidecar.rb"]) as bridge:
        result = await bridge.add(1, 2)
"""

from __future__ import annotations

import asyncio
import json
import os
import signal
import sys
import uuid
from typing import Any, AsyncGenerator


class AsyncBridgeError(Exception):
    """Raised when the remote sidecar returns a JSON-RPC error object."""

    def __init__(self, code: int | None, message: str) -> None:
        super().__init__(f"[{code}] {message}")
        self.code = code
        self.message = message


class AsyncBridgeClientBase:
    """
    Abstract base for asyncio-based Python bridge clients.

    Subclasses must call super().__init__(cmd) and may add typed async public
    methods that delegate to self._call(method, params).

    Usage (async context manager - preferred):

        class MyBridge(AsyncBridgeClientBase):
            async def add(self, a, b):
                return await self._call("add", {"a": a, "b": b})

        async with MyBridge(["ruby", "sidecar.rb"]) as bridge:
            result = await bridge.add(1, 2)

    Usage (manual):

        bridge = MyBridge(["./sidecar"])
        await bridge.start()
        result = await bridge._call("echo", {"msg": "hi"})
        await bridge.stop()
    """

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

        self._proc: asyncio.subprocess.Process | None = None
        self._reader_task: asyncio.Task | None = None

        # id -> asyncio.Future[dict]
        self._pending: dict[str, asyncio.Future] = {}

        # id -> asyncio.Queue for streaming
        self._stream_pending: dict[str, asyncio.Queue] = {}

        self._ready_event: asyncio.Event | None = None
        self._closed = False

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------

    async def start(self) -> None:
        """Spawn the sidecar process and wait for the {"ready":true} handshake."""
        if self._proc is not None:
            return

        env = {**os.environ, **(self._env or {})}

        self._proc = await asyncio.create_subprocess_exec(
            *self._cmd,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env=env,
        )

        self._closed = False
        self._ready_event = asyncio.Event()

        self._reader_task = asyncio.create_task(
            self._reader_loop(), name="async-bridge-reader"
        )

        # Drain stderr in the background.
        asyncio.create_task(self._stderr_drain(), name="async-bridge-stderr")

        try:
            await asyncio.wait_for(
                self._ready_event.wait(), timeout=self._ready_timeout
            )
        except asyncio.TimeoutError:
            await self.stop(force=True)
            raise TimeoutError(
                f'Sidecar did not emit {{"ready":true}} within {self._ready_timeout}s. '
                f"Command: {self._cmd}"
            )

    async def stop(self, force: bool = False) -> None:
        """Gracefully terminate the child process."""
        if self._closed:
            return
        self._closed = True

        # Wake all pending callers with an error.
        for fut in self._pending.values():
            if not fut.done():
                fut.set_exception(
                    AsyncBridgeError(-32000, "bridge closed")
                )
        self._pending.clear()

        # Wake all stream waiters.
        for sq in self._stream_pending.values():
            await sq.put(("error", {"code": -32000, "message": "bridge closed"}))
        self._stream_pending.clear()

        if self._reader_task is not None:
            self._reader_task.cancel()
            try:
                await self._reader_task
            except (asyncio.CancelledError, Exception):
                pass
            self._reader_task = None

        if self._proc is None:
            return

        try:
            if self._proc.returncode is None:
                if not force:
                    self._proc.terminate()
                    try:
                        await asyncio.wait_for(self._proc.wait(), timeout=2.0)
                    except asyncio.TimeoutError:
                        pass
                if self._proc.returncode is None:
                    self._proc.kill()
                    await self._proc.wait()
        except (ProcessLookupError, OSError):
            pass

        self._proc = None

    # ------------------------------------------------------------------
    # Context manager
    # ------------------------------------------------------------------

    async def __aenter__(self) -> "AsyncBridgeClientBase":
        await self.start()
        return self

    async def __aexit__(self, *_: Any) -> None:
        await self.stop()

    # ------------------------------------------------------------------
    # Built-in convenience methods
    # ------------------------------------------------------------------

    async def ping(self) -> dict:
        """Send a built-in __ping__ call. Returns {"pong": True, "pid": <int>}."""
        return await self._call("__ping__", {}, timeout=5.0)

    # ------------------------------------------------------------------
    # Protected RPC primitives
    # ------------------------------------------------------------------

    async def _call(
        self,
        method: str,
        params: dict[str, Any] | None = None,
        timeout: float | None = None,
        traceparent: str | None = None,
    ) -> Any:
        """
        Send a JSON-RPC request and await the response.

        Returns the ``result`` field on success.
        Raises :class:`AsyncBridgeError` if the sidecar returns an error object.
        Raises :class:`TimeoutError` if no response arrives within the timeout.
        """
        if self._closed or self._proc is None:
            raise RuntimeError("Bridge is not running - call start() first")

        call_id = str(uuid.uuid4())
        loop = asyncio.get_running_loop()
        fut: asyncio.Future = loop.create_future()

        self._pending[call_id] = fut

        request: dict[str, Any] = {
            "id": call_id,
            "method": method,
            "params": params or {},
        }
        if traceparent is not None:
            request["traceparent"] = traceparent

        await self._send_raw(json.dumps(request, separators=(",", ":")) + "\n")

        deadline = timeout if timeout is not None else self._call_timeout
        try:
            return await asyncio.wait_for(asyncio.shield(fut), timeout=deadline)
        except asyncio.TimeoutError:
            self._pending.pop(call_id, None)
            raise TimeoutError(f"No response for method={method!r} within {deadline}s")

    async def stream(
        self,
        method: str,
        params: dict[str, Any] | None = None,
        timeout: float | None = None,
        traceparent: str | None = None,
    ) -> AsyncGenerator[Any, None]:
        """
        Send a streaming JSON-RPC call. Yields each chunk as it arrives.
        The sidecar handler must return a StreamResponse wrapping a generator.
        Raises AsyncBridgeError on remote error, TimeoutError on chunk timeout.
        """
        if self._closed or self._proc is None:
            raise RuntimeError("Bridge is not running")

        call_id = str(uuid.uuid4())
        q: asyncio.Queue = asyncio.Queue()
        self._stream_pending[call_id] = q

        request: dict[str, Any] = {
            "id": call_id,
            "method": method,
            "params": params or {},
            "stream": True,
        }
        if traceparent is not None:
            request["traceparent"] = traceparent

        await self._send_raw(json.dumps(request, separators=(",", ":")) + "\n")

        deadline = timeout if timeout is not None else self._call_timeout

        try:
            while True:
                try:
                    kind, value = await asyncio.wait_for(q.get(), timeout=deadline)
                except asyncio.TimeoutError:
                    self._stream_pending.pop(call_id, None)
                    raise TimeoutError(
                        f"Stream timeout for method={method!r} after {deadline}s"
                    )
                if kind == "done":
                    return
                elif kind == "error":
                    raise AsyncBridgeError(
                        value.get("code"), value.get("message", "stream error")
                    )
                else:  # chunk
                    yield value
        finally:
            self._stream_pending.pop(call_id, None)

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    async def _send_raw(self, line: str) -> None:
        if self._proc is None or self._proc.stdin is None:
            raise RuntimeError("Child stdin is not available")
        encoded = line.encode("utf-8")
        self._proc.stdin.write(encoded)
        try:
            await self._proc.stdin.drain()
        except (BrokenPipeError, ConnectionResetError, OSError) as exc:
            raise RuntimeError("Child stdin pipe is broken") from exc

    async def _reader_loop(self) -> None:
        assert self._proc is not None
        stdout = self._proc.stdout
        if stdout is None:
            return

        try:
            while True:
                try:
                    raw_line = await stdout.readline()
                except asyncio.CancelledError:
                    raise
                except Exception:
                    break

                if not raw_line:
                    break  # EOF

                line = raw_line.decode("utf-8", errors="replace").strip()
                if not line:
                    continue

                try:
                    msg: dict[str, Any] = json.loads(line)
                except json.JSONDecodeError:
                    continue

                # Ready handshake
                if msg.get("ready") is True:
                    if self._ready_event is not None:
                        self._ready_event.set()
                    continue

                # Streaming chunk frame
                if "chunk" in msg and "result" not in msg and "error" not in msg:
                    call_id = msg.get("id")
                    sq = self._stream_pending.get(call_id)
                    if sq is not None:
                        await sq.put(("chunk", msg["chunk"]))
                    continue

                # RPC response dispatch
                call_id = msg.get("id")
                if call_id is None:
                    continue

                # Terminal frame for a stream call
                sq = self._stream_pending.get(call_id)
                if sq is not None:
                    self._stream_pending.pop(call_id, None)
                    if "error" in msg:
                        await sq.put(("error", msg["error"]))
                    else:
                        await sq.put(("done", None))
                    continue

                # Regular RPC future
                fut = self._pending.pop(call_id, None)
                if fut is None or fut.done():
                    continue

                if "error" in msg:
                    err = msg["error"]
                    fut.set_exception(
                        AsyncBridgeError(err.get("code"), err.get("message", "unknown error"))
                    )
                else:
                    fut.set_result(msg.get("result"))

        except asyncio.CancelledError:
            pass
        finally:
            # EOF or cancelled - wake any remaining waiters
            for fut in self._pending.values():
                if not fut.done():
                    fut.set_exception(
                        AsyncBridgeError(-32000, "child process exited")
                    )
            self._pending.clear()

            for sq in self._stream_pending.values():
                await sq.put(("error", {"code": -32000, "message": "child process exited"}))
            self._stream_pending.clear()

            # Prevent start() from hanging if child dies before ready.
            if self._ready_event is not None and not self._ready_event.is_set():
                self._ready_event.set()

    async def _stderr_drain(self) -> None:
        if self._proc is None or self._proc.stderr is None:
            return
        try:
            while True:
                chunk = await self._proc.stderr.read(4096)
                if not chunk:
                    break
        except (asyncio.CancelledError, Exception):
            pass
