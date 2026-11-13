"""Translate AppRC declarations into LTCook-owned Pi configuration."""

from __future__ import annotations

import json
import os
from collections.abc import Mapping
from pathlib import Path

from apprc import ResolveOptions

from ltcook.config.app import APP_RC
from ltcook.config.bundle import LtcookConfig


def resolve_config(
    workspace_root: str | Path | None = None,
    *,
    environment: Mapping[str, str] | None = None,
):
    """Resolve the target workspace without mutating process environment.

    :param workspace_root: Workspace directory selected for this invocation.
    :param environment: Original shell environment, never AppRC's prior output.
    :return: An immutable AppRC snapshot.
    """
    return APP_RC.resolve(
        ResolveOptions(workspace=str(workspace_root) if workspace_root else None),
        environment=dict(os.environ if environment is None else environment),
    )


def pi_documents(
    config: LtcookConfig,
    *,
    owned_dir: str | Path,
    pi_home: str | Path | None = None,
) -> dict[Path, dict[str, object]]:
    """Build the Pi web configuration under LTCook-owned paths only.

    :param config: Settings resolved for one workspace.
    :param owned_dir: AppRC-owned deployment application directory.
    :param pi_home: AppRC-owned Pi home specific to this workspace.
    :return: Exact native target and JSON body.
    """
    deployment_root = Path(owned_dir).expanduser().parent.resolve()
    agent_home = (
        Path(pi_home or config.pi.home or deployment_root / "pi").expanduser().resolve()
    )
    if not agent_home.is_relative_to(deployment_root):
        raise ValueError(
            "PI_CODING_AGENT_DIR must resolve inside the LTCook deployment."
        )
    web: dict[str, object] = {
        "provider": "searxng",
        "searxngBaseUrl": config.web.searxng_url,
        "crawl4aiBaseUrl": config.web.crawl4ai_url,
        "crawl4aiApiToken": "$CRAWL4AI_API_TOKEN",
        "webSearch": {"allowedProviders": ["searxng"]},
        "workflow": "none",
        "fetch": {"allowedModes": ["readable", "raw"], "defaultMode": "readable"},
        "fetchRouting": {
            "providers": ["http", "crawl4ai"],
            "allowRemoteHostedProviders": False,
        },
        "image": {"enabled": False},
        "pdf": {"enabled": False},
        "tools": {"sourceCheck": {"enabled": False}, "curator": {"enabled": False}},
        "commands": {"curator": {"enabled": False}},
        "ssrf": {
            "allowRanges": [
                item.strip()
                for item in config.web.ssrf_allow_ranges.split(",")
                if item.strip()
            ]
        },
    }
    return {agent_home / "web-search.json": web}


def write_pi_config(
    config: LtcookConfig,
    *,
    owned_dir: str | Path,
    pi_home: str | Path | None = None,
) -> tuple[Path, ...]:
    """Atomically publish AppRC-derived Pi settings with private permissions.

    :param config: Settings for the selected workspace.
    :param owned_dir: AppRC-owned deployment application directory.
    :param pi_home: Workspace-specific AppRC-owned Pi home.
    :return: Pi configuration paths written by LTCook.
    """
    import tempfile

    written: list[Path] = []
    for path, document in pi_documents(
        config,
        owned_dir=owned_dir,
        pi_home=pi_home,
    ).items():
        path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        fd, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as stream:
                json.dump(document, stream, ensure_ascii=False, indent=2)
                stream.write("\n")
                stream.flush()
                os.fsync(stream.fileno())
            os.chmod(temporary, 0o600)
            os.replace(temporary, path)
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)
        written.append(path)
    return tuple(written)
