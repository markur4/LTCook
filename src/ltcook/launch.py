"""Global and per-workspace AppRC resolution for native launches."""

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
from ltcook.config.pi_config import (
    resolve_config,
    resolve_global_config,
    write_pi_config,
)

services_cli = typer.Typer(no_args_is_help=True)
launch_cli = typer.Typer(no_args_is_help=True)

RUNTIME_STATUS_PROBE_TIMEOUT_SECONDS = 1


@dataclass(frozen=True)
class LaunchConfig:
    """Invocation-local configuration and child environment."""

    environment: dict[str, str]
    configuration: LtcookConfig
    workspace_root: Path | None


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
    workspace_root: str | Path | None = None,
    *,
    original_environment: Mapping[str, str] | None = None,
) -> LaunchConfig:
    """Resolve global runtime settings and optional project overlays.

    :param workspace_root: Explicit project directory, or None for global startup.
    :param original_environment: Captured shell variables before AppRC overlays.
    :return: Settings and child environment for this invocation.
    """
    shell = _shell_environment(
        dict(os.environ if original_environment is None else original_environment)
    )
    resolved = resolve_config(workspace_root, environment=shell)
    config = resolved.build(LtcookConfig)
    # > Shared provider authentication is user state.
    # > Resolve it globally, never from project overlays.
    global_config = (
        config
        if resolved.workspace is None
        else resolve_global_config(environment=shell).build(LtcookConfig)
    )
    environment = dict(shell)
    for section in config.__dict__.values():
        environment.update(
            section.current_env_mapping(prefixed=True, include_empty=True)
        )
    # > Even an empty CONTAINER_CONNECTION switches Podman into remote mode.
    if not environment.get("CONTAINER_CONNECTION"):
        environment.pop("CONTAINER_CONNECTION", None)
    home = Path(
        shell.get("HOME") or shell.get("USERPROFILE") or str(Path.home())
    ).expanduser()
    auth_dir = global_config.runtime.pi_auth_dir
    auth_path = (
        home / auth_dir[2:].lstrip("/\\")
        if auth_dir == "~" or auth_dir.startswith(("~/", "~\\"))
        else Path(auth_dir).expanduser()
    )
    environment["LTCOOK_PI_AUTH_DIR"] = str(auth_path.resolve())
    appdata_dir = resolved.paths.require("appdata")
    deployment = (
        Path(config.app.deployment).expanduser()
        if config.app.deployment
        else appdata_dir / "deployment"
    )
    if workspace_root is not None and not environment.get("LTCOOK_SESSION"):
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
        if workspace_root is None:
            pi_home = deployment / "pi"
        else:
            workspace_id = hashlib.sha256(
                str(Path(workspace_root).expanduser().resolve()).encode()
            ).hexdigest()[:24]
            pi_home = deployment / "workspaces" / workspace_id / "pi"
        environment["PI_CODING_AGENT_DIR"] = str(pi_home)
    if not environment.get("LTCOOK_COMPOSE_FILE"):
        environment["LTCOOK_COMPOSE_FILE"] = str(
            deployment / "app" / "services" / "compose.yaml"
        )
    if not environment.get("LTCOOK_SERVICE_CONFIG_DIR"):
        environment["LTCOOK_SERVICE_CONFIG_DIR"] = str(deployment / "service-config")
    if not environment.get("PLAYWRIGHT_BROWSERS_PATH"):
        environment["PLAYWRIGHT_BROWSERS_PATH"] = str(deployment / "browser-home")
    if workspace_root is not None:
        environment["LTCOOK_WORKSPACE"] = str(
            Path(workspace_root).expanduser().resolve()
        )
    else:
        environment.pop("LTCOOK_WORKSPACE", None)
        environment.pop("LTCOOK_SESSION", None)
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
    root = (
        Path(workspace_root).expanduser().resolve()
        if workspace_root is not None
        else None
    )
    return LaunchConfig(environment, config, root)


@launch_cli.command("environment")
def environment_command(
    workspace: Annotated[Path, typer.Option("--workspace")],
) -> None:
    """Emit a workspace-specific native component environment as JSON."""
    launch = resolve_launch(workspace, original_environment=os.environ)
    assert launch.workspace_root is not None
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
    workspace_root = launch.workspace_root
    if workspace_root is None:
        raise ValueError("Opening a session requires an explicit workspace.")
    environment = launch.environment
    token = environment.get("LTCOOK_API_TOKEN", "")
    if not token:
        raise typer.BadParameter(
            "LTCOOK_API_TOKEN is missing; run the LTCook installer to initialize "
            "service credentials, or set LTCOOK_API_TOKEN through AppRC."
        )
    # > Bound owner discovery, but leave session initialization
    # > on its normal deadline.
    if _existing_runtime_team(launch) is None:
        return False
    endpoint = _runtime_api_url(environment["LTCOOK_API_LISTEN"])
    request_body = json.dumps(
        {
            "workspaceRoot": str(workspace_root),
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


def _existing_runtime_team(launch: LaunchConfig) -> str | None:
    """Read a running server's configured team without opening a session.

    :param launch: Global configuration and managed server environment.
    :return: Active team selection, or None if no ready server is listening.
    """
    environment = launch.environment
    token = environment.get("LTCOOK_API_TOKEN", "")
    if not token:
        return None
    request = urllib.request.Request(
        f"{_runtime_api_url(environment['LTCOOK_API_LISTEN'])}/v1/status",
        headers={"Authorization": f"Bearer {token}"},
        method="GET",
    )
    try:
        with urllib.request.urlopen(
            request, timeout=RUNTIME_STATUS_PROBE_TIMEOUT_SECONDS
        ) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        if error.code == 503:
            return None
        if error.code == 401:
            raise typer.BadParameter(
                "The configured runtime token was rejected by the running runtime."
            ) from error
        raise typer.BadParameter(
            f"Running LTCook runtime returned HTTP {error.code} for status."
        ) from error
    except TimeoutError:
        return None
    except urllib.error.URLError as error:
        reason = error.reason
        if isinstance(reason, TimeoutError) or (
            isinstance(reason, OSError)
            and reason.errno in {errno.ECONNREFUSED, errno.ETIMEDOUT}
        ):
            return None
        raise typer.BadParameter(
            "Could not contact the local LTCook runtime API."
        ) from error
    team = payload.get("teamSelection") if isinstance(payload, dict) else None
    if not isinstance(team, str):
        raise typer.BadParameter("Running LTCook runtime returned invalid status data.")
    return team


def _reuse_matching_runtime(launch: LaunchConfig) -> bool:
    """Reuse a ready global runtime only when its team matches this invocation."""
    active_team = _existing_runtime_team(launch)
    if active_team is None:
        return False
    if active_team != launch.environment["LTCOOK_TEAM"]:
        raise typer.BadParameter(
            "A runtime is already active with a different team selection."
        )
    typer.echo(f"Reusing LTCook runtime for team {active_team}.")
    return True


@launch_cli.command("runtime")
def runtime_command(
    workspace: Annotated[Path | None, typer.Option("--workspace")] = None,
) -> None:
    """Start the global runtime or explicitly open a project session.

    :param workspace: Optional project directory to open when starting.
    :return: None.
    """
    shell = _shell_environment(os.environ)
    launch = resolve_launch(workspace, original_environment=shell)
    if workspace is None:
        if _reuse_matching_runtime(launch):
            return
    elif _open_existing_runtime(launch, shell):
        assert launch.workspace_root is not None
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
    if completed.returncode == 75:
        if workspace is not None and _open_existing_runtime(launch, shell):
            assert launch.workspace_root is not None
            typer.echo(f"Opened workspace session for {launch.workspace_root}")
            return
        if workspace is None and _reuse_matching_runtime(launch):
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
    assert launch.workspace_root is not None
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
