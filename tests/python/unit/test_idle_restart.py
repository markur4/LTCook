"""Traditional tests for the local idle restart worker and its receipt."""

from __future__ import annotations

import subprocess
import sys
from collections.abc import Mapping
from contextlib import ExitStack
from pathlib import Path
from types import SimpleNamespace
from typing import cast
from unittest.mock import Mock
from uuid import uuid4

import pytest

from ltcook import _app_update as lifecycle
from ltcook import _idle_restart as restart
from ltcook._runtime_client import RuntimeBusyError, RuntimeClientError, RuntimeStatus

pytestmark = pytest.mark.skipif(
    sys.platform != "linux", reason="user systemd is Linux-only"
)


@pytest.fixture
def installation(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> tuple[dict[str, str], restart._Store, Path]:
    deployment = tmp_path / "deployment"
    deployment.mkdir()
    environment = {
        "LTCOOK_RUNTIME_STATE_DIR": str(tmp_path / "state"),
        "LTCOOK_DEPLOYMENT_DIR": str(deployment),
        "LTCOOK_API_TOKEN": "runtime-secret",
    }
    store = restart._store(environment, restart._shell_environment(restart.os.environ))
    launcher = tmp_path / "bin" / "ltcook"
    registered = lifecycle.Registration(
        tmp_path / "installation", uuid4(), "registered", deployment, tmp_path, True
    )
    monkeypatch.setattr(restart, "registration", Mock(return_value=registered))
    monkeypatch.setattr(
        restart,
        "read_registered_build",
        Mock(return_value=lifecycle.InstalledBuild("installed", None)),
    )
    monkeypatch.setattr(
        lifecycle,
        "registration",
        lambda *args, **kwargs: restart.registration(*args, **kwargs),
    )
    monkeypatch.setattr(
        lifecycle,
        "read_registered_build",
        lambda *args, **kwargs: restart.read_registered_build(*args, **kwargs),
    )
    monkeypatch.setattr(
        lifecycle, "probe_runtime", lambda env: restart.probe_runtime(env)
    )
    monkeypatch.setattr(
        lifecycle,
        "resolve_launch",
        lambda *args, **kwargs: restart.resolve_launch(*args, **kwargs),
    )
    monkeypatch.setattr(
        restart,
        "resolve_launch",
        lambda *args, **kwargs: SimpleNamespace(environment=environment),
    )
    return environment, store, launcher


def _owner(
    environment: Mapping[str, str],
    instance_id: str = "previous",
    *,
    build: str = "installed",
    idle_restart: bool = True,
) -> RuntimeStatus:
    deployment = environment["LTCOOK_DEPLOYMENT_DIR"]
    return RuntimeStatus(
        instance_id=instance_id,
        deployment_root=deployment,
        database_path=f"{deployment}/coordination.sqlite",
        paseo_listen="127.0.0.1:6767",
        backend_log_path=None,
        paseo_log_path=f"{deployment}/paseo.log",
        telemetry_log_path=f"{deployment}/telemetry.log",
        idle_restart=idle_restart,
        build_fingerprint=build,
    )


def _seed(store: restart._Store, *, update: bool = False) -> None:
    store.prepare()
    store.write(
        {
            "status": {
                "state": "queued",
                "message": "Idle restart queued.",
                "job_id": "job",
                "previous_instance_id": "previous",
                "update": update,
            },
            "revision": "registered",
            "queued_at": restart.time.time(),
        }
    )


def test_queue_coalesces_requests_with_the_same_update_choice(
    installation: tuple[dict[str, str], restart._Store, Path],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    environment, store, launcher = installation
    probe = Mock(return_value=_owner(environment))
    monkeypatch.setattr(restart, "probe_runtime", probe)

    with ExitStack() as running_worker:

        def launch_worker(
            store: restart._Store,
            job_id: str,
            launcher: Path,
            shell: Mapping[str, str],
        ) -> SimpleNamespace:
            running_worker.enter_context(store.lock(worker=True))
            return SimpleNamespace(poll=lambda: None)

        def acknowledge(seconds: float) -> None:
            with store.lock():
                receipt = store.read()
                assert receipt is not None
                store.transition(receipt, "waiting", "Waiting for the runtime.")

        monkeypatch.setattr(restart, "_launch_worker", launch_worker)
        monkeypatch.setattr(restart.time, "sleep", acknowledge)
        first = restart.queue_restart(environment, launcher, update=False)
        assert first["state"] == "waiting"
        assert restart.queue_restart(environment, launcher, update=False) == first
        with pytest.raises(RuntimeClientError, match="different update choice"):
            restart.queue_restart(environment, launcher, update=True)
        assert restart.restart_status(environment) == first
    probe.assert_called_once_with(environment)


def test_queue_rejects_owners_without_the_idle_stop_contract(
    installation: tuple[dict[str, str], restart._Store, Path],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    environment, _, launcher = installation
    monkeypatch.setattr(
        restart,
        "probe_runtime",
        Mock(return_value=_owner(environment, idle_restart=False)),
    )
    launch = Mock()
    monkeypatch.setattr(restart, "_launch_worker", launch)

    with pytest.raises(RuntimeClientError, match="does not support idle restart"):
        restart.queue_restart(environment, launcher, update=False)
    assert restart.restart_status(environment)["state"] == "idle"
    launch.assert_not_called()


def test_queue_rejects_owner_from_a_different_build(
    installation: tuple[dict[str, str], restart._Store, Path],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    environment, _, launcher = installation
    monkeypatch.setattr(
        restart, "probe_runtime", Mock(return_value=_owner(environment, build="other"))
    )
    launch = Mock()
    monkeypatch.setattr(restart, "_launch_worker", launch)

    with pytest.raises(RuntimeClientError, match="differs from the installed build"):
        restart.queue_restart(environment, launcher, update=False)
    assert restart.restart_status(environment)["state"] == "idle"
    launch.assert_not_called()


def test_worker_reports_busy_owner_and_cancellation_prevents_stop(
    installation: tuple[dict[str, str], restart._Store, Path],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    environment, store, launcher = installation
    _seed(store, update=True)
    stop = Mock(side_effect=RuntimeBusyError(2))
    replace = Mock()
    monkeypatch.setattr(restart, "stop_runtime", stop)
    monkeypatch.setattr(restart, "restart_stopped_runtime", replace)
    observed: list[restart.RestartStatus] = []

    def cancel_while_waiting(seconds: float) -> None:
        observed.append(restart.restart_status(environment))
        assert restart.cancel_restart(environment)["state"] == "canceled"

    monkeypatch.setattr(restart.time, "sleep", cancel_while_waiting)
    restart._worker(store, "job", launcher)

    assert observed[0]["state"] == "waiting"
    assert observed[0]["active_turns"] == 2
    assert restart.restart_status(environment)["state"] == "canceled"
    stop.assert_called_once_with(
        environment,
        when_idle=True,
        expected_instance_id="previous",
        expected_build_fingerprint="installed",
    )
    replace.assert_not_called()


def test_worker_never_updates_after_its_authenticated_target_is_replaced(
    installation: tuple[dict[str, str], restart._Store, Path],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    environment, store, launcher = installation
    _seed(store, update=True)
    stop = Mock(side_effect=RuntimeClientError("The runtime instance changed."))
    replace = Mock()
    monkeypatch.setattr(restart, "stop_runtime", stop)
    monkeypatch.setattr(restart, "restart_stopped_runtime", replace)

    restart._worker(store, "job", launcher)

    status = restart.restart_status(environment)
    assert status["state"] == "failed"
    assert "instance changed" in status["message"]
    stop.assert_called_once_with(
        environment,
        when_idle=True,
        expected_instance_id="previous",
        expected_build_fingerprint="installed",
    )
    replace.assert_not_called()


def test_worker_never_updates_a_registration_replaced_during_shutdown(
    installation: tuple[dict[str, str], restart._Store, Path],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    environment, store, launcher = installation
    _seed(store, update=True)
    previous = restart.registration({}, launcher)
    registration = Mock(side_effect=[previous, previous, object()])
    stop = Mock(return_value=0)
    run = Mock()
    monkeypatch.setattr(lifecycle.subprocess, "run", run)
    monkeypatch.setattr(restart, "registration", registration)
    monkeypatch.setattr(restart, "stop_runtime", stop)
    monkeypatch.setattr(restart, "probe_runtime", Mock(return_value=None))

    restart._worker(store, "job", launcher)

    status = restart.restart_status(environment)
    assert status["state"] == "failed"
    assert "installation changed during shutdown" in status["message"]
    assert registration.call_count == 3
    stop.assert_called_once_with(
        environment,
        when_idle=True,
        expected_instance_id="previous",
        expected_build_fingerprint="installed",
    )
    run.assert_not_called()


@pytest.mark.parametrize(
    ("update_exit", "published", "coherent", "expected_state"),
    [
        (0, True, True, "done"),
        (0, False, True, "done"),
        (9, False, True, "failed"),
        (9, True, False, "failed"),
    ],
    ids=["new-build", "already-current", "recovered", "partial-update"],
)
def test_worker_verifies_the_registered_runtime_after_an_update(
    installation: tuple[dict[str, str], restart._Store, Path],
    monkeypatch: pytest.MonkeyPatch,
    update_exit: int,
    published: bool,
    coherent: bool,
    expected_state: str,
) -> None:
    environment, store, launcher = installation
    _seed(store, update=True)
    build = "refreshed" if published else "installed"
    replacement = uuid4()
    runtime = _owner(environment, str(replacement), build=build)
    monkeypatch.setattr(lifecycle, "uuid4", Mock(side_effect=[uuid4(), replacement]))
    stop = Mock(side_effect=[RuntimeBusyError(1), 0])
    monkeypatch.setattr(restart, "stop_runtime", stop)
    monkeypatch.setattr(
        restart, "probe_runtime", Mock(side_effect=[None, None, runtime])
    )
    monkeypatch.setenv("PROVIDER_TOKEN", "provider-secret")

    def observe_wait(seconds: float) -> None:
        status = restart.restart_status(environment)
        assert status["state"] == "waiting"
        assert status["active_turns"] == 1

    monkeypatch.setattr(restart.time, "sleep", observe_wait)

    def update(
        arguments: list[str | Path], **kwargs: object
    ) -> subprocess.CompletedProcess[str]:
        assert arguments == [launcher, "app", "update", "--yes"]
        assert kwargs["stdin"] == subprocess.DEVNULL
        assert restart.restart_status(environment)["state"] == "updating"
        assert restart.cancel_restart(environment)["state"] == "updating"
        if coherent and published:
            attempt = cast(dict[str, str], kwargs["env"])[lifecycle.UPDATE_ATTEMPT_ENV]
            monkeypatch.setattr(
                restart,
                "read_registered_build",
                Mock(return_value=lifecycle.InstalledBuild(build, attempt)),
            )
        if not coherent:
            monkeypatch.setattr(
                restart,
                "read_registered_build",
                Mock(side_effect=RuntimeClientError("Build mismatch.")),
            )
        return subprocess.CompletedProcess(arguments, update_exit)

    monkeypatch.setattr(lifecycle.subprocess, "run", update)
    start = Mock(return_value=SimpleNamespace(poll=lambda: None))
    monkeypatch.setattr(lifecycle.subprocess, "Popen", start)

    restart._worker(store, "job", launcher)

    status = restart.restart_status(environment)
    assert status["state"] == expected_state
    if update_exit:
        assert "exit 9" in status["message"]
    if coherent:
        assert status["instance_id"] == str(replacement)
        assert start.call_args.args == (
            [
                str(launcher),
                "launch",
                "runtime",
                "--restart-instance-id",
                str(replacement),
            ],
        )
        assert ("running again" in status["message"]) == bool(update_exit)
    else:
        assert "Build mismatch" in status["message"]
        assert "instance_id" not in status
        start.assert_not_called()
    assert stop.call_count == 2
    payload = (store.directory / "receipt.json").read_text(encoding="utf-8")
    assert "runtime-secret" not in payload
    assert "provider-secret" not in payload


def test_worker_rejects_a_build_from_a_different_update(
    installation: tuple[dict[str, str], restart._Store, Path],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    environment, store, launcher = installation
    _seed(store, update=True)
    initial = lifecycle.InstalledBuild("installed", None)
    unrelated = lifecycle.InstalledBuild("new", "1" * 32)
    monkeypatch.setattr(
        restart, "read_registered_build", Mock(side_effect=[initial, unrelated])
    )
    monkeypatch.setattr(restart, "stop_runtime", Mock(return_value=0))
    monkeypatch.setattr(restart, "probe_runtime", Mock(return_value=None))
    monkeypatch.setattr(
        lifecycle.subprocess, "run", Mock(return_value=SimpleNamespace(returncode=0))
    )
    start = Mock()
    monkeypatch.setattr(lifecycle.subprocess, "Popen", start)

    restart._worker(store, "job", launcher)

    status = restart.restart_status(environment)
    assert status["state"] == "failed"
    assert "could not be attributed to this AppRC update" in status["message"]
    start.assert_not_called()


@pytest.mark.parametrize(
    ("wrong_owner", "wrong_build", "error"),
    [
        (True, False, "Another runtime won the restart launch race"),
        (False, True, "different build"),
    ],
)
def test_worker_only_accepts_its_own_launch_on_the_expected_build(
    installation: tuple[dict[str, str], restart._Store, Path],
    monkeypatch: pytest.MonkeyPatch,
    wrong_owner: bool,
    wrong_build: bool,
    error: str,
) -> None:
    environment, store, launcher = installation
    _seed(store)
    monkeypatch.setattr(restart, "stop_runtime", Mock(return_value=0))
    replacement = uuid4()
    monkeypatch.setattr(lifecycle, "uuid4", Mock(return_value=replacement))
    monkeypatch.setattr(
        restart,
        "probe_runtime",
        Mock(
            side_effect=[
                None,
                None,
                _owner(
                    environment,
                    str(uuid4() if wrong_owner else replacement),
                    build="unrelated" if wrong_build else "installed",
                ),
            ]
        ),
    )
    monkeypatch.setattr(
        restart.subprocess,
        "Popen",
        Mock(return_value=SimpleNamespace(poll=lambda: None)),
    )

    restart._worker(store, "job", launcher)

    status = restart.restart_status(environment)
    assert status["state"] == "failed"
    assert error in status["message"]
    assert "instance_id" not in status


def test_status_reconciles_a_receipt_left_by_an_exited_worker(
    installation: tuple[dict[str, str], restart._Store, Path],
) -> None:
    environment, store, _ = installation
    _seed(store)
    receipt = store.read()
    assert receipt is not None
    store.transition(receipt, "waiting", "Waiting for the runtime.")

    assert restart.restart_status(environment)["state"] == "failed"
    persisted = store.read()
    assert persisted is not None
    assert persisted["status"] == restart.restart_status(environment)
