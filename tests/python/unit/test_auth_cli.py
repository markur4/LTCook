import json
import os
import shutil
import signal
import subprocess
import sys
from pathlib import Path

import pytest

REPOSITORY_ROOT = Path(__file__).resolve().parents[3]
CLI_SCRIPT = "from ltcook.cli.app import main; main()"


def _native_cli_environment(
    tmp_path: Path,
    *,
    exit_code: int = 0,
    wait_for_signal: bool = False,
) -> dict[str, str]:
    node = tmp_path / "node"
    node.write_text(
        f"#!{sys.executable}\n"
        "import os\n"
        "import signal\n"
        "assert os.environ['PI_CODING_AGENT_DIR'] == os.environ['LTCOOK_PI_AUTH_DIR']\n"
        "print('native-auth-ready', flush=True)\n"
        + (
            "signal.pause()\n"
            if wait_for_signal
            else f"raise SystemExit({exit_code})\n"
        ),
        encoding="utf-8",
    )
    node.chmod(node.stat().st_mode | 0o100)
    cli = (
        tmp_path
        / "app"
        / "node_modules"
        / "@earendil-works"
        / "pi-coding-agent"
        / "dist"
        / "bundle"
        / "cli.js"
    )
    cli.parent.mkdir(parents=True)
    cli.touch()
    auth_dir = tmp_path / "shared-pi-home"
    auth_dir.mkdir()

    environment = os.environ.copy()
    for key in tuple(environment):
        if key.startswith(
            (
                "LTCOOK_",
                "PI_",
                "ANTHROPIC_",
                "OPENAI_",
                "GEMINI_",
                "OPENROUTER_",
                "PASEO_",
                "AWS_",
                "GOOGLE_",
                "AZURE_",
                "CLOUDFLARE_",
                "COHERE_",
                "MISTRAL_",
                "DEEPSEEK_",
                "GROQ_",
                "XAI_",
            )
        ):
            environment.pop(key)
    home = tmp_path / "home"
    environment.update(
        {
            "HOME": str(home),
            "USERPROFILE": str(home),
            "XDG_CONFIG_HOME": str(tmp_path / "config"),
            "XDG_DATA_HOME": str(tmp_path / "data"),
            "XDG_CACHE_HOME": str(tmp_path / "cache"),
            "XDG_STATE_HOME": str(tmp_path / "state"),
            "PYTHONPATH": str(REPOSITORY_ROOT / "src"),
            "LTCOOK_WORKSPACE": "stale-selected-workspace",
            "LTCOOK_NODE_EXECUTABLE": str(node),
            "LTCOOK_JS_ROOT": str(tmp_path / "app"),
            "LTCOOK_PI_AUTH_DIR": str(auth_dir),
        }
    )
    return environment


def _command(arguments: list[str]) -> list[str]:
    return [sys.executable, "-c", CLI_SCRIPT, *arguments]


def _run_cli(
    arguments: list[str],
    environment: dict[str, str],
    *,
    cwd: Path = REPOSITORY_ROOT,
):
    return subprocess.run(
        _command(arguments),
        cwd=cwd,
        env=environment,
        capture_output=True,
        text=True,
        check=False,
    )


def test_auth_check_and_logout_use_shared_native_auth_file(tmp_path):
    node = os.environ.get("LTCOOK_NODE_EXECUTABLE") or shutil.which("node")
    if node is None or not Path(node).is_file():
        pytest.skip("A managed or system Node executable is required for Pi auth.")
    pi_cli = (
        REPOSITORY_ROOT
        / "node_modules"
        / "@earendil-works"
        / "pi-coding-agent"
        / "dist"
        / "bundle"
        / "cli.js"
    )
    if not pi_cli.is_file():
        pytest.skip("The repository's installed Pi CLI bundle is unavailable.")

    project = tmp_path / "project"
    project.mkdir()
    environment = _native_cli_environment(tmp_path)
    environment["LTCOOK_NODE_EXECUTABLE"] = str(node)
    environment["LTCOOK_JS_ROOT"] = str(REPOSITORY_ROOT)
    auth_file = Path(environment["LTCOOK_PI_AUTH_DIR"]) / "auth.json"

    missing = _run_cli(
        ["auth", "check", "--provider", "anthropic", "--json", "--no-refresh"],
        environment,
        cwd=project,
    )
    assert missing.returncode == 1
    assert not Path(environment["XDG_CONFIG_HOME"]).exists()
    assert not auth_file.exists()

    fixture_key = "ltcook-test-only-dummy-key"
    auth_file.write_text(
        json.dumps(
            {"anthropic": {"type": "api_key", "key": fixture_key}},
            indent=2,
        ),
        encoding="utf-8",
    )
    ready = _run_cli(
        ["auth", "check", "--provider", "anthropic", "--json", "--no-refresh"],
        environment,
        cwd=project,
    )
    assert ready.returncode == 0
    assert not Path(environment["XDG_CONFIG_HOME"]).exists()
    assert fixture_key not in ready.stdout
    assert fixture_key not in ready.stderr

    logout = _run_cli(["auth", "logout", "anthropic"], environment, cwd=project)
    assert logout.returncode == 0
    missing_again = _run_cli(
        ["auth", "check", "--provider", "anthropic", "--json", "--no-refresh"],
        environment,
        cwd=project,
    )
    assert missing_again.returncode == 1
    assert not (project / ".pi" / "agent" / "auth.json").exists()


def test_auth_login_preserves_native_exit_status(tmp_path):
    environment = _native_cli_environment(tmp_path, exit_code=23)

    result = _run_cli(["auth", "login", "anthropic", "--api-key"], environment)

    assert result.returncode == 23


@pytest.mark.skipif(os.name == "nt", reason="Fixture uses a POSIX executable")
def test_openai_auth_commands_use_the_shared_codex_login(tmp_path):
    environment = _native_cli_environment(tmp_path)
    codex = tmp_path / "codex"
    codex.write_text(
        f"#!{sys.executable}\n"
        "import os, sys\n"
        "assert 'OPENAI_API_KEY' not in os.environ\n"
        "args = sys.argv[1:]\n"
        "if args == ['login', 'status']:\n"
        "    print('Logged in using ChatGPT, fixture-output')\n"
        "else:\n"
        "    print(' '.join(args))\n",
        encoding="utf-8",
    )
    codex.chmod(codex.stat().st_mode | 0o100)
    environment["PATH"] = os.pathsep.join((str(tmp_path), environment["PATH"]))
    environment["OPENAI_API_KEY"] = "obsolete-fixture-key"

    ready = _run_cli(
        ["auth", "check", "--provider", "openai-codex", "--json"], environment
    )
    assert ready.returncode == 0
    assert json.loads(ready.stdout) == {
        "status": "ready",
        "provider": "openai-codex",
        "authType": "oauth",
    }
    assert (
        _run_cli(["auth", "check", "--provider", "openai"], environment).returncode == 1
    )
    login = _run_cli(["auth", "login", "openai-codex", "--no-browser"], environment)
    assert login.returncode == 0
    assert login.stdout.strip() == "login --device-auth"
    logout = _run_cli(["auth", "logout", "openai-codex"], environment)
    assert logout.returncode == 0
    assert logout.stdout.strip() == "logout"
    assert not (Path(environment["LTCOOK_PI_AUTH_DIR"]) / "auth.json").exists()


def test_auth_rejects_credential_printing_option(tmp_path):
    environment = _native_cli_environment(tmp_path)

    result = _run_cli(["auth", "check", "--credentials"], environment)

    assert result.returncode == 2
    assert not (tmp_path / "shared-pi-home" / "auth.json").exists()


def test_auth_rejects_conflicting_login_options(tmp_path):
    environment = _native_cli_environment(tmp_path)

    result = _run_cli(
        ["auth", "login", "openai", "--api-key", "--no-browser"], environment
    )

    assert result.returncode == 2
    assert not (tmp_path / "shared-pi-home" / "auth.json").exists()


@pytest.mark.skipif(os.name == "nt", reason="Signal semantics are POSIX-specific")
def test_auth_process_replacement_preserves_native_signal_exit(tmp_path):
    environment = _native_cli_environment(tmp_path, wait_for_signal=True)
    process = subprocess.Popen(
        _command(["auth", "check", "--no-refresh"]),
        cwd=REPOSITORY_ROOT,
        env=environment,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        start_new_session=True,
    )
    try:
        assert process.stdout is not None
        assert process.stdout.readline() == "native-auth-ready\n"
        process.send_signal(signal.SIGTERM)
        assert process.wait(timeout=5) == -signal.SIGTERM
    finally:
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        if process.poll() is None:
            process.wait()
