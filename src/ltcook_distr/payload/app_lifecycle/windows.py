"""Native Windows Podman installer and non-destructive machine selection."""

from __future__ import annotations

import json
import platform
import shutil
from pathlib import Path

from ._common import PODMAN_RELEASE, SetupError, download, run

INSTALLER_DIGEST = "fc8960481e6165b5d1ef05970a11b691b13d434d1f97ceb29b8be6f3902ba86c"


def install_podman(deployment: Path, environment: dict[str, str]) -> str:
    """Launch the official native Windows installer and verify its installed CLI."""
    if platform.machine().lower() not in {"amd64", "x86_64"}:
        raise SetupError(
            "The supported official Podman installer target is Windows x64."
        )
    installer = deployment / "podman-installer-windows-amd64.exe"
    url = f"https://github.com/podman-container-tools/podman/releases/download/v{PODMAN_RELEASE}/{installer.name}"
    download(url, installer, INSTALLER_DIGEST)
    run([str(installer)], environment=environment)
    executable = shutil.which(
        "podman.exe", path=environment.get("PATH")
    ) or shutil.which("podman", path=environment.get("PATH"))
    program_files = environment.get("ProgramFiles")
    if executable is None and program_files:
        candidate = Path(program_files) / "RedHat" / "Podman" / "podman.exe"
        if candidate.is_file():
            executable = str(candidate)
    if executable is None:
        raise SetupError(
            "Official Podman installer returned but podman.exe was not found; finish setup or refresh PATH."
        )
    return executable


def ensure_machine(podman: str, environment: dict[str, str]) -> None:
    """Reuse a running machine or initialize/start the default without reset."""
    result = run(
        [podman, "machine", "list", "--format", "json"], environment=environment
    )
    try:
        machines = json.loads(result.stdout)
    except json.JSONDecodeError as exc:
        raise SetupError("Podman machine list returned invalid JSON.") from exc
    if any(
        item.get("Running") is True or item.get("State") == "running"
        for item in machines
    ):
        return
    suitable = next(
        (item for item in machines if item.get("Name") == "podman-machine-default"),
        None,
    )
    if suitable is None:
        run([podman, "machine", "init"], environment=environment)
        suitable_name = "podman-machine-default"
    else:
        suitable_name = str(suitable["Name"])
    run([podman, "machine", "start", suitable_name], environment=environment)
