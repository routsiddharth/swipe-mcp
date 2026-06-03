"""Guards the frontend tool registry (tools.js) end-to-end, headless.

Runs tests/tools_smoke.js under Node: it loads the real engine + tool registry,
drives window.SwipeTools.dispatch() the way app.jsx does, and asserts the
returned plans. This is the deepening's payoff — the tool interface is testable
without React or a backend.
"""
import pathlib
import shutil
import subprocess

import pytest

ROOT = pathlib.Path(__file__).resolve().parent


def test_tool_registry_dispatch_smoke():
    node = shutil.which("node")
    if not node:
        pytest.skip("node not installed — cannot run the JS tool-seam smoke test")
    proc = subprocess.run(
        [node, str(ROOT / "tools_smoke.js")],
        capture_output=True,
        text=True,
        cwd=str(ROOT.parent),
    )
    assert proc.returncode == 0, f"tool-seam smoke failed:\n{proc.stdout}\n{proc.stderr}"
    assert proc.stdout.strip().endswith("OK")
