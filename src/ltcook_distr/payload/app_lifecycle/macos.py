"""Native macOS Podman installer and non-destructive machine selection."""

from __future__ import annotations

import json
import platform
import shutil
from pathlib import Path

from ._common import PODMAN_RELEASE, SetupError, download, run

INSTALLER_DIGESTS = {
    "amd64": "4244eb0628e2a652b4ce7a51d04bf1a374866c8d3b825dd29c10c93d9f8b411a",
    "arm64": "04a9eb3b0d5056cd9f1e9d57c9c7128b93d7d65815f7945d6d868c4e5fa14ddc",
}


def install_podman(deployment: Path, environment: dict[str, str]) -> str:
    """Download the official signed installer and require an interactive install."""
    machine = {"arm64": "arm64", "x86_64": "amd64"}.get(platform.machine())
    if machine is None:
        raise SetupError(
            f"No official macOS Podman installer for {platform.machine()}."
        )
    installer = deployment / f"podman-installer-macos-{machine}.pkg"
    url = f"https://github.com/podman-container-tools/podman/releases/download/v{PODMAN_RELEASE}/{installer.name}"
    download(url, installer, INSTALLER_DIGESTS[machine])
    sudo = shutil.which("sudo", path=environment.get("PATH"))
    if sudo is None:
        raise SetupError(
            "The official Podman installer requires sudo and normal macOS elevation."
        )
    run(
        [sudo, "installer", "-pkg", str(installer), "-target", "/"],
        environment=environment,
    )
    executable = shutil.which("podman", path=environment.get("PATH"))
    if executable is None:
        executable = next(
            (
                str(path)
                for path in (
                    Path("/opt/podman/bin/podman"),
                    Path("/usr/local/bin/podman"),
                    Path("/opt/homebrew/bin/podman"),
                )
                if path.is_file()
            ),
            None,
        )
    if executable is None:
        raise SetupError(
            "Official Podman installation completed but podman was not found in known native locations."
        )
    return executable


def ensure_machine(podman: str, environment: dict[str, str]) -> None:
    """Reuse the current default running machine or start it without resetting."""
    result = run(
        [podman, "machine", "list", "--format", "json"], environment=environment
    )
    try:
        machines = json.loads(result.stdout)
    except json.JSONDecodeError as exc:
        raise SetupError("Podman machine list returned invalid JSON.") from exc
    running = [
        item
        for item in machines
        if item.get("Running") is True or item.get("State") == "running"
    ]
    if running:
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
