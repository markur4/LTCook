"""Verify and restart the active AppRC installation after an optional update."""

from __future__ import annotations

import hashlib
import json
import os
import re
import subprocess
import sys
import time
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from pathlib import Path
from uuid import UUID, uuid4

from apprc.definition.installation import EditableCheckout, RuntimeSlot

from ltcook._runtime_client import (
    RuntimeClientError,
    RuntimeStatus,
    probe_runtime,
    redact_runtime_token,
)
from ltcook.config.app import APP_RC
from ltcook.launch import resolve_launch
from ltcook_distr.payload.app_lifecycle._build import packaged_build
from ltcook_distr.payload.app_lifecycle._common import SetupError, no_links, write_json
from ltcook_distr.payload.app_lifecycle.prepare_runtime import (
    UPDATE_ATTEMPT_ENV,
    installed_runtime_record,
)

_START_SECONDS = 120


@dataclass(frozen=True)
class Registration:
    directory: Path
    generation: UUID
    revision: str
    deployment: Path
    prefix: Path
    ready: bool


@dataclass(frozen=True)
class InstalledBuild:
    fingerprint: str
    update_attempt: str | None


@dataclass(frozen=True)
class RestartResult:
    status: RuntimeStatus | None
    update_exit: int = 0
    update_error: str | None = None
    start_error: str | None = None
    registration_revision: str | None = None


def _result_path(environment: Mapping[str, str], installed: Registration) -> Path:
    scope = hashlib.sha256(os.fsencode(installed.directory)).hexdigest()[:16]
    return (
        Path(environment["LTCOOK_RUNTIME_STATE_DIR"]) / f"restart-result-{scope}.json"
    )


def save_restart_result(
    environment: Mapping[str, str],
    installed: Registration,
    result: RestartResult,
    *,
    update: bool,
) -> None:
    """Save the update and replacement outcomes separately for this installation."""
    target = _result_path(environment, installed)
    try:
        no_links(target)
        target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        write_json(
            target,
            {
                "generation": str(installed.generation),
                "registration_revision": result.registration_revision,
                "build_fingerprint": result.status.build_fingerprint
                if result.status
                else None,
                "instance_id": result.status.instance_id if result.status else None,
                "update_exit": result.update_exit if update else None,
                "update_error": redact_runtime_token(result.update_error, environment)
                if result.update_error
                else None,
                "runtime_error": redact_runtime_token(result.start_error, environment)
                if result.start_error
                else None,
            },
        )
    except (OSError, SetupError) as error:
        raise RuntimeClientError(
            "Could not save the last LTCook restart result."
        ) from error


def last_restart_result(
    environment: Mapping[str, str], installed: Registration
) -> dict[str, str | int | None] | None:
    """Read the last completed restart for the current installation generation."""
    target = _result_path(environment, installed)
    try:
        no_links(target)
        if not target.exists():
            return None
        if not target.is_file():
            raise ValueError("The restart result is not a regular file.")
        result = json.loads(target.read_text(encoding="utf-8"))
        if not isinstance(result, dict):
            raise ValueError("The restart result is invalid.")
        if result.get("generation") != str(installed.generation):
            return None
        fields = (
            "registration_revision",
            "build_fingerprint",
            "instance_id",
            "update_error",
            "runtime_error",
        )
        recorded: dict[str, str | int | None] = {}
        for field in fields:
            value = result[field]
            if value is not None and not isinstance(value, str):
                raise ValueError("The restart result is invalid.")
            recorded[field] = value
        exit_code = result["update_exit"]
        if exit_code is not None and type(exit_code) is not int:
            raise ValueError("The restart result exit code is invalid.")
        recorded["update_exit"] = exit_code
        return recorded
    except (KeyError, OSError, ValueError, SetupError) as error:
        raise RuntimeClientError(
            "Could not read the last LTCook restart result."
        ) from error


def registration(
    shell: Mapping[str, str], launcher: Path | None = None, *, recovery: bool = False
) -> Registration:
    """Read the active launcher authority, including a usable recovery record."""
    inspection = APP_RC.installation(environment=shell).inspect()
    record = inspection.require_usable()
    if (
        record is None
        or inspection.revision is None
        or record.placement.appdata_dir is None
        or (inspection.status != "ready" and not recovery)
        or (
            launcher is not None
            and (
                launcher.name != record.command_name
                or not launcher.is_file()
                or not any(
                    item.kind == "command" and Path(item.path) == launcher
                    for item in record.owned_outputs
                )
            )
        )
    ):
        raise RuntimeClientError("Restart requires the registered LTCook command.")
    active = record.active_runtime
    if isinstance(active, RuntimeSlot):
        prefix = inspection.directory / "runtimes" / str(active.slot_id) / ".venv"
    elif isinstance(active, EditableCheckout):
        prefix = active.environment
    else:
        raise RuntimeClientError(
            "The registered LTCook Python environment is unavailable."
        )
    return Registration(
        directory=inspection.directory,
        generation=record.generation_id,
        revision=inspection.revision,
        deployment=record.placement.appdata_dir / "deployment",
        prefix=prefix,
        ready=inspection.status == "ready",
    )


def inspect_installed_build(
    shell: Mapping[str, str], expected_revision: str
) -> InstalledBuild:
    """Attest the running Python bundle and the deployed assets for this revision."""
    current = registration(shell, recovery=True)
    environment = resolve_launch(None, original_environment=shell).environment
    if (
        current.revision != expected_revision
        or not current.prefix.samefile(sys.prefix)
        or not current.prefix.samefile(Path(environment["LTCOOK_PYTHON"]).parent.parent)
        or Path(environment["LTCOOK_DEPLOYMENT_DIR"]).resolve() != current.deployment
        or Path(environment["LTCOOK_JS_ROOT"]).resolve() != current.deployment / "app"
    ):
        raise RuntimeClientError(
            "The launcher did not select the expected LTCook installation."
        )
    try:
        record = installed_runtime_record(current.deployment, packaged_build())
    except (OSError, SetupError) as error:
        raise RuntimeClientError(
            "The installed Python and runtime build could not be verified."
        ) from error
    if not record or (
        environment["LTCOOK_NODE_EXECUTABLE"] != record["node"]
        or registration(shell, recovery=True) != current
    ):
        raise RuntimeClientError("The installed Python and runtime build do not match.")
    attempt = record.get("update_attempt")
    return InstalledBuild(
        record["fingerprint"], attempt if isinstance(attempt, str) else None
    )


def read_registered_build(
    launcher: Path, shell: Mapping[str, str], installed: Registration
) -> InstalledBuild:
    """Ask the public launcher to select and attest its registered Python build."""
    try:
        result = subprocess.run(
            [str(launcher), "launch", "_installed-build", installed.revision],
            env=dict(shell),
            stdin=subprocess.DEVNULL,
            capture_output=True,
            timeout=_START_SECONDS,
            check=False,
        )
        if result.returncode == 0:
            response = json.loads(result.stdout)
            if (
                isinstance(response, dict)
                and isinstance(fingerprint := response.get("fingerprint"), str)
                and re.fullmatch(r"[a-f0-9]{64}", fingerprint)
                and (
                    (attempt := response.get("update_attempt")) is None
                    or (
                        isinstance(attempt, str)
                        and re.fullmatch(r"[a-f0-9]{32}", attempt)
                    )
                )
                and registration(shell, launcher, recovery=True) == installed
            ):
                return InstalledBuild(fingerprint, attempt)
    except (OSError, ValueError, subprocess.TimeoutExpired) as error:
        raise RuntimeClientError(
            "The registered LTCook runtime build could not be verified."
        ) from error
    raise RuntimeClientError(
        "The registered LTCook runtime build could not be verified."
    )


def _start_registered(
    launcher: Path,
    environment: Mapping[str, str],
    shell: Mapping[str, str],
    previous_instance_id: str | None,
    installed: Registration,
    expected_build: InstalledBuild,
    *,
    detached: bool,
) -> RuntimeStatus:
    if probe_runtime(environment) is not None:
        raise RuntimeClientError(
            "Another runtime appeared after stop. Restart was halted."
        )
    if registration(shell, launcher, recovery=True) != installed:
        raise RuntimeClientError("The registered installation changed before startup.")
    # > The idle worker keeps this foreground launch in its transient systemd scope.
    # > The immediate path leaves a detached runtime available even if the update failed.
    creationflags = 0
    if detached and os.name == "nt":
        creationflags = (
            subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP
        )
    process = subprocess.Popen(
        [str(launcher), "launch", "runtime"],
        env=dict(shell),
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        start_new_session=detached and os.name == "posix",
        creationflags=creationflags,
    )
    deadline = time.monotonic() + _START_SECONDS
    while time.monotonic() < deadline:
        status = probe_runtime(environment)
        if isinstance(status, RuntimeStatus):
            if status.instance_id == previous_instance_id:
                raise RuntimeClientError("The previous runtime is still responding.")
            if status.build_fingerprint != expected_build.fingerprint:
                raise RuntimeClientError(
                    "The replacement runtime reported a different build."
                )
            if registration(shell, launcher, recovery=True) != installed:
                raise RuntimeClientError(
                    "The registered installation changed during startup."
                )
            return status
        if (code := process.poll()) is not None:
            raise RuntimeClientError(
                f"The registered runtime launch exited before readiness (exit {code}). "
                "Inspect LTCook's runtime logs or run ltcook serve."
            )
        time.sleep(0.2)
    raise RuntimeClientError(
        "Timed out waiting for the replacement runtime. Inspect LTCook's runtime logs."
    )


def restart_stopped_runtime(
    launcher: Path,
    environment: Mapping[str, str],
    shell: Mapping[str, str],
    previous_instance_id: str | None,
    previous_registration: Registration,
    previous_build: InstalledBuild | None,
    *,
    update: bool,
    assume_yes: bool,
    detached: bool,
    starting: Callable[[str | None], None] | None = None,
) -> RestartResult:
    """Update only the stopped registration and independently verify its replacement."""
    if probe_runtime(environment) is not None:
        raise RuntimeClientError(
            "Another runtime appeared after stop. Restart was halted."
        )
    if registration(shell, launcher) != previous_registration:
        raise RuntimeClientError("The registered installation changed during shutdown.")

    update_error = None
    update_exit = 0
    attempt = uuid4().hex
    if update:
        command = [launcher, "app", "update", *(["--yes"] if assume_yes else [])]
        output = None if detached else subprocess.DEVNULL
        try:
            update_exit = subprocess.run(
                command,
                env={**shell, UPDATE_ATTEMPT_ENV: attempt},
                stdin=output,
                stdout=output,
                stderr=output,
                check=False,
            ).returncode
            if update_exit:
                update_error = (
                    f"The registered AppRC update failed (exit {update_exit})."
                )
        except OSError:
            update_exit = 1
            update_error = "The registered AppRC update could not be started."

    try:
        installed = registration(shell, launcher, recovery=update_error is not None)
        if installed.generation != previous_registration.generation or (
            installed.directory != previous_registration.directory
            or installed.deployment != previous_registration.deployment
        ):
            raise RuntimeClientError("The registered installation changed identity.")
        build = read_registered_build(launcher, shell, installed)
        if (
            update
            and update_error is None
            and build.update_attempt != attempt
            and (installed != previous_registration or build != previous_build)
        ):
            update_exit = 1
            update_error = (
                "The installed build could not be attributed to this AppRC update."
            )
            return RestartResult(None, update_exit, update_error, "Restart was halted.")
        if not update and (
            installed != previous_registration or build != previous_build
        ):
            raise RuntimeClientError("The installed build changed during restart.")
        if (
            update_error is not None
            and build.update_attempt != attempt
            and (
                installed.prefix != previous_registration.prefix
                or (
                    previous_build is not None
                    and build.fingerprint != previous_build.fingerprint
                )
            )
        ):
            raise RuntimeClientError(
                "The registered build changed independently of the failed update."
            )
        environment = resolve_launch(None, original_environment=shell).environment
        if starting is not None:
            starting(update_error)
        status = _start_registered(
            launcher,
            environment,
            shell,
            previous_instance_id,
            installed,
            build,
            detached=detached,
        )
    except (OSError, ValueError) as error:
        detail = (
            str(error)
            if isinstance(error, RuntimeClientError)
            else "Could not verify or start the registered LTCook runtime."
        )
        return RestartResult(None, update_exit, update_error, detail)
    return RestartResult(
        status, update_exit, update_error, registration_revision=installed.revision
    )
