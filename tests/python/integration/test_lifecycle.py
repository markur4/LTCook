"""Fast isolated tests for prerequisite planning and LTCook path ownership."""

from __future__ import annotations

import json
import os
import tarfile
from pathlib import Path

import pytest

from ltcook_distr.payload.app_lifecycle import prepare_runtime
from ltcook_distr.payload.app_lifecycle._common import (
    SetupError,
    extract_archive,
    owned_directory,
    safe_member,
)
from ltcook_distr.payload.app_lifecycle.prepare_runtime import _node_asset, _ready
from ltcook_distr.payload.app_lifecycle.prepare_services import (
    _provider,
    prepare_services,
)


def test_node_download_uses_selected_version_and_official_platform_name() -> None:
    version = (
        (Path(__file__).resolve().parents[3] / ".node-version")
        .read_text(encoding="utf-8")
        .strip()
    )
    url, archive, suffix = _node_asset(version, "Linux", "x86_64")
    expected_url = (
        f"https://nodejs.org/dist/v{version}/node-v{version}-linux-x64.tar.gz"
    )
    assert url == expected_url
    assert archive == f"node-v{version}-linux-x64"
    assert suffix == ".tar.gz"


def test_node_download_rejects_unsupported_platform() -> None:
    with pytest.raises(SetupError, match="No official Node"):
        version = (
            (Path(__file__).resolve().parents[3] / ".node-version")
            .read_text(encoding="utf-8")
            .strip()
        )
        _node_asset(version, "Plan9", "unknown")


def test_owned_deployment_refuses_nonempty_unmarked_directory(tmp_path: Path) -> None:
    deployment = tmp_path / "deployment"
    deployment.mkdir()
    (deployment / "unrelated").write_text("keep")
    with pytest.raises(SetupError, match="nonempty unowned"):
        owned_directory(deployment)
    assert (deployment / "unrelated").read_text() == "keep"


def test_owned_deployment_is_repeatable_only_with_ltcook_marker(tmp_path: Path) -> None:
    deployment = owned_directory(tmp_path / "deployment")
    assert owned_directory(deployment) == deployment
    assert (deployment / ".ltcook-owned").read_text() == "ltcook\n"


def test_archive_member_rejects_traversal_and_drive_paths() -> None:
    for name in ("../outside", "/absolute", "C:/outside", "team\\..\\outside"):
        with pytest.raises(SetupError):
            safe_member(name)


def test_tar_extraction_rejects_traversal_before_writing(tmp_path: Path) -> None:
    archive = tmp_path / "bad.tar"
    with tarfile.open(archive, "w") as output:
        member = tarfile.TarInfo("../outside")
        member.size = 1
        from io import BytesIO

        output.addfile(member, BytesIO(b"x"))
    destination = tmp_path / "extract"
    with pytest.raises(SetupError, match="Unsafe archive"):
        extract_archive(archive, destination)
    assert not (tmp_path / "outside").exists()


def test_remote_service_mode_does_not_install_or_select_local_podman(
    tmp_path: Path,
) -> None:
    receipt_path = prepare_services(
        tmp_path / "appdata", environment={"LTCOOK_SERVICE_CONNECTION": "direct"}
    )
    receipt = json.loads(receipt_path.read_text(encoding="utf-8"))
    assert receipt["connection"] == "direct"
    assert receipt["podman_executable"] == ""
    assert receipt["compose_provider"] == ""


def test_local_service_setup_checks_engine_and_selects_provider(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    podman = tmp_path / "podman"
    provider = tmp_path / "compose-provider"
    podman.write_text("podman")
    provider.write_text("provider")
    calls: list[list[str]] = []

    def fake_run(arguments, *, environment, cwd=None, required=True):
        calls.append(list(arguments))
        return type("Result", (), {"stdout": ""})()

    monkeypatch.setattr(
        "ltcook_distr.payload.app_lifecycle.prepare_services.platform.system",
        lambda: "Linux",
    )
    monkeypatch.setattr(
        "ltcook_distr.payload.app_lifecycle.prepare_services.run", fake_run
    )
    receipt_path = prepare_services(
        tmp_path / "appdata",
        environment={
            "LTCOOK_PODMAN_EXECUTABLE": str(podman),
            "PODMAN_COMPOSE_PROVIDER": str(provider),
            "PATH": "",
        },
    )
    assert calls == [
        [str(podman), "info", "--format", "json"],
        [str(provider), "--version"],
    ]
    receipt = json.loads(receipt_path.read_text(encoding="utf-8"))
    assert receipt["podman_executable"] == str(podman)
    deployment = tmp_path / "appdata" / "deployment"
    identity = (
        (deployment / ".ltcook-compose-project").read_text(encoding="utf-8").strip()
    )
    assert receipt["compose_project"] == identity
    retry = prepare_services(
        tmp_path / "appdata",
        environment={
            "LTCOOK_PODMAN_EXECUTABLE": str(podman),
            "PODMAN_COMPOSE_PROVIDER": str(provider),
            "PATH": "",
        },
    )
    retried_receipt = json.loads(retry.read_text(encoding="utf-8"))
    assert retried_receipt["compose_project"] == identity
    second = prepare_services(
        tmp_path / "other-appdata", environment={"LTCOOK_SERVICE_CONNECTION": "direct"}
    )
    second_receipt = json.loads(second.read_text(encoding="utf-8"))
    assert second_receipt["compose_project"] != identity


def test_missing_compose_provider_is_installed_under_ltcook_deployment(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    uv = tmp_path / "uv"
    uv.write_text("uv")
    deployment = tmp_path / "deployment"
    calls: list[list[str]] = []

    def fake_run(arguments, *, environment, cwd=None, required=True):
        calls.append(list(arguments))
        if arguments[1:3] == ["tool", "install"]:
            provider_bin = Path(arguments[arguments.index("--bin-dir") + 1])
            provider_bin.mkdir(parents=True, exist_ok=True)
            (provider_bin / "podman-compose").write_text("private provider")
        return type("Result", (), {"stdout": ""})()

    monkeypatch.setattr(
        "ltcook_distr.payload.app_lifecycle.prepare_services.run", fake_run
    )
    provider = _provider({"APPRC_UV_PATH": str(uv), "PATH": ""}, deployment)
    assert provider == str(deployment / "compose-provider/bin/podman-compose")
    assert calls[0][-1] == "podman-compose==1.6.0"
    assert calls[1][1] == "--version"


def test_runtime_readiness_requires_matching_payload_and_files(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    deployment = tmp_path / "deployment"
    app = deployment / "app"
    node = deployment / "node" / ("node.exe" if os.name == "nt" else "bin/node")
    (app / "runtime/dist").mkdir(parents=True)
    (app / "teams/default/resources").mkdir(parents=True)
    (app / "teams/default-minimal/resources").mkdir(parents=True)
    (app / "node_modules").mkdir()
    node.parent.mkdir(parents=True)
    node.write_text("node")
    (app / "runtime/dist/main.js").write_text("compiled")
    record = {
        "schema": 1,
        "fingerprint": "declared-inputs",
        "node": str(node),
        "app": str(app),
        "browser_available": True,
    }
    monkeypatch.setattr(prepare_runtime, "_chrome_binary", lambda _home: node)
    (deployment / "runtime.json").write_text(json.dumps(record))
    assert _ready(deployment, "declared-inputs")
    assert not _ready(deployment, "changed-lock")
    (app / "node_modules").rmdir()
    assert not _ready(deployment, "declared-inputs")


def test_browser_failure_is_retryable_without_invalidating_core(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from ltcook_distr.payload.app_lifecycle.prepare_runtime import _retry_browser

    deployment = tmp_path / "deployment"
    app = deployment / "app"
    node = deployment / "node" / ("node.exe" if os.name == "nt" else "bin/node")
    browser = (
        app
        / "node_modules/.bin"
        / ("agent-browser.cmd" if os.name == "nt" else "agent-browser")
    )
    browser.parent.mkdir(parents=True)
    browser.write_text("browser command")
    node.parent.mkdir(parents=True)
    node.write_text("node")
    (app / "runtime/dist").mkdir(parents=True)
    (app / "runtime/dist/main.js").write_text("compiled")
    (app / "teams/default/resources").mkdir(parents=True)
    (app / "teams/default-minimal/resources").mkdir(parents=True)
    (app / "node_modules").mkdir(exist_ok=True)
    record = {
        "schema": 1,
        "fingerprint": "payload",
        "node": str(node),
        "app": str(app),
        "browser_available": False,
        "browser_unavailable_reason": "browser download failed",
    }
    (deployment / "runtime.json").write_text(json.dumps(record))
    monkeypatch.setattr(prepare_runtime, "_chrome_binary", lambda _home: None)
    assert _ready(deployment, "payload")
    calls: list[list[str]] = []

    def fake_run(arguments, *, environment, cwd=None, required=True):
        calls.append(list(arguments))
        return type("Result", (), {"stdout": ""})()

    monkeypatch.setattr(prepare_runtime, "run", fake_run)
    monkeypatch.setattr(prepare_runtime, "_chrome_binary", lambda _home: node)
    _retry_browser(deployment, record, {})
    assert calls[0][-1] == "install"
    updated = json.loads((deployment / "runtime.json").read_text(encoding="utf-8"))
    assert updated["browser_available"] is True
    assert updated["browser_executable"] == str(node)


@pytest.mark.parametrize(
    ("browser_setting", "expected_browser_install"),
    [("false", False), ("true", True), (None, True)],
)
def test_browser_flag_controls_optional_setup_without_skipping_node(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    browser_setting: str | None,
    expected_browser_install: bool,
) -> None:
    root = tmp_path / ".cache" / "bundle"
    for name in ("package.json", "package-lock.json", ".node-version"):
        (root / name).parent.mkdir(parents=True, exist_ok=True)
        (root / name).write_text("26.13.1" if name == ".node-version" else "{}")
    (root / "runtime/dist").mkdir(parents=True)
    (root / "runtime/dist/main.js").write_text("runtime")
    (root / "runtime/package.json").write_text("{}")
    for team in ("default", "default-minimal"):
        (root / "teams" / team / "resources").mkdir(parents=True)
        (root / "teams" / team / "resources/rules.md").write_text("rules")

    for private_directory in (
        "runtime/node_modules/private",
        "runtime/.cache/private",
        "runtime/.git/private",
    ):
        directory = root / private_directory
        directory.mkdir(parents=True)
        (directory / "marker").write_text("not shipped")
    source = type(
        "PreparedSource", (), {"project_directory": root, "source_root": None}
    )()
    calls: list[list[str]] = []
    chrome = tmp_path / "chrome"
    chrome.write_text("browser")

    def extract(_archive: Path, stage: Path) -> None:
        extracted = stage / "selected-node"
        bin_directory = extracted if os.name == "nt" else extracted / "bin"
        bin_directory.mkdir(parents=True)
        (bin_directory / ("node.exe" if os.name == "nt" else "node")).write_text("node")
        (bin_directory / ("npm.cmd" if os.name == "nt" else "npm")).write_text("npm")

    def fake_run(arguments, *, environment, cwd=None, required=True):
        calls.append(list(arguments))
        if "ci" in " ".join(arguments):
            browser_directory = cwd / "node_modules/.bin"
            browser_directory.mkdir(parents=True, exist_ok=True)
            (
                browser_directory
                / ("agent-browser.cmd" if os.name == "nt" else "agent-browser")
            ).write_text("browser")

    monkeypatch.setattr(
        prepare_runtime,
        "_node_asset",
        lambda *_args: ("https://node.invalid/archive", "selected-node", ".tar.gz"),
    )
    monkeypatch.setattr(
        prepare_runtime, "download", lambda _url, archive: archive.write_text("archive")
    )
    monkeypatch.setattr(prepare_runtime, "extract_archive", extract)
    monkeypatch.setattr(prepare_runtime, "run", fake_run)
    monkeypatch.setattr(prepare_runtime, "_chrome_binary", lambda _home: chrome)
    environment = (
        {} if browser_setting is None else {"LTCOOK_BROWSER_ENABLED": browser_setting}
    )

    deployment = prepare_runtime.prepare_runtime(
        source, tmp_path / "appdata", environment=environment
    )

    assert any("ci" in " ".join(command) for command in calls)
    browser_calls = [
        command for command in calls if "agent-browser" in " ".join(command)
    ]
    assert bool(browser_calls) is expected_browser_install
    assert all("--with-deps" not in command for command in calls)
    record = json.loads((deployment / "runtime.json").read_text(encoding="utf-8"))
    assert record["browser_available"] is expected_browser_install
    app = deployment / "app"
    assert (app / "runtime/dist/main.js").read_text(encoding="utf-8") == "runtime"
    assert not (app / "runtime/node_modules").exists()
    assert not (app / "runtime/.cache").exists()
    assert not (app / "runtime/.git").exists()
    if browser_setting == "false":
        previous_calls = len(calls)
        prepare_runtime.prepare_runtime(
            source, tmp_path / "appdata", environment=environment
        )
        assert len(calls) == previous_calls
        retries: list[bool] = []
        monkeypatch.setattr(
            prepare_runtime, "_retry_browser", lambda *_args: retries.append(True)
        )
        prepare_runtime.prepare_runtime(
            source,
            tmp_path / "appdata",
            environment={"LTCOOK_BROWSER_ENABLED": "true"},
        )
        assert retries == [True]


def test_service_secret_initialization_persists_app_rc_fields(
    tmp_path: Path,
) -> None:
    """Run secret initialization in the installed interpreter and verify persistence."""
    import sys

    from ltcook.config.app import APP_RC
    from ltcook.config.bundle import LtcookConfig
    from ltcook_distr.payload.app_lifecycle.actions import (
        initialize_service_secrets,
    )

    home = tmp_path / "home"
    environment = {
        "HOME": str(home),
        "USERPROFILE": str(home),
        "XDG_CONFIG_HOME": str(tmp_path / "config"),
        "XDG_DATA_HOME": str(tmp_path / "data"),
        "XDG_CACHE_HOME": str(tmp_path / "cache"),
        "XDG_STATE_HOME": str(tmp_path / "state"),
        "LOCALAPPDATA": str(tmp_path / "local"),
        "APPDATA": str(tmp_path / "roaming"),
    }
    interpreter = Path(sys.executable)
    initialize_service_secrets(interpreter, environment)
    configuration = APP_RC.manage(environment=environment).resolve().build(LtcookConfig)
    recorded = (
        configuration.runtime.api_token,
        configuration.crawl4ai.api_token,
        configuration.searxng.secret,
    )
    assert all(recorded)

    initialize_service_secrets(interpreter, environment)
    resolved_again = (
        APP_RC.manage(environment=environment).resolve().build(LtcookConfig)
    )
    assert recorded == (
        resolved_again.runtime.api_token,
        resolved_again.crawl4ai.api_token,
        resolved_again.searxng.secret,
    )


@pytest.mark.system
def test_compose_stack_renders_without_starting_containers() -> None:
    """Validate native Compose rendering; requires Podman and a provider, starts no services."""
    import shutil
    import subprocess

    root = Path(__file__).resolve().parents[3]
    podman = shutil.which("podman")
    provider = shutil.which("podman-compose") or shutil.which("docker-compose")
    if podman is None or provider is None:
        pytest.skip("system render requires an installed Podman Compose provider")
    environment = os.environ.copy()
    environment["PODMAN_COMPOSE_PROVIDER"] = provider
    environment["CRAWL4AI_API_TOKEN"] = "render-only-token"
    environment["SEARXNG_SECRET"] = "render-only-secret"
    compose_file = root / "services/compose.yaml"
    result = subprocess.run(
        [
            podman,
            "compose",
            "--project-name",
            "ltcook",
            "-f",
            str(compose_file),
            "config",
        ],
        cwd=compose_file.parent,
        env=environment,
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == 0, "Podman Compose could not render the LTCook stack."


def test_appdata_purge_removes_only_ltcook_deployment(tmp_path: Path) -> None:
    from ltcook_distr.payload.app_lifecycle.actions import maintenance_handlers

    root = tmp_path / "appdata"
    deployment = root / "deployment"
    deployment.mkdir(parents=True)
    (deployment / "services.json").write_text(
        json.dumps({"schema": 1, "connection": "direct"})
    )
    unrelated = root / "another-app"
    unrelated.mkdir()
    (unrelated / "keep").write_text("preserve")
    handlers = maintenance_handlers()
    assert handlers.appdata is not None and handlers.appdata.purge is not None
    operation = handlers.appdata.purge
    result = operation.apply(operation.plan(root))
    assert result.removed == (deployment,)
    assert not deployment.exists()
    assert (unrelated / "keep").read_text() == "preserve"


def test_cache_clear_removes_only_ltcook_cache(tmp_path: Path) -> None:
    from ltcook_distr.payload.app_lifecycle.actions import maintenance_handlers

    root = tmp_path / "cache"
    owned = root / "ltcook"
    owned.mkdir(parents=True)
    (owned / "temporary").write_text("discard")
    unrelated = root / "other-tool"
    unrelated.mkdir()
    (unrelated / "keep").write_text("preserve")
    handlers = maintenance_handlers()
    assert handlers.cache is not None and handlers.cache.clear is not None
    operation = handlers.cache.clear
    result = operation.apply(operation.plan(root))
    assert result.removed == (owned,)
    assert (unrelated / "keep").read_text() == "preserve"
