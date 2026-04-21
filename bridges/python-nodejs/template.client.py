"""
Stitch: Python (client) → Node.js (sidecar) template.

Copy this file, point SIDECAR_CMD at your Node.js script, and use NodeBridge
as a context manager or plain object.
"""

from __future__ import annotations

import sys
from pathlib import Path
from typing import Any

# Adjust the import path to locate the shared module.
sys.path.insert(0, str(Path(__file__).parent.parent.parent / "shared" / "python"))
from bridge_client import BridgeClientBase, BridgeError  # noqa: E402

# ---------------------------------------------------------------------------
# Configuration – override before instantiating NodeBridge
# ---------------------------------------------------------------------------
SIDECAR_CMD: list[str] = ["node", "sidecar.js"]
READY_TIMEOUT: float = 10.0   # seconds to wait for {"ready": true}
CALL_TIMEOUT: float  = 30.0   # seconds to wait for a response per call


# ---------------------------------------------------------------------------
# Bridge
# ---------------------------------------------------------------------------

class NodeBridge(BridgeClientBase):
    """Thin wrapper that speaks JSON-RPC over stdio with a Node.js child process.

    Usage (context manager – recommended)::

        with NodeBridge(["node", "my_sidecar.js"]) as bridge:
            result = bridge.call("add", {"a": 1, "b": 2})

    Usage (manual lifecycle)::

        bridge = NodeBridge(["node", "my_sidecar.js"])
        try:
            bridge.start()
            result = bridge.call("echo", {"msg": "hi"})
        finally:
            bridge.close()
    """

    def __init__(
        self,
        cmd: list[str] = SIDECAR_CMD,
        ready_timeout: float = READY_TIMEOUT,
        call_timeout: float = CALL_TIMEOUT,
        env: dict[str, str] | None = None,
    ) -> None:
        super().__init__(cmd, ready_timeout=ready_timeout, call_timeout=call_timeout, env=env)

    # ------------------------------------------------------------------
    # Public RPC helper – delegates to the shared base implementation
    # ------------------------------------------------------------------

    def call(self, method: str, params: dict[str, Any] | None = None) -> Any:
        """Send a JSON-RPC request and block until the response arrives.

        Returns the ``result`` field on success.
        Raises :class:`BridgeError` if the sidecar returns an error object.
        Raises :class:`TimeoutError` if no response arrives within the timeout.
        """
        return self._call(method, params)

    # ------------------------------------------------------------------
    # [CLAUDE_HANDLER_FUNCTIONS_HERE]
    #
    # Add typed convenience methods below, for example:
    #
    #   def echo(self, msg: str) -> str:
    #       return self._call("echo", {"msg": msg})
    #
    #   def add(self, a: float, b: float) -> float:
    #       return self._call("add", {"a": a, "b": b})
    # ------------------------------------------------------------------
