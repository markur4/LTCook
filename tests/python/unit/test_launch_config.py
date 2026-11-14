import errno
import json
import os
import subprocess
import urllib.error
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Event, Thread
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

    marker_file.write_text(
        f"LTCOOK_TEAM=project-team\nLTCOOK_PI_AUTH_DIR={tmp_path / 'project-auth'}\n",
        encoding="utf-8",
    )
    project_launch = launch.resolve_launch(project, original_environment=environment)

    assert project_launch.environment["LTCOOK_TEAM"] == "project-team"
    assert project_launch.environment["LTCOOK_PI_AUTH_DIR"] == str(
        global_auth.resolve()
    )
    assert not registry_file.exists()


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
        runtime=Section({}, pi_auth_dir="~/.pi/agent"),
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

    document = next(iter(documents.values()))
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
    assert set(documents) == {pi_home / "web-search.json"}
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


@pytest.mark.parametrize(
    ("returncode", "expected_owner_requests"),
    [(75, 2), (1, 1)],
)
def test_runtime_command_attaches_only_after_temporary_bind_exit(
    monkeypatch, tmp_path, returncode, expected_owner_requests
):
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    node = tmp_path / "deployment" / "node" / "bin" / "node"
    native = tmp_path / "source" / "runtime" / "dist" / "main.js"
    node.parent.mkdir(parents=True)
    native.parent.mkdir(parents=True)
    node.touch()
    native.touch()
    environment = {
        "LTCOOK_NODE_EXECUTABLE": str(node),
        "LTCOOK_JS_ROOT": str(native.parents[2]),
    }
    launch_config = launch.LaunchConfig(environment, None, workspace)
    monkeypatch.setattr(launch, "_shell_environment", lambda _environment: {})
    monkeypatch.setattr(
        launch, "resolve_launch", lambda _workspace, **_kwargs: launch_config
    )
    owner_responses = iter((False, True))
    owner_requests = []

    def open_owner(_launch, _shell):
        owner_requests.append(True)
        return next(owner_responses)

    child_calls = []

    def run(arguments, **kwargs):
        child_calls.append((arguments, kwargs))
        return SimpleNamespace(returncode=returncode)

    monkeypatch.setattr(launch, "_open_existing_runtime", open_owner)
    monkeypatch.setattr(subprocess, "run", run)

    if returncode == 75:
        launch.runtime_command(workspace)
    else:
        with pytest.raises(launch.typer.Exit) as error:
            launch.runtime_command(workspace)
        assert error.value.exit_code == returncode

    assert len(owner_requests) == expected_owner_requests
    assert child_calls[0][0] == [str(node), str(native)]
    assert child_calls[0][1]["cwd"] == workspace


def test_shell_provenance_cannot_be_nested_as_an_environment_value():
    provenance = json.dumps(
        {"SHELL_ONLY": "preserved", "LTCOOK_SHELL_PROVENANCE": "nested"}
    )

    assert launch._shell_environment({"LTCOOK_SHELL_PROVENANCE": provenance}) == {
        "SHELL_ONLY": "preserved"
    }


def test_idle_runtime_reuses_matching_team_without_opening_a_session(monkeypatch):
    environment = {
        "LTCOOK_TEAM": "default-minimal",
        "LTCOOK_API_TOKEN": "test-only-token",
    }
    configuration = launch.LaunchConfig(environment, None, None)
    monkeypatch.setattr(launch, "_shell_environment", lambda _environment: {})
    monkeypatch.setattr(
        launch, "resolve_launch", lambda _workspace, **_kwargs: configuration
    )
    monkeypatch.setattr(
        launch, "_existing_runtime_team", lambda _launch: "default-minimal"
    )
    monkeypatch.setattr(
        launch,
        "_open_existing_runtime",
        lambda *_args: pytest.fail("idle launch must not open a project session"),
    )
    monkeypatch.setattr(
        subprocess,
        "run",
        lambda *_args, **_kwargs: pytest.fail(
            "idle launch must not start another runtime"
        ),
    )

    assert launch.runtime_command(None) is None


def test_idle_runtime_status_reads_team_from_authenticated_status_route(
    monkeypatch,
):
    class Response:
        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return None

        def read(self):
            return b'{"teamSelection":"default-minimal"}'

    response = Response()
    request_seen = []

    def open_status(request, *, timeout):
        request_seen.append((request, timeout))
        return response

    monkeypatch.setattr(launch.urllib.request, "urlopen", open_status)
    result = launch._existing_runtime_team(
        launch.LaunchConfig(
            {
                "LTCOOK_API_LISTEN": "127.0.0.1:48731",
                "LTCOOK_API_TOKEN": "test-only-token",
            },
            None,
            None,
        )
    )

    assert result == "default-minimal"
    request, timeout = request_seen[0]
    assert timeout == launch.RUNTIME_STATUS_PROBE_TIMEOUT_SECONDS
    assert request.full_url.endswith("/v1/status")
    assert request.get_method() == "GET"
    assert request.get_header("Authorization") == "Bearer test-only-token"


@pytest.mark.parametrize(
    "error",
    (
        TimeoutError(),
        urllib.error.URLError(TimeoutError()),
        urllib.error.URLError(OSError(errno.ETIMEDOUT, "timed out")),
    ),
)
def test_idle_runtime_status_treats_transport_timeouts_as_not_ready(monkeypatch, error):
    def timeout_status(_request, *, timeout):
        raise error

    monkeypatch.setattr(launch.urllib.request, "urlopen", timeout_status)
    result = launch._existing_runtime_team(
        launch.LaunchConfig(
            {
                "LTCOOK_API_LISTEN": "127.0.0.1:48731",
                "LTCOOK_API_TOKEN": "test-only-token",
            },
            None,
            None,
        )
    )

    assert result is None


def test_workspace_attach_bounds_stalled_status_before_posting(monkeypatch):
    request_started = Event()
    release_response = Event()
    requests_seen = []
    response_body = b'{"teamSelection":"default-minimal"}'

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            requests_seen.append((self.command, self.path))
            request_started.set()
            release_response.wait()
            try:
                self.send_response(200)
                self.send_header("Content-Length", str(len(response_body)))
                self.end_headers()
                self.wfile.write(response_body)
            except OSError:
                pass

        def do_POST(self):
            requests_seen.append((self.command, self.path))
            self.send_response(200)
            self.send_header("Content-Length", "0")
            self.end_headers()

        def log_message(self, *_args):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    server_thread = Thread(target=server.serve_forever, daemon=True)
    server_thread.start()
    monkeypatch.delenv("HTTP_PROXY", raising=False)
    monkeypatch.delenv("HTTPS_PROXY", raising=False)
    monkeypatch.delenv("ALL_PROXY", raising=False)
    monkeypatch.delenv("http_proxy", raising=False)
    monkeypatch.delenv("https_proxy", raising=False)
    monkeypatch.delenv("all_proxy", raising=False)
    configuration = launch.LaunchConfig(
        {
            "LTCOOK_TEAM": "default-minimal",
            "LTCOOK_SESSION": "test-session",
            "LTCOOK_API_LISTEN": f"127.0.0.1:{server.server_port}",
            "LTCOOK_API_TOKEN": "test-only-token",
        },
        None,
        Path.cwd(),
    )
    try:
        with ThreadPoolExecutor(max_workers=1) as executor:
            probe = executor.submit(launch._open_existing_runtime, configuration, {})
            try:
                assert request_started.wait(timeout=3)
                assert probe.result(timeout=3) is False
            finally:
                release_response.set()
    finally:
        server.shutdown()
        server_thread.join(timeout=3)
        server.server_close()
    assert requests_seen == [("GET", "/v1/status")]
    assert not server_thread.is_alive()


def test_global_runtime_reuses_owner_that_wins_listen_race(monkeypatch, tmp_path):
    node = tmp_path / "node"
    native = tmp_path / "runtime" / "dist" / "main.js"
    node.touch()
    native.parent.mkdir(parents=True)
    native.touch()
    environment = {
        "LTCOOK_TEAM": "default-minimal",
        "LTCOOK_API_TOKEN": "test-only-token",
        "LTCOOK_NODE_EXECUTABLE": str(node),
        "LTCOOK_JS_ROOT": str(native.parents[2]),
    }
    configuration = launch.LaunchConfig(environment, None, None)
    monkeypatch.setattr(launch, "_shell_environment", lambda _environment: {})
    monkeypatch.setattr(
        launch, "resolve_launch", lambda _workspace, **_kwargs: configuration
    )
    status_results = iter((None, "default-minimal"))
    status_calls = []

    def existing_team(_launch):
        status_calls.append(True)
        return next(status_results)

    monkeypatch.setattr(launch, "_existing_runtime_team", existing_team)
    monkeypatch.setattr(
        launch,
        "_open_existing_runtime",
        lambda *_args: pytest.fail("global launch must not open a project session"),
    )
    child_calls = []

    def run(arguments, **kwargs):
        child_calls.append((arguments, kwargs))
        return SimpleNamespace(returncode=75)

    monkeypatch.setattr(subprocess, "run", run)

    assert launch.runtime_command(None) is None
    assert len(status_calls) == 2
    assert child_calls[0][1]["cwd"] is None
