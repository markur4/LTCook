"""Per-workspace AppRC resolution for child process launches."""

from __future__ import annotations

import errno
import hashlib
import json
import os
import sys
import time
import urllib.error
import urllib.request
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Annotated
from uuid import uuid4

import typer

from ltcook.config.bundle import LtcookConfig
from ltcook.config.pi_config import resolve_config, write_pi_config

services_cli = typer.Typer(no_args_is_help=True)
launch_cli = typer.Typer(no_args_is_help=True)


@dataclass(frozen=True)
class LaunchConfig:
    """Invocation-local configuration and child environment."""

    environment: dict[str, str]
    configuration: LtcookConfig
    workspace_root: Path


def _shell_environment(environment: Mapping[str, str]) -> dict[str, str]:
    provenance = environment.get("LTCOOK_SHELL_PROVENANCE")
    if provenance:
        original = json.loads(provenance)
        if not isinstance(original, dict) or not all(
            isinstance(k, str) and isinstance(v, str) for k, v in original.items()
        ):
            raise ValueError("LTCOOK_SHELL_PROVENANCE is not an environment mapping")
        return {
            key: value
            for key, value in original.items()
            if key != "LTCOOK_SHELL_PROVENANCE"
        }
    return {
        key: value
        for key, value in environment.items()
        if key != "LTCOOK_SHELL_PROVENANCE"
    }


def resolve_launch(
    workspace_root: str | Path, *, original_environment: Mapping[str, str] | None = None
) -> LaunchConfig:
    """Resolve settings from the target workspace and original shell inputs.

    :param workspace_root: Workspace being launched.
    :param original_environment: Captured shell variables before AppRC overlays.
    :return: Workspace-specific settings and environment for the child process.
    """
    shell = _shell_environment(
        dict(os.environ if original_environment is None else original_environment)
    )
    resolved = resolve_config(workspace_root, environment=shell)
    config = resolved.build(LtcookConfig)
    environment = dict(shell)
    for section in config.__dict__.values():
        environment.update(
            section.current_env_mapping(prefixed=True, include_empty=True)
        )
    appdata_dir = resolved.paths.require("appdata")
    deployment = (
        Path(config.app.deployment).expanduser()
        if config.app.deployment
        else appdata_dir / "deployment"
    )
    workspace_id = hashlib.sha256(
        str(Path(workspace_root).resolve()).encode()
    ).hexdigest()[:24]
    if not environment.get("LTCOOK_SESSION"):
        environment["LTCOOK_SESSION"] = f"session-{uuid4()}"
    if not environment.get("LTCOOK_DEPLOYMENT_DIR"):
        environment["LTCOOK_DEPLOYMENT_DIR"] = str(deployment)
    if not environment.get("LTCOOK_PYTHON"):
        environment["LTCOOK_PYTHON"] = sys.executable
    if not environment.get("LTCOOK_JS_ROOT"):
        environment["LTCOOK_JS_ROOT"] = str(deployment / "app")
    if not environment.get("LTCOOK_NODE_EXECUTABLE"):
        environment["LTCOOK_NODE_EXECUTABLE"] = str(
            deployment / "node" / ("node.exe" if os.name == "nt" else "bin/node")
        )
    if not environment.get("PI_CODING_AGENT_DIR"):
        environment["PI_CODING_AGENT_DIR"] = str(
            deployment / "workspaces" / workspace_id / "pi"
        )
    if not environment.get("LTCOOK_COMPOSE_FILE"):
        environment["LTCOOK_COMPOSE_FILE"] = str(
            deployment / "app" / "services" / "compose.yaml"
        )
    if not environment.get("LTCOOK_SERVICE_CONFIG_DIR"):
        environment["LTCOOK_SERVICE_CONFIG_DIR"] = str(deployment / "service-config")
    if not environment.get("PLAYWRIGHT_BROWSERS_PATH"):
        environment["PLAYWRIGHT_BROWSERS_PATH"] = str(deployment / "browser-home")
    environment["LTCOOK_WORKSPACE"] = str(Path(workspace_root).resolve())
    if not environment.get("LTCOOK_DATABASE"):
        environment["LTCOOK_DATABASE"] = str(deployment / "coordination.sqlite")
    if not environment.get("LTCOOK_BROWSER_HOME"):
        environment["LTCOOK_BROWSER_HOME"] = str(deployment / "browser-home")
    if not environment.get("PASEO_HOME"):
        environment["PASEO_HOME"] = str(deployment / "paseo")
    if not environment.get("LTCOOK_LOGS"):
        environment["LTCOOK_LOGS"] = str(deployment / "logs" / "runtime.jsonl")
    if not environment.get("LTCOOK_TRACES"):
        environment["LTCOOK_TRACES"] = str(deployment / "traces" / "runtime.json")
    js_root = Path(environment["LTCOOK_JS_ROOT"])
    path_components = [
        str(Path(environment["LTCOOK_NODE_EXECUTABLE"]).parent),
        str(js_root / "node_modules" / ".bin"),
    ]
    path_components.extend(
        value for value in environment.get("PATH", "").split(os.pathsep) if value
    )
    environment["PATH"] = os.pathsep.join(dict.fromkeys(path_components))
    return LaunchConfig(environment, config, Path(workspace_root).resolve())


@launch_cli.command("environment")
def environment_command(
    workspace: Annotated[Path, typer.Option("--workspace")],
) -> None:
    """Emit a workspace-specific native component environment as JSON."""
    launch = resolve_launch(workspace, original_environment=os.environ)
    typer.echo(
        json.dumps(
            {
                "workspaceRoot": str(launch.workspace_root),
                "environment": launch.environment,
            }
        )
    )


def _runtime_api_url(address: str) -> str:
    """Validate a local TCP address and return its HTTP base URL.

    :param address: Host and port from `LTCOOK_API_LISTEN`.
    :return: HTTP URL for the local runtime API.
    """
    if address.startswith("["):
        separator = address.find("]")
        host = address[1:separator]
        port = address[separator + 2 :] if separator >= 0 else ""
    else:
        host, separator, port = address.rpartition(":")
        if not separator:
            raise ValueError("LTCOOK_API_LISTEN requires a loopback host and port")
    if (
        host not in {"127.0.0.1", "::1"}
        or not port.isdigit()
        or not 1 <= int(port) <= 65535
    ):
        raise ValueError(
            "LTCOOK_API_LISTEN must be a local loopback address with a valid port"
        )
    return f"http://[{host}]:{port}" if ":" in host else f"http://{host}:{port}"


def _open_existing_runtime(
    launch: LaunchConfig, shell_environment: Mapping[str, str]
) -> bool:
    """Ask an authenticated owner to open this workspace in its one runtime.

    :param launch: Workspace-specific AppRC settings and paths.
    :param shell_environment: Original shell values for target-workspace resolution.
    :return: Whether an existing runtime accepted the workspace session.
    """
    environment = launch.environment
    token = environment.get("LTCOOK_API_TOKEN", "")
    if not token:
        raise typer.BadParameter(
            "LTCOOK_API_TOKEN is missing; run the LTCook installer to initialize "
            "service credentials, or set LTCOOK_API_TOKEN through AppRC."
        )
    endpoint = _runtime_api_url(environment["LTCOOK_API_LISTEN"])
    request_body = json.dumps(
        {
            "workspaceRoot": str(launch.workspace_root),
            "sessionId": environment["LTCOOK_SESSION"],
            "teamSelection": environment["LTCOOK_TEAM"],
            "shellEnvironment": dict(shell_environment),
        }
    ).encode("utf-8")
    request = urllib.request.Request(
        f"{endpoint}/v1/session/open",
        data=request_body,
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    deadline = time.monotonic() + 60
    while True:
        try:
            with urllib.request.urlopen(request) as response:
                if response.status != 200:
                    raise typer.BadParameter(
                        f"Running LTCook runtime returned HTTP {response.status}."
                    )
                return True
        except urllib.error.HTTPError as error:
            if error.code == 503 and time.monotonic() < deadline:
                time.sleep(0.2)
                continue
            detail = ""
            try:
                detail = json.loads(error.read().decode("utf-8")).get("error", "")
            except (UnicodeDecodeError, json.JSONDecodeError, AttributeError):
                pass
            raise typer.BadParameter(
                detail
                or f"Running LTCook runtime rejected the workspace (HTTP {error.code})."
            ) from error
        except urllib.error.URLError as error:
            reason = error.reason
            if isinstance(reason, OSError) and reason.errno == errno.ECONNREFUSED:
                return False
            raise typer.BadParameter(
                "Could not contact the local LTCook runtime API."
            ) from error


@launch_cli.command("runtime")
def runtime_command(workspace: Annotated[Path, typer.Option("--workspace")]) -> None:
    """Open a new chat, or resume the explicitly selected Session, in one runtime.

    :param workspace: Workspace root selected by the CLI caller.
    :return: None.
    """
    shell = _shell_environment(os.environ)
    launch = resolve_launch(workspace, original_environment=shell)
    if _open_existing_runtime(launch, shell):
        typer.echo(f"Opened workspace session for {launch.workspace_root}")
        return
    native = Path(launch.environment["LTCOOK_JS_ROOT"]) / "runtime" / "dist" / "main.js"
    node = launch.environment["LTCOOK_NODE_EXECUTABLE"]
    if not Path(node).is_file() or not native.is_file():
        raise typer.BadParameter(
            "Runtime prerequisites are not prepared; re-run the LTCook installer to prepare prerequisites."
        )
    import subprocess

    env = dict(launch.environment)
    env["LTCOOK_SHELL_PROVENANCE"] = json.dumps(shell, separators=(",", ":"))
    completed = subprocess.run(
        [node, str(native)],
        cwd=launch.workspace_root,
        env=env,
        check=False,
    )
    if completed.returncode == 75 and _open_existing_runtime(launch, shell):
        typer.echo(f"Opened workspace session for {launch.workspace_root}")
        return
    raise typer.Exit(completed.returncode)


def service_action(action: str, workspace: Path) -> None:
    """Run a native service-controller action with the selected workspace's AppRC.

    :param action: Service action supported by the native controller.
    :param workspace: Workspace used to resolve service settings.
    :return: None.
    """
    shell = _shell_environment(os.environ)
    launch = resolve_launch(workspace, original_environment=shell)
    native = Path(launch.environment["LTCOOK_JS_ROOT"]) / "runtime" / "dist" / "main.js"
    node = launch.environment["LTCOOK_NODE_EXECUTABLE"]
    if not Path(node).is_file() or not native.is_file():
        raise typer.BadParameter(
            "Runtime prerequisites are not prepared; re-run the LTCook installer to prepare prerequisites."
        )
    import subprocess

    completed = subprocess.run(
        [node, str(native), "service-action", action],
        cwd=launch.workspace_root,
        env=launch.environment,
        capture_output=True,
        text=True,
        check=False,
    )
    if completed.stdout:
        typer.echo(completed.stdout.rstrip())
    if completed.stderr:
        sys.stderr.write(completed.stderr)
    if completed.returncode:
        raise typer.Exit(completed.returncode)


@services_cli.command("start")
def services_start(
    workspace: Annotated[Path, typer.Option("--workspace")] = Path("."),
) -> None:
    """Start locally managed search and browser services.

    :param workspace: Workspace used to resolve service configuration.
    :return: None.
    """
    service_action("start", workspace)


@services_cli.command("stop")
def services_stop(
    workspace: Annotated[Path, typer.Option("--workspace")] = Path("."),
) -> None:
    """Stop locally managed search and browser services.

    :param workspace: Workspace used to resolve service configuration.
    :return: None.
    """
    service_action("stop", workspace)


@services_cli.command("status")
def services_status(
    workspace: Annotated[Path, typer.Option("--workspace")] = Path("."),
) -> None:
    """Show local service status or the configured remote-service mode.

    :param workspace: Workspace used to resolve service configuration.
    :return: None.
    """
    service_action("status", workspace)


@services_cli.command("logs")
def services_logs(
    workspace: Annotated[Path, typer.Option("--workspace")] = Path("."),
) -> None:
    """Show recent locally managed service logs.

    :param workspace: Workspace used to resolve service configuration.
    :return: None.
    """
    service_action("logs", workspace)


@launch_cli.command("write-native-config")
def write_native_command(
    workspace: Annotated[Path, typer.Option("--workspace")],
) -> None:
    """Generate the Pi web-access JSON in the AppRC-owned deployment."""
    launch = resolve_launch(workspace, original_environment=os.environ)
    try:
        paths = write_pi_config(
            launch.configuration,
            owned_dir=Path(launch.environment["LTCOOK_DEPLOYMENT_DIR"]) / "app",
            pi_home=launch.environment["PI_CODING_AGENT_DIR"],
        )
    except ValueError as error:
        raise typer.BadParameter(str(error)) from error
    typer.echo(json.dumps([str(path) for path in paths]))


def main(argv: Sequence[str] | None = None) -> None:
    """Run launch-specific commands for Python module callers."""
    launch_cli(args=list(argv if argv is not None else sys.argv[1:]))


if __name__ == "__main__":
    main()
