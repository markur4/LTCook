"""Exercise the packaged Paseo web app in isolated Linux Chromium."""

from __future__ import annotations

import os
import sys
from pathlib import Path

import pytest
from test_clockwork_acceptance import _run_native_acceptance


@pytest.mark.system
@pytest.mark.skipif(sys.platform != "linux", reason="Linux Chromium acceptance")
def test_native_paseo_team_flows(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Select Teams and open native Leader chats at desktop and mobile widths."""
    _configure_browser(monkeypatch)
    _run_native_acceptance(tmp_path, "paseo-gui-acceptance.ts")


@pytest.mark.system
@pytest.mark.skipif(sys.platform != "linux", reason="Linux Chromium acceptance")
def test_native_paseo_session_worktrees(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Follow, pin, and release actual worktrees in the bundled Changes view."""
    _configure_browser(monkeypatch)
    _run_native_acceptance(tmp_path, "paseo-worktrees-acceptance.ts")


def _configure_browser(monkeypatch: pytest.MonkeyPatch) -> None:
    configured = os.environ.get("AGENT_BROWSER_EXECUTABLE_PATH")
    browsers = sorted(
        (Path.home() / ".agent-browser" / "browsers").glob("chrome-*/chrome")
    )
    browser = Path(configured) if configured else browsers[-1] if browsers else None
    assert browser and browser.is_file(), (
        "Install Linux Chromium before GUI acceptance: "
        "node node_modules/agent-browser/bin/agent-browser.js install --with-deps"
    )
    monkeypatch.setenv("AGENT_BROWSER_EXECUTABLE_PATH", str(browser.resolve()))
