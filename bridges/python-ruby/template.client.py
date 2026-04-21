"""
Stitch: Python (client) → Ruby (sidecar) template.

Copy this file, point SIDECAR_CMD at your Ruby script, and use RubyBridge
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
# Configuration – override before instantiating RubyBridge
# ---------------------------------------------------------------------------
SIDECAR_CMD: list[str] = ["ruby", "sidecar.rb"]
READY_TIMEOUT: float = 10.0   # seconds to wait for {"ready": true}
CALL_TIMEOUT: float  = 30.0   # seconds to wait for a response per call


# ---------------------------------------------------------------------------
# Bridge
# ---------------------------------------------------------------------------

class RubyBridge(BridgeClientBase):
    """Thin wrapper that speaks JSON-RPC over stdio with a Ruby child process.

    Usage (context manager – recommended)::

        with RubyBridge() as bridge:
            result = bridge.call("add", {"a": 1, "b": 2})

        # JRuby runtime:
        with RubyBridge(runtime='jruby') as bridge:
            result = bridge.call("add", {"a": 1, "b": 2})

    Usage (manual lifecycle)::

        bridge = RubyBridge()
        try:
            result = bridge.call("echo", {"msg": "hi"})
        finally:
            bridge.close()
    """

    def __init__(
        self,
        cmd: list[str] | None = None,
        ready_timeout: float = READY_TIMEOUT,
        call_timeout: float = CALL_TIMEOUT,
        env: dict[str, str] | None = None,
        runtime: str = 'ruby',
    ) -> None:
        if cmd is None:
            cmd = [runtime, "sidecar.rb"]
        super().__init__(cmd, ready_timeout=ready_timeout, call_timeout=call_timeout, env=env)

    def call(self, method: str, params: dict[str, Any] | None = None) -> Any:
        """Send a JSON-RPC request and block until the response arrives.

        Returns the ``result`` field on success.
        Raises :class:`BridgeError` if the sidecar returns an error object.
        Raises :class:`TimeoutError` if no response arrives within the timeout.
        """
        return self._call(method, params)
