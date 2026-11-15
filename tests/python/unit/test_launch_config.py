import errno
import json
import os
import urllib.error
from pathlib import Path
from types import SimpleNamespace

import pytest

from ltcook import launch
from ltcook.config.pi_config import pi_documents, write_pi_config


def test_markerless_launch_uses_global_app_rc_without_creating_selection_files(
    tmp_path,
):
    from ltcook.config.app import APP_RC

    project = tmp_path / "existing-project"
    project.mkdir()
    user_home = tmp_path / "home"
    appdata_root = tmp_path / "data"
    config_root = tmp_path / "config"
    environment = {
        "HOME": str(user_home),
        "USERPROFILE": str(user_home),
        "APPDATA": str(config_root),
        "LOCALAPPDATA": str(appdata_root),
        "XDG_CONFIG_HOME": str(config_root),
        "XDG_DATA_HOME": str(appdata_root),
        "XDG_CACHE_HOME": str(tmp_path / "cache"),
        "XDG_STATE_HOME": str(tmp_path / "state"),
        "LTCOOK_WORKSPACE": str(tmp_path / "stale-workspace"),
    }
    paths = APP_RC.paths(environment=environment)
    user_config = paths.require("config")
    user_config.mkdir(parents=True)
    global_auth = tmp_path / "global-auth"
    (user_config / APP_RC.schema.user_dotenv_filename).write_text(
        f"LTCOOK_TEAM=global-team\nLTCOOK_PI_AUTH_DIR={global_auth}\n",
        encoding="utf-8",
    )
    registry_file = APP_RC.workspaces(environment=environment).registry_path()
    marker_file = project / APP_RC.schema.workspace_dotenv_filename

    global_launch = launch.resolve_launch(project, original_environment=environment)

    assert global_launch.environment["LTCOOK_TEAM"] == "global-team"
    assert global_launch.environment["LTCOOK_PI_AUTH_DIR"] == str(global_auth.resolve())
    assert global_launch.environment["LTCOOK_WORKSPACE"] == str(project.resolve())
    assert not marker_file.exists()
    assert not registry_file.exists()
    assert global_launch.environment["LTCOOK_RUNTIME_STATE_DIR"] == str(
        paths.require("state") / "runtime"
    )
    assert global_launch.environment["LTCOOK_GUIDANCE_DIR"] == str(
        paths.require("config") / "guidance"
    )
    assert global_launch.environment["LTCOOK_DATABASE"] == str(
        paths.require("state") / "runtime" / "coordination.sqlite"
    )

    marker_file.write_text(
        f"LTCOOK_TEAM=project-team\nLTCOOK_PI_AUTH_DIR={tmp_path / 'project-auth'}\n"
        f"LTCOOK_RUNTIME_STATE_DIR={project / 'state'}\n"
        f"LTCOOK_GUIDANCE_DIR={project / 'guidance'}\n"
        f"LTCOOK_DATABASE={project / 'coordination.sqlite'}\n",
        encoding="utf-8",
    )
    project_launch = launch.resolve_launch(project, original_environment=environment)

    assert project_launch.environment["LTCOOK_TEAM"] == "project-team"
    assert project_launch.environment["LTCOOK_PI_AUTH_DIR"] == str(
        global_auth.resolve()
    )
    assert not registry_file.exists()
    for key in (
        "LTCOOK_RUNTIME_STATE_DIR",
        "LTCOOK_GUIDANCE_DIR",
        "LTCOOK_RIED_CACHE_DIR",
        "LTCOOK_DATABASE",
    ):
        assert project_launch.environment[key] == global_launch.environment[key]


@pytest.mark.parametrize("connection", [None, "", "named-podman-connection"])
def test_launch_exports_only_nonempty_podman_connection(tmp_path, connection):
    environment = {
        "HOME": str(tmp_path),
        "USERPROFILE": str(tmp_path),
        "APPDATA": str(tmp_path / "config"),
        "LOCALAPPDATA": str(tmp_path / "data"),
        "XDG_CONFIG_HOME": str(tmp_path / "config"),
        "XDG_DATA_HOME": str(tmp_path / "data"),
        "XDG_CACHE_HOME": str(tmp_path / "cache"),
        "XDG_STATE_HOME": str(tmp_path / "state"),
    }
    if connection is not None:
        environment["CONTAINER_CONNECTION"] = connection

    result = launch.resolve_launch(original_environment=environment)

    if connection:
        assert result.environment["CONTAINER_CONNECTION"] == connection
    else:
        assert "CONTAINER_CONNECTION" not in result.environment


class Section:
    def __init__(self, values, **attributes):
        self.values = values
        self.__dict__.update(attributes)

    def current_env_mapping(self, *, prefixed, include_empty):
        assert prefixed is True
        assert include_empty is True
        return self.values


def _native_config():
    return SimpleNamespace(
        paseo=SimpleNamespace(home=""),
        pi=SimpleNamespace(command="", home=""),
        runtime=SimpleNamespace(
            api_token="secret-value",
            paseo_listen="127.0.0.1:6767",
            paseo_password="secret-value",
        ),
        crawl4ai=SimpleNamespace(api_token="secret-value"),
        searxng=SimpleNamespace(secret="secret-value"),
        web=SimpleNamespace(
            searxng_url="http://127.0.0.1:8080",
            crawl4ai_url="http://127.0.0.1:11235",
            ssrf_allow_ranges="127.0.0.0/8,::1/128",
        ),
    )


def test_workspace_launch_uses_shell_provenance_before_resolving(monkeypatch, tmp_path):
    source_root = tmp_path / "source-root"
    original = {
        "LTCOOK_TEAM": "shell-team",
        "SHELL_ONLY": "preserved",
        "LTCOOK_JS_ROOT": str(source_root),
    }
    process_environment = {
        "LTCOOK_TEAM": "root-resolved-team",
        "LTCOOK_SHELL_PROVENANCE": json.dumps(original),
    }
    seen = {}
    config = SimpleNamespace(
        app=Section(
            {
                "LTCOOK_TEAM": "workspace-team",
                "LTCOOK_WORKSPACE": str(tmp_path / "root-workspace"),
            },
            deployment="",
        ),
        runtime=Section(
            {"LTCOOK_MODEL_SMOL": "workspace-model", "LTCOOK_TEAM": "workspace-team"},
            pi_auth_dir="~/.pi/agent",
            state_dir="",
            guidance_dir="",
            database="",
        ),
        web=Section({"LTCOOK_CRAWL4AI_URL": ""}),
        pi=Section({}),
    )

    class Resolved:
        workspace = tmp_path
        paths = SimpleNamespace(require=lambda _kind: tmp_path / "appdata")

        def build(self, bundle):
            return config

    def resolve_config(workspace_root, *, environment):
        seen["workspace"] = Path(workspace_root)
        seen["environment"] = environment
        return Resolved()

    monkeypatch.setattr(launch, "resolve_global_config", lambda **_kwargs: Resolved())
    monkeypatch.setattr(launch, "resolve_config", resolve_config)
    result = launch.resolve_launch(tmp_path, original_environment=process_environment)

    assert seen["workspace"] == tmp_path
    assert seen["environment"] == original
    assert result.environment["LTCOOK_TEAM"] == "workspace-team"
    assert result.environment["LTCOOK_WORKSPACE"] == str(tmp_path.resolve())
    assert result.environment["LTCOOK_JS_ROOT"] == str(tmp_path / "source-root")
    assert result.environment["PATH"].split(os.pathsep)[1] == str(
        source_root / "node_modules" / ".bin"
    )
    assert result.environment["LTCOOK_MODEL_SMOL"] == "workspace-model"
    assert result.environment["SHELL_ONLY"] == "preserved"
    assert "LTCOOK_SHELL_PROVENANCE" not in result.environment
    next_launch = launch.resolve_launch(
        tmp_path, original_environment=process_environment
    )
    assert (
        result.environment["LTCOOK_SESSION"]
        != next_launch.environment["LTCOOK_SESSION"]
    )
    resumed = launch.resolve_launch(
        tmp_path,
        original_environment={
            **original,
            "LTCOOK_SESSION": result.environment["LTCOOK_SESSION"],
        },
    )
    assert resumed.environment["LTCOOK_SESSION"] == result.environment["LTCOOK_SESSION"]
    assert (
        resumed.environment["PI_CODING_AGENT_DIR"]
        == result.environment["PI_CODING_AGENT_DIR"]
    )


def test_production_javascript_root_defaults_under_deployment(monkeypatch, tmp_path):
    config = SimpleNamespace(
        app=Section({}, deployment=""),
        runtime=Section(
            {}, pi_auth_dir="~/.pi/agent", state_dir="", guidance_dir="", database=""
        ),
        web=Section({}),
        pi=Section({}),
    )

    class Resolved:
        workspace = None
        paths = SimpleNamespace(require=lambda _kind: tmp_path / "appdata")

        def build(self, bundle):
            return config

    monkeypatch.setattr(launch, "resolve_global_config", lambda **_kwargs: Resolved())
    monkeypatch.setattr(
        launch, "resolve_config", lambda workspace, *, environment: Resolved()
    )
    user_home = tmp_path / "user-home"
    result = launch.resolve_launch(
        None,
        original_environment={
            "HOME": str(user_home),
            "LTCOOK_WORKSPACE": "stale-workspace",
            "LTCOOK_SESSION": "stale-session",
        },
    )

    assert result.environment["LTCOOK_JS_ROOT"] == str(
        tmp_path / "appdata" / "deployment" / "app"
    )
    assert result.environment["PASEO_HOME"] == str(
        tmp_path / "appdata" / "deployment" / "paseo"
    )
    assert Path(result.environment["PASEO_HOME"]).is_relative_to(
        tmp_path / "appdata" / "deployment"
    )
    assert result.workspace_root is None
    assert "LTCOOK_WORKSPACE" not in result.environment
    assert "LTCOOK_SESSION" not in result.environment
    assert result.environment["PI_CODING_AGENT_DIR"] == str(
        tmp_path / "appdata" / "deployment" / "pi"
    )
    assert result.environment["LTCOOK_PI_AUTH_DIR"] == str(
        (user_home / ".pi" / "agent").resolve()
    )


def test_pi_documents_keep_secrets_out_of_json_and_write_private_files(tmp_path):
    config = _native_config()
    deployment = tmp_path / "deployment"
    pi_home = deployment / "workspaces" / "workspace" / "pi"
    paseo_config = deployment / "paseo" / "config.json"
    paseo_config.parent.mkdir(parents=True)
    paseo_config.write_text('{"user-owned": true}\n', encoding="utf-8")
    documents = pi_documents(
        config,
        owned_dir=deployment / "app",
        pi_home=pi_home,
    )
    rendered = json.dumps(list(documents.values()))

    document = documents[pi_home / "web-search.json"]
    assert document["provider"] == "searxng"
    assert document["webSearch"] == {"allowedProviders": ["searxng"]}
    assert "searchRouting" not in document
    assert document["fetchRouting"] == {
        "providers": ["http", "crawl4ai"],
        "allowRemoteHostedProviders": False,
    }
    assert document["fetch"] == {
        "allowedModes": ["readable", "raw"],
        "defaultMode": "readable",
    }
    assert set(documents) == {pi_home / "web-search.json", pi_home / "models.json"}
    assert (
        documents[pi_home / "models.json"]["providers"]["ollama"]["models"][0][
            "contextWindow"
        ]
        == 8192
    )
    assert documents[pi_home / "models.json"]["providers"]["ollama"]["models"][0][
        "thinkingLevelMap"
    ] == {"off": "none", "low": "low", "high": "high"}
    assert "$CRAWL4AI_API_TOKEN" in rendered
    assert "secret-value" not in rendered
    assert all("context7" not in document for document in documents.values())

    written = write_pi_config(
        config,
        owned_dir=deployment / "app",
        pi_home=pi_home,
    )
    assert set(written) == set(documents)
    assert all(path.stat().st_mode & 0o777 == 0o600 for path in written)
    assert {path.parent for path in written} == {pi_home}
    assert json.loads(paseo_config.read_text(encoding="utf-8")) == {"user-owned": True}


def test_pi_writer_preserves_unrelated_local_models(tmp_path):
    config = _native_config()
    deployment = tmp_path / "deployment"
    pi_home = deployment / "workspaces" / "workspace" / "pi"
    pi_home.mkdir(parents=True)
    models_path = pi_home / "models.json"
    models_path.write_text(json.dumps({"providers": {"custom": {"models": []}}}))

    write_pi_config(config, owned_dir=deployment / "app", pi_home=pi_home)

    models = json.loads(models_path.read_text())
    assert "custom" in models["providers"]
    assert "ollama" in models["providers"]


def test_pi_writer_refuses_external_home_without_overwriting_files(tmp_path):
    deployment = tmp_path / "deployment"
    external_home = tmp_path / "outside"
    external_home.mkdir()
    existing_file = external_home / "web-search.json"
    existing_file.write_text("user-owned data\n", encoding="utf-8")

    with pytest.raises(
        ValueError,
        match=r"PI_CODING_AGENT_DIR must resolve inside the LTCook deployment\.",
    ):
        write_pi_config(
            _native_config(),
            owned_dir=deployment / "app",
            pi_home=external_home,
        )

    assert existing_file.read_text(encoding="utf-8") == "user-owned data\n"


def _runtime_environment(tmp_path):
    deployment = tmp_path / "deployment"
    return {
        "LTCOOK_TEAM": "default-minimal",
        "LTCOOK_API_LISTEN": "127.0.0.1:48731",
        "LTCOOK_API_TOKEN": "test-only-token",
        "LTCOOK_DEPLOYMENT_DIR": str(deployment),
        "LTCOOK_DATABASE": str(deployment / "coordination.sqlite"),
    }


@pytest.mark.parametrize(
    ("address", "expected"),
    [
        ("127.0.0.1:48731", "http://127.0.0.1:48731"),
        ("[::1]:48731", "http://[::1]:48731"),
    ],
)
def test_runtime_api_url_accepts_only_loopback(address, expected):
    from ltcook._runtime_client import runtime_api_url

    assert runtime_api_url(address) == expected


@pytest.mark.parametrize(
    "address",
    [
        "localhost:48731",
        "0.0.0.0:48731",
        "127.0.0.1:0",
        "127.0.0.1:65536",
        "[::1]48731",
        "https://127.0.0.1:48731",
    ],
)
def test_runtime_api_url_rejects_non_loopback_or_malformed(address):
    from ltcook._runtime_client import RuntimeClientError, runtime_api_url

    with pytest.raises(RuntimeClientError):
        runtime_api_url(address)


def test_probe_requires_full_authenticated_installation_identity(monkeypatch, tmp_path):
    from ltcook import _runtime_client as client

    environment = _runtime_environment(tmp_path)
    payload = {
        "teamSelection": "default-minimal",
        "instanceId": "d30f894c-5fdc-4fa6-aa83-9829f64be3c4",
        "deploymentRoot": str(Path(environment["LTCOOK_DEPLOYMENT_DIR"]).resolve()),
        "databasePath": str(Path(environment["LTCOOK_DATABASE"]).resolve()),
        "paseoListen": "127.0.0.1:6767",
        "backendLogPath": None,
        "paseoLogPath": str(tmp_path / "paseo" / "daemon.log"),
        "telemetryLogPath": str(tmp_path / "runtime.jsonl"),
    }

    class Response:
        status = 200

        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return None

        def read(self):
            return json.dumps(payload).encode()

    seen = []

    def open_request(request, *, timeout):
        seen.append((request, timeout))
        return Response()

    monkeypatch.setattr(client._HTTP, "open", open_request)
    status = client.probe_runtime(environment)
    assert isinstance(status, client.RuntimeStatus)
    assert status.instance_id == payload["instanceId"]
    request, timeout = seen[0]
    assert request.full_url.endswith("/v1/status")
    assert request.get_method() == "GET"
    assert request.get_header("Authorization") == "Bearer test-only-token"
    assert timeout == 1


@pytest.mark.parametrize(
    ("exception", "expected"),
    [
        (TimeoutError(), "starting"),
        (urllib.error.URLError(TimeoutError()), "starting"),
        (
            urllib.error.URLError(OSError(errno.ETIMEDOUT, "timed out")),
            "starting",
        ),
        (
            urllib.error.URLError(OSError(errno.ECONNREFUSED, "refused")),
            None,
        ),
    ],
)
def test_probe_distinguishes_starting_from_absent(
    monkeypatch, tmp_path, exception, expected
):
    import socket

    from ltcook import _runtime_client as client

    monkeypatch.setattr(
        client._HTTP, "open", lambda *_args, **_kwargs: (_ for _ in ()).throw(exception)
    )
    with socket.socket() as owner:
        owner.bind(("127.0.0.1", 0))
        owner.listen()
        environment = _runtime_environment(tmp_path)
        environment["LTCOOK_API_LISTEN"] = f"127.0.0.1:{owner.getsockname()[1]}"
        assert client.probe_runtime(environment) == expected


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("teamSelection", "another-team"),
        ("deploymentRoot", "/other/deployment"),
        ("databasePath", "/other/database.sqlite"),
        ("instanceId", "not-a-uuid"),
    ],
)
def test_probe_rejects_mismatched_or_incompatible_status(
    monkeypatch, tmp_path, field, value
):
    from ltcook import _runtime_client as client

    environment = _runtime_environment(tmp_path)
    payload = {
        "teamSelection": "default-minimal",
        "instanceId": "d30f894c-5fdc-4fa6-aa83-9829f64be3c4",
        "deploymentRoot": str(Path(environment["LTCOOK_DEPLOYMENT_DIR"]).resolve()),
        "databasePath": str(Path(environment["LTCOOK_DATABASE"]).resolve()),
        "paseoListen": "127.0.0.1:6767",
        "backendLogPath": None,
        "paseoLogPath": str(tmp_path / "paseo" / "daemon.log"),
        "telemetryLogPath": str(tmp_path / "runtime.jsonl"),
    }
    payload[field] = value

    class Response:
        status = 200

        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return None

        def read(self):
            return json.dumps(payload).encode()

    monkeypatch.setattr(client._HTTP, "open", lambda *_args, **_kwargs: Response())
    with pytest.raises(client.RuntimeClientError):
        client.probe_runtime(environment)


def test_start_runtime_appends_private_capture_and_original_provenance(
    monkeypatch, tmp_path
):
    from ltcook import _runtime_client as client

    deployment = tmp_path / "deployment"
    node = tmp_path / "node"
    native = tmp_path / "app" / "runtime" / "dist" / "main.js"
    node.touch()
    native.parent.mkdir(parents=True)
    native.touch()
    environment = _runtime_environment(tmp_path)
    environment.update(
        {"LTCOOK_NODE_EXECUTABLE": str(node), "LTCOOK_JS_ROOT": str(tmp_path / "app")}
    )
    capture = deployment / "logs" / "backend.log"
    capture.parent.mkdir(parents=True)
    capture.write_bytes(b"prior output\n")
    observed = {}

    class Process:
        pass

    def spawn(arguments, **kwargs):
        observed["arguments"] = arguments
        observed["kwargs"] = kwargs
        return Process()

    monkeypatch.setattr(client.subprocess, "Popen", spawn)
    started = client.start_runtime(
        environment,
        workspace_root=None,
        shell_environment={"SHELL_ONLY": "original"},
        detached=True,
    )
    assert started.backend_offset == len(b"prior output\n")
    assert observed["arguments"] == [str(node), str(native)]
    assert observed["kwargs"]["stdin"] == client.subprocess.DEVNULL
    assert observed["kwargs"]["stderr"] == client.subprocess.STDOUT
    assert observed["kwargs"]["start_new_session"] == (os.name == "posix")
    assert (
        observed["kwargs"]["env"]["LTCOOK_SHELL_PROVENANCE"]
        == '{"SHELL_ONLY":"original"}'
    )
    assert observed["kwargs"]["env"]["LTCOOK_BACKEND_LOG_PATH"] == str(capture)
    assert capture.read_bytes() == b"prior output\n"
    if os.name == "posix":
        assert capture.stat().st_mode & 0o777 == 0o600


def test_start_runtime_refuses_linked_capture(monkeypatch, tmp_path):
    from ltcook import _runtime_client as client

    deployment = tmp_path / "deployment"
    deployment.mkdir()
    (deployment / "logs").symlink_to(tmp_path, target_is_directory=True)
    node = tmp_path / "node"
    node.touch()
    native = tmp_path / "app" / "runtime" / "dist" / "main.js"
    native.parent.mkdir(parents=True)
    native.touch()
    environment = _runtime_environment(tmp_path)
    environment.update(
        {"LTCOOK_NODE_EXECUTABLE": str(node), "LTCOOK_JS_ROOT": str(tmp_path / "app")}
    )
    monkeypatch.setattr(
        client.subprocess,
        "Popen",
        lambda *_args, **_kwargs: pytest.fail("unsafe log path must prevent spawn"),
    )
    with pytest.raises(client.RuntimeClientError, match="unsafe runtime log directory"):
        client.start_runtime(
            environment, workspace_root=None, shell_environment={}, detached=True
        )


def test_shell_provenance_cannot_be_nested_as_an_environment_value():
    provenance = json.dumps(
        {"SHELL_ONLY": "preserved", "LTCOOK_SHELL_PROVENANCE": "nested"}
    )
    assert launch._shell_environment({"LTCOOK_SHELL_PROVENANCE": provenance}) == {
        "SHELL_ONLY": "preserved"
    }


def test_explicit_global_runtime_reuses_ready_owner_without_session_or_spawn(
    monkeypatch,
):
    from ltcook._runtime_client import RuntimeStatus

    status = RuntimeStatus(
        "default-minimal",
        "d30f894c-5fdc-4fa6-aa83-9829f64be3c4",
        "/deployment",
        "/deployment/database.sqlite",
        "127.0.0.1:6767",
        "/deployment/logs/backend.log",
        "/deployment/paseo/daemon.log",
        "/deployment/logs/runtime.jsonl",
    )
    configuration = launch.LaunchConfig({"LTCOOK_TEAM": "default-minimal"}, None, None)
    monkeypatch.setattr(launch, "_shell_environment", lambda _environment: {})
    monkeypatch.setattr(launch, "ensure_service_secrets", lambda _environment: None)
    monkeypatch.setattr(
        launch, "resolve_launch", lambda *_args, **_kwargs: configuration
    )
    monkeypatch.setattr(launch, "probe_runtime", lambda _environment: status)
    monkeypatch.setattr(
        launch,
        "_open_existing_runtime",
        lambda *_args: pytest.fail("global reuse must not open a project session"),
    )
    monkeypatch.setattr(
        launch,
        "start_runtime",
        lambda *_args, **_kwargs: pytest.fail("ready owner must not be spawned again"),
    )
    assert launch.runtime_command(None) is None


@pytest.fixture
def secret_start_environment(tmp_path):
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    native = tmp_path / "deployment/app/runtime/dist/main.js"
    native.parent.mkdir(parents=True)
    native.touch()
    node = tmp_path / "node"
    node.touch()
    return {
        "HOME": str(tmp_path / "home"),
        "USERPROFILE": str(tmp_path / "home"),
        "APPDATA": str(tmp_path / "config"),
        "LOCALAPPDATA": str(tmp_path / "data"),
        "XDG_CONFIG_HOME": str(tmp_path / "config"),
        "XDG_DATA_HOME": str(tmp_path / "data"),
        "XDG_CACHE_HOME": str(tmp_path / "cache"),
        "XDG_STATE_HOME": str(tmp_path / "state"),
        "LTCOOK_JS_ROOT": str(tmp_path / "deployment/app"),
        "LTCOOK_NODE_EXECUTABLE": str(node),
        "CRAWL4AI_API_TOKEN": "shell-crawl-token",
    }


@pytest.mark.parametrize("command", ["runtime", "desktop", "service-start"])
def test_start_persists_missing_secrets_before_the_child_uses_them(
    monkeypatch, tmp_path, secret_start_environment, command
):
    from ltcook import _browser
    from ltcook._runtime_client import RuntimeStatus
    from ltcook.config.app import APP_RC
    from ltcook.config.bundle import LtcookConfig

    shell = secret_start_environment
    monkeypatch.setenv("LTCOOK_SHELL_PROVENANCE", json.dumps(shell))
    monkeypatch.setenv("LTCOOK_API_TOKEN", "overlay-must-not-be-used")
    captured = []
    status = RuntimeStatus(
        "default-minimal",
        "d30f894c-5fdc-4fa6-aa83-9829f64be3c4",
        "/deployment",
        "/deployment/database.sqlite",
        "127.0.0.1:6767",
        "/deployment/logs/backend.log",
        "/deployment/paseo/daemon.log",
        "/deployment/logs/runtime.jsonl",
    )

    def probe(environment):
        captured.append(dict(environment))
        return status

    def service_process(*_arguments, env, **_kwargs):
        captured.append(dict(env))
        return SimpleNamespace(stdout="", stderr="", returncode=0)

    monkeypatch.setattr(launch, "probe_runtime", probe)
    monkeypatch.setattr(launch.subprocess, "run", service_process)
    monkeypatch.setattr(_browser, "open_paseo_url", lambda _url: None)
    monkeypatch.setattr(launch, "follow_runtime_logs", lambda *_args, **_kwargs: 0)

    def start():
        if command == "runtime":
            launch.runtime_command(None)
        elif command == "desktop":
            assert launch.desktop_command() == 0
        else:
            launch.service_action("start", tmp_path / "workspace")

    start()
    configuration = (
        APP_RC.manage(environment=shell)
        .inspect(include_workspace=False)
        .resolved.build(LtcookConfig)
    )
    assert configuration.runtime.api_token
    assert configuration.runtime.api_token != "overlay-must-not-be-used"
    assert configuration.searxng.secret
    assert configuration.crawl4ai.api_token == "shell-crawl-token"
    assert captured[-1]["LTCOOK_API_TOKEN"] == configuration.runtime.api_token
    assert captured[-1]["SEARXNG_SECRET"] == configuration.searxng.secret
    assert captured[-1]["CRAWL4AI_API_TOKEN"] == "shell-crawl-token"
    config_root = Path(shell["XDG_CONFIG_HOME"])
    persisted = {
        path.relative_to(config_root): path.read_bytes()
        for path in config_root.rglob("*")
        if path.is_file()
    }
    assert any(
        configuration.runtime.api_token.encode() in content
        for content in persisted.values()
    )
    assert any(
        configuration.searxng.secret.encode() in content
        for content in persisted.values()
    )
    assert all(b"shell-crawl-token" not in content for content in persisted.values())
    start()
    assert captured[-1]["LTCOOK_API_TOKEN"] == configuration.runtime.api_token
    assert persisted == {
        path.relative_to(config_root): path.read_bytes()
        for path in config_root.rglob("*")
        if path.is_file()
    }


@pytest.mark.parametrize("action", ["status", "stop", "logs"])
def test_read_only_service_actions_leave_missing_secrets_unwritten(
    monkeypatch, tmp_path, secret_start_environment, action
):
    shell = secret_start_environment
    monkeypatch.setenv("LTCOOK_SHELL_PROVENANCE", json.dumps(shell))
    captured = []

    def service_process(*_arguments, env, **_kwargs):
        captured.append(dict(env))
        return SimpleNamespace(stdout="", stderr="", returncode=0)

    monkeypatch.setattr(launch.subprocess, "run", service_process)
    launch.service_action(action, tmp_path / "workspace")

    assert captured[-1]["LTCOOK_API_TOKEN"] == ""
    assert captured[-1]["SEARXNG_SECRET"] == ""
    assert not Path(shell["XDG_CONFIG_HOME"]).exists()


def test_bare_completion_dispatches_to_typer_without_starting_runtime(
    monkeypatch,
):
    import importlib

    app_module = importlib.import_module("ltcook.cli.app")
    calls = []
    monkeypatch.setenv("_LTCOOK_COMPLETE", "bash_source")
    monkeypatch.setattr(app_module.sys, "argv", ["ltcook"])
    monkeypatch.setattr(
        app_module, "app", lambda *args, **kwargs: calls.append((args, kwargs))
    )
    monkeypatch.setattr(
        app_module,
        "desktop_command",
        lambda: pytest.fail("completion must not start the desktop runtime"),
    )
    app_module.main()
    assert calls == [((), {})]


def test_inspection_and_authenticated_stop_do_not_initialize_secrets(monkeypatch):
    import importlib

    import typer

    app_module = importlib.import_module("ltcook.cli.app")
    monkeypatch.setattr(app_module, "_diagnose_payload", lambda: {"package": "ltcook"})
    monkeypatch.setattr(app_module.rc.cli, "dump_json", lambda _payload: None)
    monkeypatch.setattr(
        app_module, "resolve_launch", lambda *_args: SimpleNamespace(environment={})
    )
    monkeypatch.setattr(app_module, "stop_runtime", lambda _environment: 0)
    monkeypatch.setattr(
        launch,
        "ensure_service_secrets",
        lambda *_args: pytest.fail("read-only commands must not create secrets"),
    )

    app_module.diagnose_cmd(json_output=True)
    with pytest.raises(typer.Exit):
        app_module.stop_cmd()


def test_unavailable_or_incompatible_runtime_never_spawns_or_opens_browser(
    monkeypatch, capsys
):
    from ltcook._runtime_client import RuntimeClientError

    configuration = launch.LaunchConfig({"LTCOOK_TEAM": "default-minimal"}, None, None)
    monkeypatch.setattr(launch, "_shell_environment", lambda _environment: {})
    monkeypatch.setattr(launch, "ensure_service_secrets", lambda _environment: None)
    monkeypatch.setattr(
        launch, "resolve_launch", lambda *_args, **_kwargs: configuration
    )
    monkeypatch.setattr(
        launch,
        "probe_runtime",
        lambda _environment: (_ for _ in ()).throw(
            RuntimeClientError("The configured runtime token was rejected.")
        ),
    )
    monkeypatch.setattr(
        launch,
        "start_runtime",
        lambda *_args, **_kwargs: pytest.fail("incompatible owner must not spawn"),
    )
    assert launch.desktop_command() == 1
    assert "token was rejected" in capsys.readouterr().err


@pytest.mark.parametrize("transport", [ConnectionResetError, BrokenPipeError])
def test_pinned_owner_wait_handles_listener_close(monkeypatch, transport):
    from ltcook import _runtime_client as client

    def closing(_environment, **_kwargs):
        try:
            raise transport("listener closed during request")
        except OSError as error:
            raise client.RuntimeClientError("Could not read status") from error

    monkeypatch.setattr(client, "probe_runtime", closing)
    assert client._probe_pinned({}, "observed-instance") == "starting"


def test_timeout_on_unowned_port_allows_startup(monkeypatch, tmp_path):
    import socket

    from ltcook import _runtime_client as client

    with socket.socket() as unused:
        unused.bind(("127.0.0.1", 0))
        port = unused.getsockname()[1]
    environment = _runtime_environment(tmp_path)
    environment["LTCOOK_API_LISTEN"] = f"127.0.0.1:{port}"
    monkeypatch.setattr(
        client._HTTP,
        "open",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(TimeoutError()),
    )
    assert client.probe_runtime(environment) is None
