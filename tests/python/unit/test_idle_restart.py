"""Traditional tests for the local idle restart worker and its receipt."""

from __future__ import annotations

import json
import subprocess
import sys
from collections.abc import Mapping
from contextlib import ExitStack
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock

import pytest

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
    (deployment / "runtime.json").write_text(
        json.dumps({"fingerprint": "installed"}), encoding="utf-8"
    )
    environment = {
        "LTCOOK_RUNTIME_STATE_DIR": str(tmp_path / "state"),
        "LTCOOK_DEPLOYMENT_DIR": str(deployment),
        "LTCOOK_API_TOKEN": "runtime-secret",
    }
    store = restart._store(environment, restart._shell_environment(restart.os.environ))
    launcher = tmp_path / "bin" / "ltcook"
    monkeypatch.setattr(restart, "_registration", lambda shell, launcher: "registered")
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


def test_worker_reports_busy_owner_and_cancellation_prevents_stop(
    installation: tuple[dict[str, str], restart._Store, Path],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    environment, store, launcher = installation
    _seed(store, update=True)
    stop = Mock(side_effect=RuntimeBusyError(2))
    update = Mock()
    start = Mock()
    monkeypatch.setattr(restart, "stop_runtime", stop)
    monkeypatch.setattr(restart, "_update", update)
    monkeypatch.setattr(restart, "_start", start)
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
        environment, when_idle=True, expected_instance_id="previous"
    )
    update.assert_not_called()
    start.assert_not_called()


def test_worker_never_updates_after_its_authenticated_target_is_replaced(
    installation: tuple[dict[str, str], restart._Store, Path],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    environment, store, launcher = installation
    _seed(store, update=True)
    stop = Mock(side_effect=RuntimeClientError("The runtime instance changed."))
    update = Mock()
    start = Mock()
    monkeypatch.setattr(restart, "stop_runtime", stop)
    monkeypatch.setattr(restart, "_update", update)
    monkeypatch.setattr(restart, "_start", start)

    restart._worker(store, "job", launcher)

    status = restart.restart_status(environment)
    assert status["state"] == "failed"
    assert "instance changed" in status["message"]
    stop.assert_called_once_with(
        environment, when_idle=True, expected_instance_id="previous"
    )
    update.assert_not_called()
    start.assert_not_called()


@pytest.mark.parametrize("update_exit", [0, 9])
def test_worker_starts_the_registered_runtime_after_an_approved_update_attempt(
    installation: tuple[dict[str, str], restart._Store, Path],
    monkeypatch: pytest.MonkeyPatch,
    update_exit: int,
) -> None:
    environment, store, launcher = installation
    _seed(store, update=True)
    build = "refreshed" if update_exit == 0 else "installed"
    runtime = _owner(environment, "replacement", build=build)
    receipt = Path(environment["LTCOOK_DEPLOYMENT_DIR"]) / "runtime.json"
    stop = Mock(side_effect=[RuntimeBusyError(1), 0])
    monkeypatch.setattr(restart, "stop_runtime", stop)
    monkeypatch.setattr(restart, "probe_runtime", Mock(side_effect=[None, runtime]))
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
        receipt.write_text(json.dumps({"fingerprint": build}), encoding="utf-8")
        return subprocess.CompletedProcess(arguments, update_exit)

    monkeypatch.setattr(restart.subprocess, "run", update)
    start = Mock(return_value=SimpleNamespace(poll=lambda: None))
    monkeypatch.setattr(restart.subprocess, "Popen", start)

    restart._worker(store, "job", launcher)

    status = restart.restart_status(environment)
    assert status["instance_id"] == "replacement"
    if update_exit == 0:
        assert status["state"] == "done"
    else:
        assert status["state"] == "failed"
        assert "exit 9" in status["message"]
        assert "running again" in status["message"]
    assert stop.call_count == 2
    assert start.call_args.args == ([str(launcher), "launch", "runtime"],)
    payload = (store.directory / "receipt.json").read_text(encoding="utf-8")
    assert "runtime-secret" not in payload
    assert "provider-secret" not in payload


def test_worker_rejects_a_replacement_with_the_wrong_build(
    installation: tuple[dict[str, str], restart._Store, Path],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    environment, store, launcher = installation
    _seed(store)
    monkeypatch.setattr(restart, "stop_runtime", Mock(return_value=0))
    monkeypatch.setattr(
        restart,
        "probe_runtime",
        Mock(side_effect=[None, _owner(environment, "replacement", build="unrelated")]),
    )
    monkeypatch.setattr(
        restart.subprocess,
        "Popen",
        Mock(return_value=SimpleNamespace(poll=lambda: None)),
    )

    restart._worker(store, "job", launcher)

    status = restart.restart_status(environment)
    assert status["state"] == "failed"
    assert "different build" in status["message"]
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
