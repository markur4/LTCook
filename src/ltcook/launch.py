"""Global and per-workspace AppRC resolution for native launches."""

from __future__ import annotations

import errno
import hashlib
import json
import os
import stat
import subprocess
import sys
import time
import urllib.error
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Annotated, Literal, NotRequired, TypedDict
from uuid import UUID, uuid4

import typer
from apprc import ResolvedConfig

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
    PiConfigPublication,
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


class NativeInputGuard(TypedDict):
    """Filesystem identity and optional content or directory-entry version."""

    identity: tuple[str, str, str, str, str]
    version: NotRequired[tuple[str, str, str]]


def _input_guard(
    observed: os.stat_result | None, *, versioned: bool = True
) -> NativeInputGuard | None:
    if observed is None:
        return None
    guard: NativeInputGuard = {
        "identity": (
            str(observed.st_dev),
            str(observed.st_ino),
            str(observed.st_mode),
            str(observed.st_uid),
            str(observed.st_gid),
        )
    }
    if versioned:
        guard["version"] = (
            str(observed.st_size),
            str(observed.st_mtime_ns),
            str(observed.st_ctime_ns),
        )
    return guard


@dataclass
class NativePreparationInputs:
    """Track filesystem guards for reuse of an installed AppRC snapshot."""

    dependencies: set[Path] = field(default_factory=set)
    identity_paths: set[Path] = field(default_factory=set)
    reusable: bool = True

    def capture(self, snapshot: ResolvedConfig) -> None:
        """Keep reuse within the pinned resolver's representable authority path.

        :param snapshot: Resolved settings and installation placement.
        :return: None; unrepresentable layouts require fresh resolution.
        """
        paths = snapshot.paths
        if (
            os.name != "posix"
            or paths.source != "installation"
            or paths.installation.revision is None
            or paths.installation.generation_id is None
            or snapshot.issues
            or snapshot.workspace_issues
        ):
            self.reusable = False
        for layer in snapshot.layers:
            if layer.path is not None:
                self.dependencies.add(layer.path)
            elif layer.resource is not None:
                self.reusable = False
        self.dependencies.add(paths.installation.directory / "installation.json")
        self.dependencies.add(
            paths.require("config") / snapshot.schema.apprc_toml_filename
        )
        for kind in ("config", "appdata", "cache", "state"):
            root = paths.require(kind)
            self.identity_paths.add(root)
            self.dependencies.add(root / ".apprc-owner.json")

    def guard_ancestors(self) -> None:
        """Retain link and permission checks without following ancestor links."""
        for path in (*self.dependencies, *self.identity_paths):
            absolute = path.expanduser().absolute()
            self.identity_paths.add(absolute)
            self.identity_paths.update(absolute.parents)

    def observe(self) -> dict[Path, os.stat_result | None] | None:
        """Capture source metadata and reject observed links or special files."""
        if not self.reusable:
            return None
        self.guard_ancestors()
        observations: dict[Path, os.stat_result | None] = {}
        for path in sorted(
            self.dependencies | self.identity_paths,
            key=lambda item: (len(item.parts), str(item)),
        ):
            if not path.is_absolute() or ".." in path.parts:
                return None
            try:
                observed = path.lstat()
            except FileNotFoundError:
                observations[path] = None
                continue
            except OSError:
                return None
            if not (stat.S_ISREG(observed.st_mode) or stat.S_ISDIR(observed.st_mode)):
                return None
            observations[path] = observed
        return observations

    def attest(
        self,
        initial: NativePreparationInputs,
        before: Mapping[Path, os.stat_result | None],
    ) -> dict[str, NativeInputGuard | None] | None:
        """Attest a resolution bracketed by unchanged input observations.

        :param initial: Dependency and identity paths from the discovery pass.
        :param before: Source observations taken before the authoritative read.
        :return: Guards to check after publication, or None if reuse is unsafe.
        """
        after = self.observe()
        if (
            after is None
            or self.dependencies != initial.dependencies
            or self.identity_paths != initial.identity_paths
            or after.keys() != before.keys()
        ):
            return None
        if any(
            _input_guard(after[path]) != _input_guard(entry)
            for path, entry in before.items()
        ):
            return None
        # > An absent file may appear and disappear without leaving its own stamp.
        # > Keep the nearest existing directory's version until Node checks reuse.
        versioned_dirs: set[Path] = set()
        for path, entry in before.items():
            if entry is None:
                for ancestor in path.parents:
                    if before[ancestor] is not None:
                        versioned_dirs.add(ancestor)
                        break
        return {
            str(path): _input_guard(
                entry,
                versioned=entry is not None
                and (not stat.S_ISDIR(entry.st_mode) or path in versioned_dirs),
            )
            for path, entry in before.items()
        }


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
    preparation_inputs: NativePreparationInputs | None = None,
) -> LaunchConfig:
    """Resolve global runtime settings and optional project overlays.

    :param workspace_root: Explicit project directory, or None for global startup.
    :param original_environment: Captured shell variables before AppRC overlays.
    :param preparation_inputs: Optional collector for installed configuration reuse.
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
    if preparation_inputs is not None:
        for snapshot in (resolved, global_resolved):
            preparation_inputs.capture(snapshot)
        if workspace_root is not None:
            requested_path = Path(workspace_root).expanduser().absolute()
            workspace_path = requested_path.resolve()
            preparation_inputs.identity_paths.add(requested_path)
            preparation_inputs.identity_paths.add(workspace_path)
            marker = workspace_path / resolved.schema.workspace_dotenv_filename
            preparation_inputs.dependencies.add(marker)
            preparation_inputs.dependencies.add(
                marker.with_name(f"{marker.stem}.secret{marker.suffix}")
            )
    environment = dict(shell)
    for section in config.__dict__.values():
        environment.update(
            section.current_env_mapping(prefixed=True, include_empty=True)
        )
    # > Runtime services maintain the whole host, so project overlays cannot
    # > replace their user settings. Deliberate shell exports still apply.
    for section in (
        global_config.workspace_organizer,
        global_config.renamer,
        global_config.bughunter,
    ):
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
    environment["LTCOOK_OLLAMA_ENDPOINT"] = global_config.runtime.ollama_endpoint
    environment["LTCOOK_MODEL_TINY_LOCAL"] = global_config.runtime.tiny_local_model
    environment["LTCOOK_MODEL_LOCAL_CPU"] = global_config.runtime.local_cpu_model
    environment["LTCOOK_MODEL_LOCAL_EVALS"] = global_config.runtime.local_evals_model
    environment["LTCOOK_SUMMARIZER_KEEP_ALIVE"] = str(
        global_config.runtime.summarizer_keep_alive
    )
    environment["LTCOOK_SUMMARIZER_GENERATION"] = (
        global_config.runtime.summarizer_generation
    )
    environment["LTCOOK_CONVERSATION_LOCAL_MODEL"] = (
        global_config.runtime.conversation_local_model
    )
    environment["LTCOOK_CONVERSATION_INFERENCE"] = (
        global_config.runtime.conversation_inference
    )
    environment["LTCOOK_CONVERSATION_INPUT_TOKENS"] = str(
        global_config.runtime.conversation_input_tokens
    )
    environment["LTCOOK_SESSION_MEMORY_DELEGATION"] = str(
        global_config.runtime.session_memory_delegation
    ).lower()
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
    environment["LTCOOK_SHARED_SKILLS_DIR"] = str(
        (home / ".agents" / "skills").resolve()
    )
    environment["LTCOOK_RIED_CACHE_DIR"] = str(
        global_resolved.paths.require("cache") / "projects"
    )
    environment["LTCOOK_COLGREP_CACHE_DIR"] = str(
        global_resolved.paths.require("cache") / "colgrep"
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
    # > Repository search uses the global assets prepared by AppRC setup.
    environment["LTCOOK_COLGREP_DEPLOYMENT"] = str(
        global_resolved.paths.require("appdata") / "deployment" / "colgrep"
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
        config,
        owned_dir=Path(launch.environment["LTCOOK_DEPLOYMENT_DIR"]) / "app",
        runtime_environment=launch.environment,
    )
    web = next(
        value for target, value in documents.items() if target.name == "web-search.json"
    )
    typer.echo(
        json.dumps(
            {
                "teamSelection": config.app.team,
                "guidanceDirectory": launch.environment["LTCOOK_GUIDANCE_DIR"],
                "sharedSkillsDirectory": launch.environment["LTCOOK_SHARED_SKILLS_DIR"],
                "webConfiguration": web,
                "summarization": {
                    "endpoint": launch.environment["LTCOOK_OLLAMA_ENDPOINT"],
                    "model": launch.environment["LTCOOK_MODEL_TINY_LOCAL"],
                    "keepAlive": int(
                        launch.environment["LTCOOK_SUMMARIZER_KEEP_ALIVE"]
                    ),
                    "generation": launch.environment["LTCOOK_SUMMARIZER_GENERATION"],
                },
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


@launch_cli.command("model", context_settings={"allow_extra_args": True})
def launch_model(
    ctx: typer.Context,
    harness: Annotated[str, typer.Argument(help="Native harness: pi or codex.")],
    alias: Annotated[str, typer.Argument(help="LTCook model alias, such as @plan.")],
    reasoning: Annotated[
        str | None,
        typer.Option("--reasoning", help="Override the alias reasoning preset."),
    ] = None,
    workspace: Annotated[Path, typer.Option("--workspace")] = Path("."),
) -> None:
    """Launch Pi or Codex with a resolved model alias. Pass native arguments after --."""
    if harness not in {"pi", "codex"}:
        raise typer.BadParameter("The harness must be pi or codex.")
    try:
        launch = resolve_launch(workspace)
        environment = launch.environment
        node = environment["LTCOOK_NODE_EXECUTABLE"]
        native = Path(environment["LTCOOK_JS_ROOT"]) / "runtime" / "dist" / "main.js"
        if not Path(node).is_file() or not native.is_file():
            raise ValueError(
                "Runtime prerequisites are not prepared; re-run the LTCook installer."
            )
        if harness == "pi":
            pi_paths = _write_launch_pi_config(launch).output_hashes
            models_path = next(path for path in pi_paths if path.name == "models.json")
            environment["LTCOOK_PI_MODELS_PATH"] = str(models_path)
        completed = subprocess.run(
            [
                node,
                str(native),
                "model-launch",
                harness,
                alias,
                reasoning or "",
                "--",
                *ctx.args,
            ],
            cwd=launch.workspace_root,
            env=environment,
            check=False,
        )
    except (OSError, ValueError) as error:
        raise typer.BadParameter(str(error)) from error
    except KeyboardInterrupt:
        raise typer.Exit(130) from None
    if completed.returncode:
        raise typer.Exit(completed.returncode)


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
    launch: LaunchConfig,
    shell: Mapping[str, str],
    *,
    verbose: bool = False,
    restart_instance_id: UUID | None = None,
) -> int:
    """Run explicit server-only startup while preserving terminal output and Ctrl+C."""
    child = start_runtime(
        launch.environment,
        workspace_root=launch.workspace_root,
        shell_environment=shell,
        detached=False,
        restart_instance_id=restart_instance_id,
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
    if restart_instance_id is not None and status.instance_id != str(
        restart_instance_id
    ):
        raise RuntimeClientError("Another runtime won the restart launch race.")
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
    restart_instance_id: Annotated[
        UUID | None, typer.Option("--restart-instance-id", hidden=True)
    ] = None,
) -> None:
    """Start the global runtime or explicitly open a project session.

    :param workspace: Optional project directory to open when starting.
    :param restart_instance_id: Identify the sole owner candidate for a registered restart.
    :return: None.
    """
    shell = _shell_environment(os.environ)
    ensure_service_secrets(shell)
    launch = resolve_launch(workspace, original_environment=shell)
    try:
        status = probe_runtime(launch.environment)
        if restart_instance_id is not None and status is not None:
            raise RuntimeClientError(
                "Another runtime appeared before the restart launch."
            )
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
        raise typer.Exit(
            _run_foreground_runtime(
                launch, shell, verbose=verbose, restart_instance_id=restart_instance_id
            )
        )
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


@services_cli.command("bughunter-authorization")
def bughunter_authorization(
    operation: Literal[
        "status", "grant", "revoke", "prohibit", "clear-prohibition", "publish-issue"
    ],
    data_file: Annotated[Path | None, typer.Option("--file")] = None,
    prohibition_id: Annotated[str | None, typer.Option("--id")] = None,
) -> None:
    """Inspect or change BugFix standing authority through the authenticated runtime."""
    request: dict[str, object] = {"operation": operation}
    if operation in ("grant", "prohibit", "publish-issue"):
        if data_file is None:
            raise typer.BadParameter("Supply the scope as a JSON file with --file.")
        try:
            field = (
                "prohibition"
                if operation == "prohibit"
                else ("issue" if operation == "publish-issue" else "grant")
            )
            request[field] = json.loads(data_file.read_text(encoding="utf-8"))
        except (OSError, ValueError) as error:
            raise typer.BadParameter("The scope file must be readable JSON.") from error
    elif operation == "clear-prohibition":
        if not prohibition_id:
            raise typer.BadParameter("Supply the prohibition identifier with --id.")
        request["id"] = prohibition_id
    launch = resolve_launch(None, original_environment=os.environ)
    try:
        with open_runtime_request(
            launch.environment, "/v1/activity/bugfix-authorization", request, timeout=5
        ) as response:
            typer.echo(json.dumps(json.load(response), indent=2))
    except urllib.error.HTTPError as error:
        raise typer.BadParameter(
            f"The runtime rejected this BugFix authorization request (HTTP {error.code})."
        ) from error
    except (OSError, ValueError) as error:
        raise typer.BadParameter(
            "The authenticated LTCook runtime is unavailable."
        ) from error


@launch_cli.command("write-native-config")
def write_native_command(
    workspace: Annotated[Path, typer.Option("--workspace")],
) -> None:
    """Generate Pi model and web-access files in the AppRC-owned deployment."""
    launch = resolve_launch(workspace, original_environment=os.environ)
    try:
        paths = _write_launch_pi_config(launch).output_hashes
    except ValueError as error:
        raise typer.BadParameter(str(error)) from error
    typer.echo(json.dumps([str(path) for path in paths]))


@launch_cli.command("prepare-native")
def prepare_native_command(
    workspace: Annotated[Path, typer.Option("--workspace")],
) -> None:
    """Resolve one workspace and write its owned native configuration together."""
    inputs = NativePreparationInputs()
    environment = dict(os.environ)
    launch = resolve_launch(
        workspace, original_environment=environment, preparation_inputs=inputs
    )
    input_guards = None
    before = inputs.observe()
    if before is not None:
        resolved_inputs = NativePreparationInputs()
        launch = resolve_launch(
            workspace,
            original_environment=environment,
            preparation_inputs=resolved_inputs,
        )
        input_guards = resolved_inputs.attest(inputs, before)
        inputs = resolved_inputs
    try:
        publication = _write_launch_pi_config(launch)
    except ValueError as error:
        raise typer.BadParameter(str(error)) from error
    outputs = publication.output_hashes
    inputs.dependencies.update(outputs)
    inputs.guard_ancestors()
    typer.echo(
        json.dumps(
            {
                "workspaceRoot": str(launch.workspace_root),
                "environment": launch.environment,
                "dependencies": sorted(map(str, inputs.dependencies)),
                "identityPaths": sorted(map(str, inputs.identity_paths)),
                "outputHashes": {str(path): digest for path, digest in outputs.items()},
                "inputGuards": input_guards
                if not publication.waited_for_lock
                else None,
                "reusable": input_guards is not None
                and not publication.waited_for_lock,
            }
        )
    )


def _write_launch_pi_config(launch: LaunchConfig) -> PiConfigPublication:
    """Write native files from the same effective settings sent to Pi."""
    environment = launch.environment
    return write_pi_config(
        launch.configuration,
        owned_dir=Path(environment["LTCOOK_DEPLOYMENT_DIR"]) / "app",
        pi_home=environment["PI_CODING_AGENT_DIR"],
        runtime_environment=environment,
    )


def main(argv: Sequence[str] | None = None) -> None:
    """Run launch-specific commands for Python module callers."""
    launch_cli(args=list(argv if argv is not None else sys.argv[1:]))


if __name__ == "__main__":
    main()
