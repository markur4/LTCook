"""Durable, cancelable idle restarts for a registered local installation."""

from __future__ import annotations

import hashlib
import json
import os
import stat
import subprocess
import sys
import time
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Literal, NotRequired, TypedDict, cast
from uuid import uuid4

from filelock import FileLock
from filelock import Timeout as LockTimeout

from ltcook._app_update import (
    InstalledBuild,
    Registration,
    read_registered_build,
    registration,
    restart_stopped_runtime,
    save_restart_result,
)
from ltcook._runtime_client import (
    RuntimeBusyError,
    RuntimeClientError,
    RuntimeStatus,
    probe_runtime,
    redact_runtime_token,
    stop_runtime,
)
from ltcook.config.app import APP_RC
from ltcook.launch import _shell_environment, resolve_launch
from ltcook_distr.payload.app_lifecycle._common import SetupError, no_links, write_json

_JobState = Literal[
    "queued",
    "waiting",
    "stopping",
    "updating",
    "starting",
    "done",
    "failed",
    "canceled",
]


class _IdleStatus(TypedDict):
    state: Literal["idle"]
    message: str


class _JobStatus(TypedDict):
    state: _JobState
    message: str
    job_id: str
    update: bool
    previous_instance_id: str
    instance_id: NotRequired[str]
    active_turns: NotRequired[int]


RestartStatus = _IdleStatus | _JobStatus


class _Receipt(TypedDict):
    status: _JobStatus
    revision: str
    queued_at: float


_CANCELABLE = {"queued", "waiting"}
_ACTIVE = _CANCELABLE | {"stopping", "updating", "starting"}
_STATES = _ACTIVE | {"done", "failed", "canceled"}
_ACK_SECONDS = 5
_IDLE_SECONDS = 24 * 60 * 60
_RETRY_SECONDS = 2
_EMPTY: _IdleStatus = {
    "state": "idle",
    "message": "No idle restart has been queued for this installation.",
}


def _safe_file(path: Path) -> None:
    try:
        no_links(path)
    except SetupError as error:
        raise RuntimeClientError(str(error)) from error
    try:
        mode = path.lstat().st_mode
    except FileNotFoundError:
        return
    if not stat.S_ISREG(mode):
        raise RuntimeClientError(f"Refusing nonregular idle restart file: {path}")


@dataclass(frozen=True)
class _Store:
    directory: Path

    def prepare(self) -> None:
        # > The resolved path can be customized, so check it before creating files.
        try:
            no_links(self.directory)
        except SetupError as error:
            raise RuntimeClientError(str(error)) from error
        self.directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        info = self.directory.lstat()
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid():
            raise RuntimeClientError(
                "Idle restart state must belong to the current user."
            )
        self.directory.chmod(0o700)

    def lock(self, *, worker: bool = False, timeout: float = 45) -> FileLock:
        path = self.directory / ("worker.lock" if worker else "receipt.lock")
        _safe_file(path)
        return FileLock(path, timeout=timeout)

    def read(self) -> _Receipt | None:
        path = self.directory / "receipt.json"
        _safe_file(path)
        try:
            value = json.loads(path.read_text(encoding="utf-8"))
        except FileNotFoundError:
            return None
        except ValueError as error:
            raise RuntimeClientError("The idle restart receipt is invalid.") from error
        if (
            not isinstance(value, dict)
            or not isinstance(status := value.get("status"), dict)
            or not isinstance(state := status.get("state"), str)
            or state not in _STATES
            or not isinstance(status.get("job_id"), str)
            or not isinstance(status.get("previous_instance_id"), str)
            or type(status.get("update")) is not bool
            or not isinstance(status.get("message"), str)
            or not isinstance(value.get("revision"), str)
            or not isinstance(value.get("queued_at"), (int, float))
        ):
            raise RuntimeClientError("The idle restart receipt is invalid.")
        return cast(_Receipt, value)

    def write(self, receipt: _Receipt) -> None:
        try:
            write_json(self.directory / "receipt.json", receipt)
        except SetupError as error:
            raise RuntimeClientError(str(error)) from error

    def transition(
        self,
        receipt: _Receipt,
        state: _JobState,
        message: str,
        *,
        active_turns: int | None = None,
        instance_id: str | None = None,
    ) -> _JobStatus:
        status = receipt["status"]
        status["state"] = state
        status["message"] = message
        status.pop("active_turns", None)
        if active_turns is not None:
            status["active_turns"] = active_turns
        if instance_id is not None:
            status["instance_id"] = instance_id
        self.write(receipt)
        return status

    def abandoned(self, receipt: _Receipt) -> bool:
        state = receipt["status"]["state"]
        if state not in _ACTIVE or (
            state == "queued" and time.time() < receipt["queued_at"] + _ACK_SECONDS
        ):
            return False
        try:
            with self.lock(worker=True, timeout=0):
                return True
        except LockTimeout:
            return False

    def current(self) -> _Receipt | None:
        # > The caller holds the receipt lock while reconciling a lost worker.
        receipt = self.read()
        if receipt is not None and self.abandoned(receipt):
            self.transition(
                receipt,
                "failed",
                "The idle restart worker exited before confirming completion. "
                "Check the runtime before queuing again.",
            )
        return receipt


def _store(environment: Mapping[str, str], shell: Mapping[str, str]) -> _Store:
    if sys.platform != "linux":
        raise RuntimeClientError(
            "Idle restart requires Linux or WSL with user systemd."
        )
    state = Path(environment["LTCOOK_RUNTIME_STATE_DIR"])
    if not state.is_absolute() or state == Path(state.anchor):
        raise RuntimeClientError(
            "Idle restart requires an absolute runtime state directory."
        )
    installation = APP_RC.installation(environment=shell).directory
    scope = hashlib.sha256(os.fsencode(installation)).hexdigest()[:16]
    return _Store(state / f"idle-restart-{scope}")


def _launch_worker(
    store: _Store, job_id: str, launcher: Path, shell: Mapping[str, str]
) -> subprocess.Popen[bytes]:
    return subprocess.Popen(
        [
            "systemd-run",
            "--user",
            "--scope",
            "--collect",
            "--quiet",
            "--expand-environment=no",
            f"--unit=ltcook-{store.directory.name}-{job_id}.scope",
            "--",
            sys.executable,
            "-I",
            "-m",
            "ltcook._idle_restart",
            str(store.directory),
            job_id,
            str(launcher),
        ],
        env=dict(shell),
        cwd=Path(shell.get("HOME") or str(Path.home())),
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        start_new_session=True,
    )


def _coalesce(status: _JobStatus, update: bool) -> _JobStatus:
    if status["update"] != update:
        raise RuntimeClientError(
            "An idle restart with a different update choice is pending. "
            "Cancel the pending job before changing that choice."
        )
    return status


def _current_status(store: _Store) -> RestartStatus:
    receipt = store.read()
    if receipt is None:
        return _EMPTY.copy()
    if store.abandoned(receipt):
        with store.lock():
            receipt = store.current()
    return receipt["status"] if receipt is not None else _EMPTY.copy()


def queue_restart(
    environment: Mapping[str, str], launcher: Path, *, update: bool
) -> RestartStatus:
    """Queue one detached restart for this installation's authenticated owner.

    :param environment: Globally resolved AppRC launch environment.
    :param launcher: Recorded public AppRC command path, including any command link.
    :param update: Whether the caller already approved the AppRC update.
    :return: The current job status once the worker acknowledges it.
    """
    shell = _shell_environment(os.environ)
    store = _store(environment, shell)
    observed = _current_status(store)
    if observed["state"] != "idle" and observed["state"] in _ACTIVE:
        return _coalesce(observed, update)
    store.prepare()
    with store.lock():
        current = store.current()
        if current is not None and current["status"]["state"] in _ACTIVE:
            return _coalesce(current["status"], update)
        installed = registration(shell, launcher)
        owner = probe_runtime(environment)
        if not isinstance(owner, RuntimeStatus):
            raise RuntimeClientError("Idle restart requires a ready local runtime.")
        if not owner.idle_restart:
            raise RuntimeClientError(
                "The running LTCook version does not support idle restart. "
                "Restart it from a terminal after its work finishes."
            )
        build = read_registered_build(launcher, shell, installed)
        if owner.build_fingerprint != build.fingerprint:
            raise RuntimeClientError(
                "The running LTCook runtime differs from the installed build."
            )
        job_id = uuid4().hex
        receipt: _Receipt = {
            "status": {
                "job_id": job_id,
                "state": "queued",
                "update": update,
                "previous_instance_id": owner.instance_id,
                "message": "Idle restart queued.",
            },
            "revision": installed.revision,
            "queued_at": time.time(),
        }
        store.write(receipt)
        try:
            process = _launch_worker(store, job_id, launcher, shell)
        except OSError:
            return store.transition(
                receipt,
                "failed",
                "Could not launch the user systemd idle restart worker.",
            )

    # > Acknowledge only after the Python worker enters its separate systemd scope.
    deadline = time.monotonic() + _ACK_SECONDS
    while True:
        observed = store.read()
        if observed is None or observed["status"]["job_id"] != job_id:
            break
        if observed["status"]["state"] != "queued":
            return observed["status"]
        if time.monotonic() >= deadline or process.poll() is not None:
            break
        time.sleep(0.05)
    with store.lock():
        observed = store.read()
        if observed is not None and observed["status"]["job_id"] == job_id:
            if observed["status"]["state"] == "queued":
                return store.transition(
                    observed,
                    "failed",
                    "The idle restart worker did not start. "
                    "Check that your user systemd manager is running.",
                )
            return observed["status"]
    return {
        **receipt["status"],
        "state": "canceled",
        "message": "Idle restart was superseded.",
    }


def restart_status(environment: Mapping[str, str]) -> RestartStatus:
    """Read the latest idle restart status for the configured installation.

    :param environment: Globally resolved AppRC launch environment.
    :return: The latest job status, or idle if no job has been recorded.
    """
    return _current_status(_store(environment, _shell_environment(os.environ)))


def cancel_restart(environment: Mapping[str, str]) -> RestartStatus:
    """Cancel a queued restart before it can stop the authenticated owner.

    :param environment: Globally resolved AppRC launch environment.
    :return: The canceled receipt, or the status if there is no cancelable job.
    """
    store = _store(environment, _shell_environment(os.environ))
    observed = store.read()
    if observed is None:
        return _EMPTY.copy()
    with store.lock():
        receipt = store.current()
        if receipt is None:
            return _EMPTY.copy()
        status = receipt["status"]
        if (
            status["job_id"] == observed["status"]["job_id"]
            and status["state"] in _CANCELABLE
        ):
            return store.transition(receipt, "canceled", "Idle restart canceled.")
        return status


def _stop_when_idle(
    store: _Store,
    job_id: str,
    launcher: Path,
    environment: Mapping[str, str],
    shell: Mapping[str, str],
    installed: Registration,
    build: InstalledBuild,
) -> _Receipt | None:
    deadline = time.monotonic() + _IDLE_SECONDS
    while time.monotonic() < deadline:
        with store.lock():
            receipt = store.read()
            if (
                receipt is None
                or receipt["status"]["job_id"] != job_id
                or receipt["status"]["state"] not in _CANCELABLE
            ):
                return None
            if (
                installed.revision != receipt["revision"]
                or registration(shell, launcher) != installed
            ):
                raise RuntimeClientError(
                    "The registered installation changed while waiting."
                )
            store.transition(
                receipt, "stopping", "Checking whether the runtime can stop safely."
            )
            try:
                result = stop_runtime(
                    environment,
                    when_idle=True,
                    expected_instance_id=receipt["status"]["previous_instance_id"],
                    expected_build_fingerprint=build.fingerprint,
                )
            except RuntimeBusyError as error:
                store.transition(
                    receipt,
                    "waiting",
                    "Waiting for active work to finish.",
                    active_turns=error.active_turns,
                )
            else:
                if result != 0:
                    raise RuntimeClientError(
                        "The targeted runtime could not be stopped."
                    )
                return receipt
        time.sleep(_RETRY_SECONDS)
    raise RuntimeClientError("Timed out waiting for the runtime to become idle.")


def _restart(store: _Store, job_id: str, launcher: Path) -> None:
    shell = _shell_environment(os.environ)
    environment = resolve_launch(None, original_environment=shell).environment
    if _store(environment, shell) != store:
        raise RuntimeClientError("The configured runtime state directory changed.")
    installed = registration(shell, launcher)
    build = read_registered_build(launcher, shell, installed)
    receipt = _stop_when_idle(
        store, job_id, launcher, environment, shell, installed, build
    )
    if receipt is None:
        return

    update = receipt["status"]["update"]
    if update:
        with store.lock():
            store.transition(
                receipt, "updating", "Updating the registered installation."
            )

    def starting(update_error: str | None) -> None:
        with store.lock():
            message = "Starting the registered runtime."
            if update_error is not None:
                message = f"{update_error} Attempting to bring the runtime back."
            store.transition(receipt, "starting", message)

    result = restart_stopped_runtime(
        launcher,
        environment,
        shell,
        receipt["status"]["previous_instance_id"],
        installed,
        build,
        update=update,
        assume_yes=True,
        detached=False,
        starting=starting,
    )
    try:
        save_restart_result(environment, installed, result, update=update)
    except RuntimeClientError as error:
        # > The idle job's own receipt still carries the verified outcomes.
        print(str(error), file=sys.stderr)
    with store.lock():
        if result.status is None:
            message = " ".join(filter(None, (result.update_error, result.start_error)))
            store.transition(
                receipt, "failed", redact_runtime_token(message, environment)
            )
        elif result.update_error is not None:
            store.transition(
                receipt,
                "failed",
                f"{result.update_error} LTCook is running again.",
                instance_id=result.status.instance_id,
            )
        else:
            store.transition(
                receipt,
                "done",
                "Idle restart complete.",
                instance_id=result.status.instance_id,
            )


def _worker(store: _Store, job_id: str, launcher: Path) -> None:
    with store.lock(worker=True):
        with store.lock():
            receipt = store.read()
            if (
                receipt is None
                or receipt["status"]["job_id"] != job_id
                or receipt["status"]["state"] != "queued"
            ):
                return
            store.transition(
                receipt, "waiting", "Waiting for the runtime to become idle."
            )
        try:
            _restart(store, job_id, launcher)
        except (OSError, ValueError) as error:
            with store.lock():
                current = store.read()
                if (
                    current is not None
                    and current["status"]["job_id"] == job_id
                    and current["status"]["state"] in _ACTIVE
                ):
                    message = (
                        redact_runtime_token(str(error), os.environ)
                        if isinstance(error, RuntimeClientError)
                        else "The idle restart worker could not complete the registered operation."
                    )
                    store.transition(current, "failed", message)


if __name__ == "__main__":
    directory, identifier, recorded_launcher = sys.argv[1:]
    _worker(_Store(Path(directory)), identifier, Path(recorded_launcher))
