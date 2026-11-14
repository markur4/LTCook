"""Typer commands for ltcook."""

from __future__ import annotations

import logging
import os
import sys
from importlib import metadata
from pathlib import Path
from typing import Annotated

import apprc as rc
import typer

import ltcook
from ltcook._runtime_client import RuntimeClientError, stop_runtime
from ltcook.auth import auth_cli
from ltcook.config.app import APP_RC
from ltcook.config.bundle import LtcookConfig
from ltcook.launch import desktop_command, launch_cli, resolve_launch, services_cli
from ltcook_distr.payload.app_lifecycle.actions import maintenance_handlers

PACKAGE_NAME = "ltcook"
VERSION_FALLBACK = "0.1.0"
LOG = logging.getLogger(__name__)

app = typer.Typer(
    add_completion=True,
    help="Command-line tools for ltcook.",
    no_args_is_help=True,
    pretty_exceptions_show_locals=False,
)
app.add_typer(launch_cli, name="launch", help="Launch native runtime components.")
app.add_typer(auth_cli, name="auth", help="Manage Pi provider authentication.")
app.add_typer(
    services_cli,
    name="services",
    help="Manage local and configured remote service connections.",
)


def _package_version() -> str:
    """Return installed package metadata, or the source-checkout version."""
    try:
        return metadata.version(PACKAGE_NAME)
    except metadata.PackageNotFoundError:
        return VERSION_FALLBACK


def _diagnose_payload() -> dict[str, object]:
    """Inspect package and installation authority without requiring business settings.

    :return: JSON-compatible package, installation, and component paths.
    """
    schema = APP_RC.schema
    inspection = APP_RC.installation().inspect()
    path_error = None
    try:
        paths = APP_RC.paths()
    except rc.InstallationError as error:
        paths = None
        path_error = str(error)
    return {
        "cwd": str(Path.cwd()),
        "installation_directory": str(inspection.directory),
        "installation_status": inspection.status,
        "installation_diagnostics": [
            diagnostic.message for diagnostic in inspection.diagnostics
        ],
        "path_error": path_error,
        "paths": (
            {
                kind: str(path) if path is not None else None
                for kind, path in (
                    ("config", paths.config_dir),
                    ("appdata", paths.appdata_dir),
                    ("cache", paths.cache_dir),
                    ("state", paths.state_dir),
                    ("logs", paths.logs_dir),
                )
            }
            if paths is not None
            else None
        ),
        "layout_env_key": schema.layout_env_key,
        "root_env_key": schema.root_env_key,
        "package": PACKAGE_NAME,
        "package_file": str(Path(ltcook.__file__).resolve()),
        "python_executable": sys.executable,
        "python_version": sys.version,
        "version": _package_version(),
    }


def _config_show_payload(
    state: rc.cli.DefaultConfigCliState,
) -> dict[str, object]:
    """Build a report from this command's captured path and config snapshot.

    :param state: CLI state containing the current resolution.
    :return: Application settings, paths, and workspace selection.
    """
    assert state.resolved is not None
    resolved = state.resolved
    config = resolved.build(LtcookConfig)
    workspace = resolved.workspace
    return {
        "package": PACKAGE_NAME,
        "version": _package_version(),
        "paths": {
            kind: str(path) if path is not None else None
            for kind, path in (
                ("config", resolved.paths.config_dir),
                ("appdata", resolved.paths.appdata_dir),
                ("cache", resolved.paths.cache_dir),
                ("state", resolved.paths.state_dir),
                ("logs", resolved.paths.logs_dir),
            )
        },
        "workspace": (
            {
                "name": workspace.workspace_name,
                "root": str(workspace.root),
            }
            if workspace is not None
            else None
        ),
        "config": config.app.to_dict(),
    }


def _setup_app_logging(level: str | int = "INFO", **_: object) -> None:
    """Configure stdlib logging for one invocation.

    :param level: Logging level supplied by AppRC.
    :param _: Unused additional logging options.
    """
    logging.basicConfig(level=level)


rc.cli.mount_app_cli(
    app,
    APP_RC,
    runtime_policy=rc.cli.CliRuntimePolicy(
        runtime_independent_commands={
            "stop": rc.cli.RuntimeIndependentCommand(skip_empty=True),
            "launcher": rc.cli.RuntimeIndependentCommand(skip_empty=True),
            "auth": rc.cli.RuntimeIndependentCommand(
                action_prefixes={("login",), ("logout",), ("check",)},
                skip_empty=True,
            ),
            "launch": rc.cli.RuntimeIndependentCommand(
                action_prefixes={
                    ("runtime",),
                    ("environment",),
                    ("write-native-config",),
                },
                skip_empty=True,
            ),
            "services": rc.cli.RuntimeIndependentCommand(
                action_prefixes={("start",), ("stop",), ("status",), ("logs",)},
                skip_empty=True,
            ),
            "version": rc.cli.RuntimeIndependentCommand(skip_empty=True),
            "diagnose": rc.cli.RuntimeIndependentCommand(skip_empty=True),
        },
        extra_cli_flag_options={"--json"},
    ),
    handlers=maintenance_handlers(),
    runtime_payload=_config_show_payload,
    setup_logging=_setup_app_logging,
)


@app.command("stop")
def stop_cmd() -> None:
    """Stop only the authenticated runtime instance for this installation."""
    try:
        raise typer.Exit(stop_runtime(resolve_launch(None).environment))
    except RuntimeClientError as error:
        raise typer.BadParameter(str(error)) from error


@app.command("launcher")
def launcher_cmd(ctx: typer.Context) -> None:
    """Open the optional installed AppRC launcher."""
    context = rc.cli.installation_command_context_from(ctx)
    if context is None:
        raise RuntimeError("Launcher recovery context was not prepared.")
    controls = context.runtime_options
    executable = Path(sys.executable).with_name(
        PACKAGE_NAME + (".exe" if os.name == "nt" else "")
    )
    arguments = tuple(rc.cli.cli_runtime_options_to_args(controls))
    rc.tui.run_launcher(
        APP_RC,
        spec=rc.tui.LauncherSpec(
            actions=(
                rc.tui.LauncherAction(
                    id="main",
                    label="Run ltcook",
                    argv=lambda _launcher, _interactive: (
                        str(executable),
                        *arguments,
                    ),
                    group="main",
                    interactive=True,
                ),
            ),
            title="ltcook",
        ),
        options=rc.ResolveOptions(
            workspace=controls.workspace,
            layout=controls.layout,
            env_files=controls.env_files,
            env_file_overrides_os_environ=controls.env_file_overrides_os_environ,
            load_dotenv_layers=controls.load_dotenv_layers,
        ),
        environment=context.environment,
    )


@app.command("version")
def version_cmd() -> None:
    """Print the installed package version."""
    typer.echo(_package_version())


@app.command("diagnose")
def diagnose_cmd(
    json_output: Annotated[
        bool, typer.Option("--json", help="Emit machine-readable JSON.")
    ] = False,
) -> None:
    """Print package, interpreter, and AppRC paths without changing files."""
    payload = _diagnose_payload()
    if json_output:
        rc.cli.dump_json(payload)
        return
    for key in sorted(payload):
        typer.echo(f"{key}: {payload[key]}")


def main(argv: list[str] | None = None) -> None:
    """Dispatch bare startup separately while preserving all Typer argument routing."""
    arguments = sys.argv[1:] if argv is None else argv
    if not arguments:
        if any(
            key.startswith("_") and key.endswith("_COMPLETE") and value
            for key, value in os.environ.items()
        ):
            app()
            return
        raise SystemExit(desktop_command())
    app(args=arguments)


if __name__ == "__main__":
    main()
