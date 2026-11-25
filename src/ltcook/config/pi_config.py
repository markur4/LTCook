"""Translate AppRC declarations into LTCook-owned Pi configuration."""

from __future__ import annotations

import json
import os
from collections.abc import Mapping
from pathlib import Path

from apprc import ResolveOptions

from ltcook.config.app import APP_RC
from ltcook.config.bundle import LtcookConfig
from ltcook_distr.payload.app_lifecycle.prepare_ollama import (
    CONTEXT_TOKENS,
    ENDPOINT,
    EVAL_MODEL,
    local_ollama_endpoint,
)


def resolve_global_config(*, environment: Mapping[str, str] | None = None):
    """Read user settings without consulting workspace selectors or registry.

    :param environment: Original shell environment for global settings.
    :return: AppRC's immutable snapshot of user-level configuration.
    """
    return (
        APP_RC.manage(
            environment=dict(os.environ if environment is None else environment)
        )
        .inspect(include_workspace=False)
        .resolved
    )


def resolve_config(
    workspace_root: str | Path | None = None,
    *,
    environment: Mapping[str, str] | None = None,
):
    """Resolve an existing directory, retaining initialized AppRC project layers.

    :param workspace_root: Explicit project directory, or None for global settings.
    :param environment: Original shell environment, never AppRC's prior output.
    :return: An immutable AppRC snapshot, without creating project files.
    """
    shell = dict(os.environ if environment is None else environment)
    if workspace_root is None:
        return resolve_global_config(environment=shell)
    root = Path(workspace_root).expanduser().resolve()
    if not root.is_dir():
        raise ValueError(f"Workspace directory does not exist: {root}")
    if not (root / APP_RC.schema.workspace_dotenv_filename).is_file():
        return resolve_global_config(environment=shell)
    return APP_RC.resolve(ResolveOptions(workspace=str(root)), environment=shell)


def pi_documents(
    config: LtcookConfig,
    *,
    owned_dir: str | Path,
    pi_home: str | Path | None = None,
    runtime_environment: Mapping[str, str] | None = None,
) -> dict[Path, dict[str, object]]:
    """Build the Pi web configuration under LTCook-owned paths only.

    :param config: Settings resolved for one workspace.
    :param owned_dir: AppRC-owned deployment application directory.
    :param pi_home: AppRC-owned Pi home specific to this workspace.
    :param runtime_environment: Launch settings after applying global model scope.
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
    sol = {
        "id": "gpt-6.2-sol",
        "name": "GPT-6.2 Sol",
        "reasoning": True,
        "input": ["text", "image"],
        "thinkingLevelMap": {
            "off": None,
            "minimal": None,
            "low": "low",
            "medium": "medium",
            "high": "high",
            "xhigh": "xhigh",
            "max": "max",
        },
    }
    effective = runtime_environment or {}
    ollama_endpoint = local_ollama_endpoint(
        effective.get("LTCOOK_OLLAMA_ENDPOINT", config.runtime.ollama_endpoint)
    )
    local_tiny_model = effective.get(
        "LTCOOK_MODEL_LOCAL_TINY", config.runtime.local_tiny_model
    ).strip()
    local_model = effective.get(
        "LTCOOK_MODEL_LOCAL", config.runtime.local_model
    ).strip()
    ollama_models: list[dict[str, object]] = [
        {
            "id": EVAL_MODEL,
            "name": "LTCook Bonsai 2 27B (65536 context)",
            "contextWindow": CONTEXT_TOKENS,
            "maxTokens": 2048,
            "reasoning": True,
            "thinkingLevelMap": {"off": "none", "low": "low", "high": "high"},
        }
    ]
    for model in dict.fromkeys((local_tiny_model, local_model)):
        if not model or model == EVAL_MODEL:
            continue
        ollama_models.append(
            {
                "id": model,
                "baseUrl": f"{ollama_endpoint}/v1",
                "contextWindow": 32768,
                "maxTokens": 4096,
                "reasoning": True,
                "compat": {"supportsReasoningEffort": True},
                "thinkingLevelMap": {
                    "off": "none",
                    "minimal": None,
                    "low": "low",
                    "medium": "medium" if model == local_model else None,
                    "high": "high",
                    "xhigh": None,
                    "max": None,
                },
            }
        )
    models: dict[str, object] = {
        "providers": {
            "openai-codex": {
                "models": [
                    {
                        **sol,
                        "api": "openai-codex-responses",
                        "baseUrl": "https://chatgpt.com/backend-api",
                    }
                ],
            },
            "openai": {
                "models": [
                    {
                        **sol,
                        "api": "openai-responses",
                        "baseUrl": "https://api.openai.com/v1",
                    }
                ],
            },
            "ollama": {
                "baseUrl": f"{ENDPOINT}/v1",
                "api": "openai-completions",
                "apiKey": "ollama",
                "models": ollama_models,
            },
        }
    }
    return {agent_home / "web-search.json": web, agent_home / "models.json": models}


def _merge_model_providers(old: dict, new: dict) -> dict:
    """Keep existing model IDs usable when a configured alias is edited."""
    providers = {**old}
    for name, managed in new.items():
        existing = old.get(name)
        if not isinstance(existing, dict):
            providers[name] = managed
            continue
        configured = existing.get("models")
        managed_models = managed["models"]
        if isinstance(configured, list):
            managed_ids = {model["id"] for model in managed_models}
            managed_models = [
                *(
                    entry
                    for entry in configured
                    if isinstance(entry, dict)
                    and isinstance(entry.get("id"), str)
                    and entry["id"] not in managed_ids
                ),
                *managed_models,
            ]
        providers[name] = {**existing, **managed, "models": managed_models}
    return providers


def write_pi_config(
    config: LtcookConfig,
    *,
    owned_dir: str | Path,
    pi_home: str | Path | None = None,
    runtime_environment: Mapping[str, str] | None = None,
) -> tuple[Path, ...]:
    """Atomically publish AppRC-derived Pi settings with private permissions.

    :param config: Settings for the selected workspace.
    :param owned_dir: AppRC-owned deployment application directory.
    :param pi_home: Workspace-specific AppRC-owned Pi home.
    :param runtime_environment: Launch settings after applying global model scope.
    :return: Pi configuration paths written by LTCook.
    """
    import tempfile

    written: list[Path] = []
    for path, document in pi_documents(
        config,
        owned_dir=owned_dir,
        pi_home=pi_home,
        runtime_environment=runtime_environment,
    ).items():
        path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        if path.name == "models.json" and path.exists():
            try:
                existing = json.loads(path.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError) as exc:
                raise ValueError("Managed Pi models.json is not valid JSON.") from exc
            if isinstance(existing, dict):
                existing_providers = existing.get("providers", {})
                new_providers = document.get("providers", {})
                if isinstance(existing_providers, dict) and isinstance(
                    new_providers, dict
                ):
                    document = {
                        **existing,
                        "providers": _merge_model_providers(
                            existing_providers, new_providers
                        ),
                    }
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
