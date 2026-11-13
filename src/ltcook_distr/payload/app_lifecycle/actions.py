"""Application-specific setup, maintenance, and uninstall ownership actions."""

from __future__ import annotations

import hashlib
import json
import os
import re
import secrets
import shutil
from collections.abc import Callable, Mapping
from pathlib import Path

from apprc.definition.maintenance import (
    AppDataOperations,
    CacheOperations,
    MaintenanceHandlers,
    RemovalOperation,
    RemovalPlan,
    RemovalResult,
    StateOperations,
)
from apprc.definition.paths import ResourceKind

from ._common import SetupError, no_links, run


def prepare_project(
    source: object, appdata: Path, environment: Mapping[str, str]
) -> None:
    """Prepare private Node and service prerequisites before AppRC commits Python."""
    from .prepare_runtime import prepare_runtime
    from .prepare_services import prepare_services

    if appdata is None:
        raise SetupError("LTCook AppRC appdata path is required for setup.")
    prepare_runtime(source, appdata, environment=dict(environment))
    prepare_services(appdata, environment=dict(environment))


def ensure_service_secrets(environment: Mapping[str, str]) -> None:
    """Create missing service secrets through registered AppRC secret fields.

    :param environment: Captured setup environment used by AppRC resolution.
    :return: None.
    """
    try:
        from ltcook.config.app import APP_RC
        from ltcook.config.bundle import LtcookConfig
    except ImportError as exc:
        raise SetupError(
            "LTCook AppRC settings are unavailable for secret setup."
        ) from exc
    manager = APP_RC.manage(environment=dict(environment))
    manager.setup()
    configuration = manager.resolve().build(LtcookConfig)
    secret_fields = (
        (configuration.runtime.api_token, "LTCOOK_API_TOKEN"),
        (configuration.crawl4ai.api_token, "CRAWL4AI_API_TOKEN"),
        (configuration.searxng.secret, "SEARXNG_SECRET"),
    )
    for existing, reference in secret_fields:
        if existing:
            continue
        plan = manager.plan_update(reference, secrets.token_urlsafe(48), scope="user")
        manager.apply_edit(plan)


def initialize_service_secrets(
    interpreter: Path, environment: Mapping[str, str]
) -> None:
    """Run idempotent secret setup through the installed LTCook interpreter."""
    if not interpreter.is_absolute() or not interpreter.is_file():
        raise SetupError(
            "Installed LTCook interpreter is unavailable for secret setup."
        )
    code = (
        "import os\n"
        "from ltcook_distr.payload.app_lifecycle.actions import ensure_service_secrets\n"
        "ensure_service_secrets(os.environ)"
    )
    run([str(interpreter), "-I", "-c", code], environment=environment)


def _stop_owned_services(deployment: Path) -> None:
    """Stop only the recorded local LTCook Compose project before explicit purge."""
    receipt_path = deployment / "services.json"
    if not receipt_path.is_file():
        return
    no_links(receipt_path)
    try:
        receipt = json.loads(receipt_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise SetupError(
            "Cannot safely purge services with an invalid LTCook receipt."
        ) from exc
    if not isinstance(receipt, dict) or receipt.get("connection") != "local":
        return
    podman = Path(receipt.get("podman_executable", ""))
    provider = Path(receipt.get("compose_provider", ""))
    compose_file = Path(receipt.get("compose_file", ""))
    project_marker = deployment / ".ltcook-compose-project"
    no_links(project_marker)
    try:
        expected_project = project_marker.read_text(encoding="utf-8").strip()
    except OSError as exc:
        raise SetupError(
            "Cannot safely purge services without their LTCook project identity."
        ) from exc
    no_links(compose_file)
    expected_compose = deployment / "app" / "services" / "compose.yaml"
    if (
        receipt.get("schema") != 1
        or re.fullmatch(r"ltcook-[0-9a-f]{12}", expected_project) is None
        or receipt.get("compose_project") != expected_project
        or not podman.is_absolute()
        or not provider.is_absolute()
        or compose_file.resolve() != expected_compose.resolve()
        or not podman.is_file()
        or not provider.is_file()
        or not compose_file.is_file()
    ):
        raise SetupError(
            "Refusing to remove services outside the recorded LTCook project."
        )
    try:
        from ltcook.config.app import APP_RC
        from ltcook.config.bundle import LtcookConfig

        configuration = (
            APP_RC.manage(environment=dict(os.environ)).resolve().build(LtcookConfig)
        )
    except Exception as exc:
        raise SetupError(
            "Cannot resolve AppRC service credentials for explicit purge."
        ) from exc
    if not configuration.crawl4ai.api_token or not configuration.searxng.secret:
        raise SetupError(
            "AppRC service credentials are required to safely evaluate the Compose project."
        )
    environment = dict(os.environ)
    environment["CRAWL4AI_API_TOKEN"] = configuration.crawl4ai.api_token
    environment["SEARXNG_SECRET"] = configuration.searxng.secret
    environment["PODMAN_COMPOSE_PROVIDER"] = str(provider)
    run(
        [
            str(podman),
            "compose",
            "--project-name",
            expected_project,
            "-f",
            str(compose_file),
            "down",
            "--remove-orphans",
        ],
        environment=environment,
        cwd=compose_file.parent,
    )


def _operation(
    category: ResourceKind,
    target_for: Callable[[Path], tuple[Path, ...]],
) -> RemovalOperation:
    """Create exact-root maintenance operations with preview freshness checks."""

    def plan(root: Path) -> RemovalPlan:
        base = root.resolve(strict=True)
        targets = tuple(path for path in target_for(root) if path.exists())
        for path in targets:
            no_links(path)
            if not path.resolve().is_relative_to(base):
                raise SetupError("Maintenance target escapes its LTCook resource root.")
        digest = hashlib.sha256()
        for path in targets:
            digest.update(str(path.relative_to(base)).encode())
            if path.is_file():
                digest.update(path.read_bytes())
            else:
                for child in sorted(path.rglob("*")):
                    digest.update(str(child.relative_to(path)).encode())
                    if child.is_symlink():
                        digest.update(os.readlink(child).encode())
                    elif child.is_file():
                        digest.update(child.read_bytes())
        return RemovalPlan(category, base, targets, digest.hexdigest())

    def apply(operation: RemovalPlan) -> RemovalResult:
        current = plan(operation.root)
        if (
            current.revision != operation.revision
            or current.targets != operation.targets
        ):
            raise SetupError("Maintenance targets changed after preview.")
        removed: list[Path] = []
        for target in operation.targets:
            if category == "appdata" and target.name == "deployment":
                _stop_owned_services(target)
            no_links(target)
            if target.is_dir():
                shutil.rmtree(target)
            else:
                target.unlink()
            removed.append(target)
        return RemovalResult(tuple(removed))

    return RemovalOperation(plan=plan, apply=apply)


def maintenance_handlers() -> MaintenanceHandlers:
    """Expose only the deployment, caches, and logs owned by LTCook."""

    def appdata_targets(root: Path) -> tuple[Path, ...]:
        return (root / "deployment",)

    def cache_targets(root: Path) -> tuple[Path, ...]:
        return (root / "ltcook",)

    def state_targets(root: Path) -> tuple[Path, ...]:
        return (root / "logs", root / "ltcook")

    def info(root: Path) -> Mapping[str, object]:
        return {"ltcook_deployment_exists": (root / "deployment").is_dir()}

    return MaintenanceHandlers(
        appdata=AppDataOperations(
            info=info, purge=_operation("appdata", appdata_targets)
        ),
        cache=CacheOperations(
            info=info,
            clear=_operation("cache", cache_targets),
            purge=_operation("cache", cache_targets),
        ),
        state=StateOperations(
            info=info,
            reset=_operation("state", state_targets),
            purge=_operation("state", state_targets),
        ),
    )
