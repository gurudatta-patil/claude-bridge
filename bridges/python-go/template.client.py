"""
GoBridge — Python client for a compiled Go sidecar.

Protocol
--------
- Newline-delimited JSON over stdio
- Child writes {"ready":true} as its first line before accepting requests
- Request:  {"id": "<uuid>", "method": "<name>", "params": <any>}
- Success:  {"id": "<uuid>", "result": <any>}
- Error:    {"id": "<uuid>", "error": {"code": <int>, "message": "<str>"}}
- stdin EOF signals the child to exit cleanly
"""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path
from typing import Any

# Adjust the import path to locate the shared module.
sys.path.insert(0, str(Path(__file__).parent.parent.parent / "shared" / "python"))
from bridge_client import BridgeClientBase, BridgeError  # noqa: E402


class GoBridgeError(BridgeError):
    """Raised when the Go sidecar returns a JSON-RPC error object."""

    def __repr__(self) -> str:
        return f"GoBridgeError(code={self.code}, message={self.message!r})"


class GoBridge(BridgeClientBase):
    """
    Spawns a compiled Go binary as a subprocess and communicates with it via
    newline-delimited JSON-RPC over stdio.

    Usage (context manager — preferred)
    ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
    with GoBridge("/path/to/binary") as bridge:
        result = bridge.call("add", {"a": 1, "b": 2})

    Usage (manual)
    ~~~~~~~~~~~~~~
    bridge = GoBridge("/path/to/binary")
    bridge.start()
    result = bridge.call("echo", {"message": "hello"})
    bridge.stop()
    """

    # How long (seconds) to wait for {"ready":true} on startup.
    READY_TIMEOUT: float = 10.0

    # How long (seconds) to wait for a single RPC call.
    CALL_TIMEOUT: float = 30.0

    def __init__(
        self,
        binary: str | Path,
        args: list[str] | None = None,
        env: dict[str, str] | None = None,
        call_timeout: float = CALL_TIMEOUT,
        ready_timeout: float = READY_TIMEOUT,
    ) -> None:
        cmd = [str(Path(binary))] + (args or [])
        super().__init__(cmd, ready_timeout=ready_timeout, call_timeout=call_timeout, env=env)
        self.binary = Path(binary)

    # ------------------------------------------------------------------
    # Build helper
    # ------------------------------------------------------------------

    @staticmethod
    def build(source_dir: str | Path, output: str | Path | None = None) -> Path:
        """
        Run ``go build`` in *source_dir* and return the path to the binary.
        """
        source_dir = Path(source_dir).resolve()
        if output is None:
            name = source_dir.name
            if sys.platform == "win32":
                name += ".exe"
            output = source_dir / name
        else:
            output = Path(output).resolve()

        cmd = ["go", "build", "-o", str(output), "."]
        result = subprocess.run(cmd, cwd=str(source_dir), capture_output=True, text=True)
        if result.returncode != 0:
            raise RuntimeError(
                f"go build failed (exit {result.returncode}):\n{result.stderr}"
            )
        return output

    # ------------------------------------------------------------------
    # Lifecycle overrides to validate binary exists
    # ------------------------------------------------------------------

    def start(self) -> None:
        if not self.binary.exists():
            raise FileNotFoundError(f"Go binary not found: {self.binary}")
        super().start()

    # Alias stop() → close() to match original API.
    def stop(self) -> None:
        self.close()

    # ------------------------------------------------------------------
    # Calling
    # ------------------------------------------------------------------

    def call(self, method: str, params: Any = None, timeout: float | None = None) -> Any:
        """
        Send a JSON-RPC request and block until the response arrives.
        """
        return self._call(method, params if isinstance(params, dict) else {"value": params}, timeout=timeout)
