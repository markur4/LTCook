"""Native Linux Podman installation and readiness commands."""

from __future__ import annotations

import os
import shutil
from pathlib import Path

from ._common import SetupError, run


def install_podman(_deployment: Path, environment: dict[str, str]) -> str:
    """Install from the host distribution's supported package manager."""
    release = Path("/etc/os-release")
    if not release.is_file():
        raise SetupError("Cannot identify this Linux distribution to install Podman.")
    values = dict(
        line.split("=", 1)
        for line in release.read_text().splitlines()
        if "=" in line and not line.startswith("#")
    )
    identifier = values.get("ID", "").strip('"').lower()
    if identifier in {"debian", "ubuntu", "linuxmint"}:
        manager, command = (
            shutil.which("apt-get"),
            ["apt-get", "install", "-y", "podman"],
        )
    elif identifier in {"fedora", "rhel", "centos", "rocky", "almalinux"}:
        manager, command = shutil.which("dnf"), ["dnf", "install", "-y", "podman"]
    elif identifier in {"opensuse", "opensuse-leap", "opensuse-tumbleweed"}:
        manager, command = (
            shutil.which("zypper"),
            ["zypper", "--non-interactive", "install", "podman"],
        )
    elif identifier in {"arch", "manjaro"}:
        manager, command = (
            shutil.which("pacman"),
            ["pacman", "-S", "--noconfirm", "podman"],
        )
    elif identifier == "alpine":
        manager, command = shutil.which("apk"), ["apk", "add", "podman"]
    else:
        raise SetupError(
            f"No supported Podman package recipe for Linux ID={identifier!r}."
        )
    if manager is None:
        raise SetupError("The supported native Linux package manager is unavailable.")
    executable = shutil.which("sudo", path=environment.get("PATH"))
    if os.geteuid() != 0:
        if executable is None:
            raise SetupError(
                "Installing Podman requires root or sudo on this Linux host."
            )
        command = [executable, *command]
    run(command, environment=environment)
    result = shutil.which("podman", path=environment.get("PATH"))
    if result is None:
        raise SetupError("Package installation completed but Podman is not on PATH.")
    return result


def ensure_machine(_podman: str, _environment: dict[str, str]) -> None:
    """Linux Podman uses the native engine and has no managed VM machine."""
