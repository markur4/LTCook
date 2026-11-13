import json
import os
import subprocess
from pathlib import Path
from types import SimpleNamespace

import pytest

from ltcook import launch
from ltcook.config.pi_config import pi_documents, write_pi_config


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
            {"LTCOOK_MODEL_SMOL": "workspace-model", "LTCOOK_TEAM": "workspace-team"}
        ),
        web=Section({"LTCOOK_CRAWL4AI_URL": ""}),
    )

    class Resolved:
        paths = SimpleNamespace(require=lambda _kind: tmp_path / "appdata")

        def build(self, bundle):
            return config

    def resolve_config(workspace_root, *, environment):
        seen["workspace"] = Path(workspace_root)
        seen["environment"] = environment
        return Resolved()

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
        runtime=Section({}),
        web=Section({}),
    )

    class Resolved:
        paths = SimpleNamespace(require=lambda _kind: tmp_path / "appdata")

        def build(self, bundle):
            return config

    monkeypatch.setattr(
        launch, "resolve_config", lambda workspace, *, environment: Resolved()
    )
    result = launch.resolve_launch(tmp_path, original_environment={})

    assert result.environment["LTCOOK_JS_ROOT"] == str(
        tmp_path / "appdata" / "deployment" / "app"
    )
    assert result.environment["PASEO_HOME"] == str(
        tmp_path / "appdata" / "deployment" / "paseo"
    )
    assert Path(result.environment["PASEO_HOME"]).is_relative_to(
        tmp_path / "appdata" / "deployment"
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
