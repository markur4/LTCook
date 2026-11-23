"""Exercise scheduling with real offline Pi and Paseo processes on Linux."""

from __future__ import annotations

import os
import shutil
import signal
import subprocess
import sys
from pathlib import Path

import pytest


@pytest.mark.system
@pytest.mark.skipif(sys.platform != "linux", reason="Linux process acceptance")
def test_real_pi_paseo_clockwork(tmp_path: Path) -> None:
    """Run native tools through a scheduled Pass with correction and recovery."""
    _run_native_acceptance(tmp_path, "clockwork-acceptance.ts")


@pytest.mark.system
@pytest.mark.skipif(sys.platform != "linux", reason="Linux process acceptance")
def test_native_paseo_leader_adoption(tmp_path: Path) -> None:
    """Adopt one native Leader and preserve parent bindings through recovery."""
    _run_native_acceptance(tmp_path, "paseo-leader-acceptance.ts")


@pytest.mark.system
@pytest.mark.skipif(sys.platform != "linux", reason="Linux process acceptance")
def test_native_paseo_workspace_mcp(tmp_path: Path) -> None:
    """Call the local MCP tools through actual Pi and Codex sessions."""
    if shutil.which("codex") is None:
        pytest.skip("The local Codex CLI is required for the offline MCP fixture.")
    _run_native_acceptance(tmp_path, "paseo-workspace-mcp.ts")


@pytest.mark.system
@pytest.mark.skipif(
    sys.platform != "linux", reason="Linux Bubblewrap process acceptance"
)
@pytest.mark.parametrize(
    "mode",
    [
        "quick",
        "behavior",
        "current",
        "cancel",
        "bad-verification",
        "masked-verification-failure",
        "no-delegation",
        "repeated",
        "full",
        "audit-error",
        "compaction",
        "compaction-cancel",
        "validation-recovery",
        "compaction-error",
        "fallback-success",
        "no-scheduled-work",
        "unfinished-handoff",
        "settlement-recovery",
    ],
)
def test_agent_evaluation_runtime(tmp_path: Path, mode: str) -> None:
    """Exercise the sandboxed evaluation path with real native tools and local scripts."""
    assert shutil.which("bwrap"), (
        "Install Bubblewrap before evaluation system acceptance"
    )
    _run_native_acceptance(tmp_path, "evaluation-acceptance.ts", mode)


def _run_native_acceptance(tmp_path: Path, entry: str, *arguments: str) -> None:
    """Run one maintained native acceptance fixture with bounded process cleanup."""
    root = Path(__file__).resolve().parents[3]
    bun = shutil.which(os.environ.get("BUN", "bun"))
    node = shutil.which("node")
    assert bun and node, "Run the locked repository setup before system acceptance"
    assert (root / "runtime/dist/integrations/pi-rpc.js").is_file(), (
        "Build the runtime before system acceptance: bun run build"
    )
    environment = {
        key: value
        for key, value in os.environ.items()
        if not key.startswith(("LTCOOK_", "PASEO_", "PI_", "OPENAI_", "ANTHROPIC_"))
    }
    environment.update(
        HOME=str(tmp_path),
        LTCOOK_TEST_NODE=node,
        PI_OFFLINE="1",
        DO_NOT_TRACK="1",
    )
    if entry == "paseo-workspace-mcp.ts" and (
        colgrep := os.environ.get("LTCOOK_COLGREP_DEPLOYMENT")
    ):
        environment["LTCOOK_COLGREP_DEPLOYMENT"] = colgrep
    with subprocess.Popen(
        [bun, f"tests/runtime/system/{entry}", *(arguments or (str(tmp_path),))],
        cwd=root,
        env=environment,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        start_new_session=True,
    ) as child:
        try:
            output, _ = child.communicate(timeout=180)
        except subprocess.TimeoutExpired:
            os.killpg(child.pid, signal.SIGTERM)
            try:
                output, _ = child.communicate(timeout=10)
            except subprocess.TimeoutExpired:
                os.killpg(child.pid, signal.SIGKILL)
                output, _ = child.communicate(timeout=10)
            pytest.fail(f"Native clockwork acceptance timed out:\n{output}")
    assert child.returncode == 0, output
    assert '"result":"passed"' in output, output
