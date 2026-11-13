"""Prepare a usable native Podman engine and explicitly selected Compose provider."""

from __future__ import annotations

import os
import platform
import re
import secrets
import shutil
from pathlib import Path

from . import linux, macos, windows
from ._common import SetupError, no_links, owned_directory, run, setup_lock, write_json


def _provider(environment: dict[str, str], deployment: Path) -> str:
    """Resolve or privately install one explicit Podman Compose provider."""
    configured = environment.get("PODMAN_COMPOSE_PROVIDER")
    if configured:
        path = Path(configured)
        found = (
            str(path)
            if path.is_absolute() and path.is_file()
            else shutil.which(configured, path=environment.get("PATH"))
        )
        if found is None:
            raise SetupError("Configured PODMAN_COMPOSE_PROVIDER is unavailable.")
        run([found, "--version"], environment=environment)
        return found
    for candidate in ("podman-compose", "docker-compose"):
        found = shutil.which(candidate, path=environment.get("PATH"))
        if found:
            run([found, "--version"], environment=environment)
            return found
    uv = (
        environment.get("APPRC_UV_PATH")
        or environment.get("UV")
        or shutil.which("uv", path=environment.get("PATH"))
    )
    if uv is None or not Path(uv).is_file():
        raise SetupError(
            "A Compose provider is missing and AppRC's selected uv executable is unavailable."
        )
    provider_root = owned_directory(deployment / "compose-provider")
    provider_bin = provider_root / "bin"
    no_links(provider_bin)
    provider_bin.mkdir(mode=0o700, exist_ok=True)
    executable_names = (
        ("podman-compose.exe", "podman-compose")
        if os.name == "nt"
        else ("podman-compose",)
    )
    executable = next(
        (
            provider_bin / name
            for name in executable_names
            if (provider_bin / name).is_file()
        ),
        None,
    )
    if executable is None:
        run(
            [
                str(uv),
                "tool",
                "install",
                "--install-dir",
                str(provider_root),
                "--bin-dir",
                str(provider_bin),
                "podman-compose==1.6.0",
            ],
            environment=environment,
        )
        executable = next(
            (
                provider_bin / name
                for name in executable_names
                if (provider_bin / name).is_file()
            ),
            None,
        )
    if executable is None:
        raise SetupError(
            "uv completed but did not install a Compose provider executable."
        )
    run([str(executable), "--version"], environment=environment)
    return str(executable)


def _compose_project_name(deployment: Path) -> str:
    """Create/reuse an installation-specific Compose project identity."""
    marker = deployment / ".ltcook-compose-project"
    with setup_lock(deployment):
        no_links(marker)
        if marker.exists():
            project = marker.read_text(encoding="utf-8").strip()
        else:
            project = f"ltcook-{secrets.token_hex(6)}"
            marker.write_text(f"{project}\n", encoding="utf-8")
            marker.chmod(0o600)
    if re.fullmatch(r"ltcook-[0-9a-f]{12}", project) is None:
        raise SetupError("LTCook Compose project identity is invalid.")
    return project


def prepare_services(
    appdata: Path, *, environment: dict[str, str] | None = None
) -> Path:
    """Ensure Podman works during explicit application setup, never during status.

    :param appdata: AppRC-owned application data root.
    :param environment: Native setup command environment.
    :return: Path to the LTCook-only service preparation receipt.
    """
    env = dict(os.environ if environment is None else environment)
    deployment = owned_directory(appdata / "deployment")
    project_name = _compose_project_name(deployment)
    connection = env.get("LTCOOK_SERVICE_CONNECTION", "local")
    if connection not in {"local", "direct", "paseo-tunnel"}:
        raise SetupError(
            "LTCOOK_SERVICE_CONNECTION must be local, direct, or paseo-tunnel."
        )
    podman_path = ""
    provider = ""
    if connection == "local":
        selected = env.get("LTCOOK_PODMAN_EXECUTABLE") or shutil.which(
            "podman", path=env.get("PATH")
        )
        if selected is not None and not Path(selected).is_absolute():
            selected = shutil.which(selected, path=env.get("PATH"))
        module = {"Linux": linux, "Darwin": macos, "Windows": windows}.get(
            platform.system()
        )
        if module is None:
            raise SetupError(f"Podman setup is unsupported on {platform.system()}.")
        if selected is None:
            selected = module.install_podman(deployment, env)
        podman = Path(selected)
        if not podman.is_absolute() or not podman.is_file():
            raise SetupError("Podman executable is not an absolute existing file.")
        if platform.system() in {"Darwin", "Windows"}:
            module.ensure_machine(str(podman), env)
        run([str(podman), "info", "--format", "json"], environment=env)
        provider = _provider(env, deployment)
        podman_path = str(podman)
    service_dir = deployment / "service-config"
    service_dir.mkdir(mode=0o700, exist_ok=True)
    receipt = deployment / "services.json"
    write_json(
        receipt,
        {
            "schema": 1,
            "podman_executable": podman_path,
            "compose_provider": provider,
            "connection": connection,
            "compose_project": project_name,
            "compose_file": str(deployment / "app" / "services" / "compose.yaml"),
            "service_config_dir": str(service_dir),
        },
    )
    return receipt
