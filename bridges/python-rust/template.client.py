"""
Stitch: Python client for a Rust sidecar process.

Protocol:
  - Newline-delimited JSON over stdio
  - Child writes {"ready": true} before accepting requests
  - stdin EOF signals the child to exit
  - Request:  {"id": "<uuid>", "method": "<name>", "params": {...}}
  - Success:  {"id": "<uuid>", "result": <any>}
  - Error:    {"id": "<uuid>", "error": {"code": <int>, "message": "<str>"}}
"""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path
from typing import Any

# Adjust the import path to locate the shared module.
sys.path.insert(0, str(Path(__file__).parent.parent.parent / "shared" / "python"))
from bridge_client import BridgeClientBase, BridgeError  # noqa: E402


class RustBridge(BridgeClientBase):
    """
    Spawn a compiled Rust binary as a child process and communicate with it
    over newline-delimited JSON on stdin/stdout.

    Usage (context manager — preferred):

        with RustBridge("./target/release/my_sidecar") as bridge:
            result = bridge.call("add", {"a": 1, "b": 2})

    Usage (manual):

        bridge = RustBridge("./target/release/my_sidecar")
        bridge.start()
        result = bridge.call("echo", {"msg": "hello"})
        bridge.stop()
    """

    def __init__(
        self,
        binary_path: str | Path,
        *,
        args: list[str] | None = None,
        startup_timeout: float = 10.0,
        call_timeout: float = 30.0,
        env: dict[str, str] | None = None,
    ) -> None:
        binary = Path(binary_path)
        cmd = [str(binary)] + (args or [])
        super().__init__(cmd, ready_timeout=startup_timeout, call_timeout=call_timeout, env=env)

    def call(
        self,
        method: str,
        params: dict[str, Any] | None = None,
        *,
        timeout: float | None = None,
    ) -> Any:
        """
        Send a JSON-RPC request and block until the response arrives.

        Returns the ``result`` field on success.
        Raises :class:`BridgeError` if the sidecar returns an error object.
        Raises :class:`TimeoutError` if no response arrives within *timeout* seconds.
        Raises :class:`RuntimeError` if the bridge is not started or has stopped.
        """
        return self._call(method, params, timeout=timeout)

    # stop() is an alias for close() matching the original API.
    def stop(self, *, force: bool = False) -> None:
        self.close(force=force)


# ---------------------------------------------------------------------------
# Optional compile helper
# ---------------------------------------------------------------------------

def build_sidecar(
    manifest_dir: str | Path,
    *,
    release: bool = True,
    target: str | None = None,
) -> Path:
    """
    Run ``cargo build`` in *manifest_dir* and return the path to the binary.

    Raises :class:`subprocess.CalledProcessError` if the build fails.
    """
    manifest_dir = Path(manifest_dir).resolve()
    cmd = ["cargo", "build"]
    if release:
        cmd.append("--release")
    if target:
        cmd.extend(["--target", target])

    subprocess.run(cmd, cwd=manifest_dir, check=True)

    # Determine binary name from Cargo.toml
    cargo_toml = manifest_dir / "Cargo.toml"
    binary_name: str | None = None
    if cargo_toml.exists():
        for raw_line in cargo_toml.read_text().splitlines():
            stripped = raw_line.strip()
            if stripped.startswith("name") and "=" in stripped:
                binary_name = stripped.split("=", 1)[1].strip().strip('"').strip("'")
                break

    if binary_name is None:
        binary_name = manifest_dir.name

    profile_dir = "release" if release else "debug"
    target_dir = manifest_dir / "target"
    if target:
        binary_path = target_dir / target / profile_dir / binary_name
    else:
        binary_path = target_dir / profile_dir / binary_name

    # Windows
    if sys.platform == "win32":
        binary_path = binary_path.with_suffix(".exe")

    if not binary_path.exists():
        raise FileNotFoundError(
            f"Build succeeded but binary not found at {binary_path}"
        )

    return binary_path
