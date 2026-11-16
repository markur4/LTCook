"""Global and per-workspace AppRC resolution for native launches."""

from __future__ import annotations

import errno
import hashlib
import json
import os
import subprocess
import sys
import time
import urllib.error
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Annotated
from uuid import uuid4

import typer

from ltcook._runtime_client import (
    RuntimeClientError,
    RuntimeStatus,
    follow_runtime_logs,
    open_runtime_request,
    probe_runtime,
    start_runtime,
    wait_for_runtime,
)
from ltcook.config.bundle import LtcookConfig
from ltcook.config.pi_config import (
    resolve_config,
    resolve_global_config,
    write_pi_config,
)
from ltcook_distr.payload.app_lifecycle.actions import ensure_service_secrets

services_cli = typer.Typer(no_args_is_help=True)
launch_cli = typer.Typer(no_args_is_help=True)


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


def _user_path(value: str, home: Path) -> Path:
    """Expand a global path against the initiating user's home."""
    path = (
        home / value[2:].lstrip("/\\")
        if value == "~" or value.startswith(("~/", "~\\"))
        else Path(value).expanduser()
    )
    return path.resolve()


def resolve_launch(
    workspace_root: str | Path | None = None,
    *,
    original_environment: Mapping[str, str] | None = None,
    input_paths: set[Path] | None = None,
) -> LaunchConfig:
    """Resolve global runtime settings and optional project overlays.

    :param workspace_root: Explicit project directory, or None for global startup.
    :param original_environment: Captured shell variables before AppRC overlays.
    :param input_paths: Optional set receiving configuration paths used for reuse.
    :return: Settings and child environment for this invocation.
    """
    shell = _shell_environment(
        dict(os.environ if original_environment is None else original_environment)
    )
    resolved = resolve_config(workspace_root, environment=shell)
    config = resolved.build(LtcookConfig)
    # > Shared credentials and runtime/guidance roots are user state. Resolve
    # > them before native agents change HOME, without project overlays.
    global_resolved = (
        resolved
        if resolved.workspace is None
        else resolve_global_config(environment=shell)
    )
    global_config = global_resolved.build(LtcookConfig)
    if input_paths is not None:
        for snapshot in (resolved, global_resolved):
            input_paths.update(layer.path for layer in snapshot.layers if layer.path)
            input_paths.add(
                snapshot.paths.require("config") / snapshot.schema.apprc_toml_filename
            )
        if workspace_root is not None:
            workspace_path = Path(workspace_root).expanduser().resolve()
            input_paths.add(workspace_path)
            marker = workspace_path / resolved.schema.workspace_dotenv_filename
            input_paths.add(marker)
            input_paths.add(marker.with_name(f"{marker.stem}.secret{marker.suffix}"))
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
    environment["LTCOOK_PI_AUTH_DIR"] = str(
        _user_path(global_config.runtime.pi_auth_dir, home)
    )
    runtime_state = (
        _user_path(global_config.runtime.state_dir, home)
        if global_config.runtime.state_dir
        else global_resolved.paths.require("state") / "runtime"
    )
    guidance = (
        _user_path(global_config.runtime.guidance_dir, home)
        if global_config.runtime.guidance_dir
        else global_resolved.paths.require("config") / "guidance"
    )
    environment["LTCOOK_RUNTIME_STATE_DIR"] = str(runtime_state)
    environment["LTCOOK_GUIDANCE_DIR"] = str(guidance)
    environment["LTCOOK_RIED_CACHE_DIR"] = str(
        global_resolved.paths.require("cache") / "projects"
    )
    environment["LTCOOK_DATABASE"] = (
        str(_user_path(global_config.runtime.database, home))
        if global_config.runtime.database
        and global_config.runtime.database != ":memory:"
        else global_config.runtime.database
        or str(runtime_state / "coordination.sqlite")
    )
    appdata_dir = resolved.paths.require("appdata")
    deployment = (
        Path(config.app.deployment).expanduser()
        if config.app.deployment
        else appdata_dir / "deployment"
    )
    environment["LTCOOK_BRIEF_EXECUTABLE"] = str(
        deployment / "brief" / ("brief.exe" if os.name == "nt" else "brief")
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


@launch_cli.command("evaluation-context", hidden=True)
def evaluation_context(
    workspace: Annotated[Path | None, typer.Option("--workspace")] = None,
) -> None:
    """Resolve non-secret evaluation inputs through the production AppRC resolver."""
    from ltcook.config.app import APP_RC
    from ltcook.config.pi_config import pi_documents

    if workspace is not None:
        root = workspace.expanduser().resolve()
        selected = (
            APP_RC.manage(environment=_shell_environment(os.environ))
            .inspect(workspace=str(root))
            .resolved.workspace
        )
        if selected is None or selected.root.resolve() != root:
            raise ValueError("Evaluation workspace must be registered with AppRC")
    launch = resolve_launch(workspace)
    config = launch.configuration
    documents = pi_documents(
        config, owned_dir=Path(launch.environment["LTCOOK_DEPLOYMENT_DIR"]) / "app"
    )
    web = next(
        value for target, value in documents.items() if target.name == "web-search.json"
    )
    typer.echo(
        json.dumps(
            {
                "teamSelection": config.app.team,
                "guidanceDirectory": launch.environment["LTCOOK_GUIDANCE_DIR"],
                "webConfiguration": web,
                "limitations": [
                    "Authenticated external tools are skipped; browser and authenticated MCP integrations are disabled."
                ],
            }
        )
    )


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
    status = probe_runtime(environment)
    if status is None:
        return False
    if status == "starting":
        status = wait_for_runtime(environment, None, timeout=60)
    request = {
        "workspaceRoot": str(workspace_root),
        "sessionId": environment["LTCOOK_SESSION"],
        "teamSelection": environment["LTCOOK_TEAM"],
        "shellEnvironment": dict(shell_environment),
    }
    deadline = time.monotonic() + 60
    while True:
        try:
            with open_runtime_request(
                environment,
                "/v1/session/open",
                request,
                timeout=max(0.1, deadline - time.monotonic()),
            ) as response:
                if response.status != 200:
                    raise RuntimeClientError(
                        f"Running LTCook runtime returned HTTP {response.status}."
                    )
                return True
        except urllib.error.HTTPError as error:
            if error.code == 503 and time.monotonic() < deadline:
                time.sleep(0.2)
                continue
            raise RuntimeClientError(
                f"Running LTCook runtime rejected the workspace (HTTP {error.code})."
            ) from error
        except urllib.error.URLError as error:
            reason = error.reason
            if isinstance(reason, OSError) and reason.errno == errno.ECONNREFUSED:
                return False
            raise RuntimeClientError(
                "Could not contact the local LTCook runtime API."
            ) from error


def _run_foreground_runtime(
    launch: LaunchConfig, shell: Mapping[str, str], *, verbose: bool = False
) -> int:
    """Run explicit server-only startup while preserving terminal output and Ctrl+C."""
    child = start_runtime(
        launch.environment,
        workspace_root=launch.workspace_root,
        shell_environment=shell,
        detached=False,
    )
    try:
        status = wait_for_runtime(launch.environment, child)
    except KeyboardInterrupt:
        if child.process.poll() is None:
            child.process.terminate()
            try:
                child.process.wait(timeout=30)
            except subprocess.TimeoutExpired as error:
                raise RuntimeClientError(
                    "The owned runtime did not stop after startup interruption; inspect its backend log."
                ) from error
        return 130
    if child.process.poll() == 75:
        if launch.workspace_root is None:
            typer.echo("Reusing LTCook runtime.")
        elif _open_existing_runtime(launch, shell):
            typer.echo(f"Opened workspace session for {launch.workspace_root}")
        else:
            raise RuntimeClientError(
                "The runtime that won the listen race disappeared before workspace activation."
            )
        if verbose:
            return follow_runtime_logs(launch.environment, status, verbose=True)
        return 0
    return follow_runtime_logs(
        launch.environment,
        status,
        child=child,
        stop_owned_on_interrupt=True,
        verbose=verbose,
    )


@launch_cli.command("runtime")
def launch_runtime(
    workspace: Annotated[Path | None, typer.Option("--workspace")] = None,
    verbose: Annotated[
        bool, typer.Option("--verbose", help="Show complete runtime diagnostics.")
    ] = False,
) -> None:
    """Start the global runtime or explicitly open a project session.

    :param workspace: Optional project directory to open when starting.
    :return: None.
    """
    shell = _shell_environment(os.environ)
    ensure_service_secrets(shell)
    launch = resolve_launch(workspace, original_environment=shell)
    try:
        status = probe_runtime(launch.environment)
        if status == "starting":
            status = wait_for_runtime(launch.environment, None)
        if isinstance(status, RuntimeStatus) and (
            workspace is None or _open_existing_runtime(launch, shell)
        ):
            if workspace is None:
                typer.echo("Reusing LTCook runtime.")
            else:
                typer.echo(f"Opened workspace session for {launch.workspace_root}")
            if verbose:
                raise typer.Exit(
                    follow_runtime_logs(launch.environment, status, verbose=True)
                )
            return
        raise typer.Exit(_run_foreground_runtime(launch, shell, verbose=verbose))
    except RuntimeClientError as error:
        raise typer.BadParameter(str(error)) from error


def desktop_command(*, verbose: bool = False) -> int:
    """Start or reuse the global owner, open Paseo, and attach its logs."""
    try:
        shell = _shell_environment(os.environ)
        ensure_service_secrets(shell)
        launch = resolve_launch(None, original_environment=shell)
        child = None
        status = probe_runtime(launch.environment)
        if status is None:
            child = start_runtime(
                launch.environment,
                workspace_root=None,
                shell_environment=shell,
                detached=True,
            )
        if status is None or status == "starting":
            status = wait_for_runtime(launch.environment, child)
        from ltcook._browser import open_paseo_url, paseo_url

        url = paseo_url(status.paseo_listen)
        try:
            open_paseo_url(url)
        except (OSError, RuntimeError, ValueError) as error:
            print(
                f"Could not open the default browser: {error}. Open {url}",
                file=sys.stderr,
            )
        return follow_runtime_logs(
            launch.environment, status, child=child, verbose=verbose
        )
    except KeyboardInterrupt:
        return 130
    except (OSError, ValueError, KeyError) as error:
        print(str(error), file=sys.stderr)
        return 1


def service_action(action: str, workspace: Path) -> None:
    """Run a native service-controller action with the selected workspace's AppRC.

    :param action: Service action supported by the native controller.
    :param workspace: Workspace used to resolve service settings.
    :return: None.
    """
    shell = _shell_environment(os.environ)
    if action == "start":
        ensure_service_secrets(shell)
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


@launch_cli.command("prepare-native")
def prepare_native_command(
    workspace: Annotated[Path, typer.Option("--workspace")],
) -> None:
    """Resolve one workspace and write its owned native configuration together."""
    inputs: set[Path] = set()
    launch = resolve_launch(
        workspace, original_environment=os.environ, input_paths=inputs
    )
    try:
        outputs = write_pi_config(
            launch.configuration,
            owned_dir=Path(launch.environment["LTCOOK_DEPLOYMENT_DIR"]) / "app",
            pi_home=launch.environment["PI_CODING_AGENT_DIR"],
        )
    except ValueError as error:
        raise typer.BadParameter(str(error)) from error
    typer.echo(
        json.dumps(
            {
                "workspaceRoot": str(launch.workspace_root),
                "environment": launch.environment,
                "dependencies": sorted(map(str, inputs.union(outputs))),
            }
        )
    )


def main(argv: Sequence[str] | None = None) -> None:
    """Run launch-specific commands for Python module callers."""
    launch_cli(args=list(argv if argv is not None else sys.argv[1:]))


if __name__ == "__main__":
    main()
