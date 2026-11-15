"""Typer commands for ltcook."""

from __future__ import annotations

import json
import logging
import os
import sys
from importlib import metadata
from pathlib import Path
from typing import Annotated

import apprc as rc
import typer
from apprc.definition.installation import InstallationHooks

import ltcook
from ltcook._runtime_client import RuntimeClientError, stop_runtime
from ltcook.auth import auth_cli
from ltcook.cli.planning import guidance_cli, planning_cli
from ltcook.config.app import APP_RC
from ltcook.config.bundle import LtcookConfig
from ltcook.launch import desktop_command, launch_cli, resolve_launch, services_cli
from ltcook_distr.payload.app_lifecycle.actions import maintenance_handlers

PACKAGE_NAME = "ltcook"
VERSION_FALLBACK = "0.1.0"
LOG = logging.getLogger(__name__)

app = typer.Typer(
    cls=rc.cli.AppRCRootGroup,
    add_completion=True,
    help="Command-line tools for ltcook.",
    no_args_is_help=True,
    pretty_exceptions_show_locals=False,
)
app.add_typer(launch_cli, name="launch", help="Launch native runtime components.")
app.add_typer(auth_cli, name="auth", help="Manage Pi provider authentication.")
app.add_typer(
    planning_cli, name="planning", help="Plan work and record user decisions."
)
app.add_typer(guidance_cli, name="guidance", help="Inspect rules and skills.")
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


def _version_callback(value: bool, ctx: typer.Context) -> bool:
    """Print the package version before AppRC runtime preparation.

    :param value: Whether the version option was selected.
    :param ctx: Root CLI context for this invocation.
    :return: The parsed value during resilient parsing, or the ordinary value.
    """
    if value and not ctx.resilient_parsing:
        typer.echo(_package_version())
        raise typer.Exit()
    return value


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
    ollama_readiness = None
    if paths is not None and paths.appdata_dir is not None:
        receipt = paths.appdata_dir / "deployment" / "ollama.json"
        if receipt.is_file():
            try:
                data = json.loads(receipt.read_text(encoding="utf-8"))
                ollama_readiness = {
                    "ready": data.get("ready") is True,
                    "version": data.get("version"),
                    "endpoint": data.get("endpoint"),
                    "model": data.get("model"),
                    "model_digest": data.get("model_digest"),
                    "ibb_model": data.get("ibb_model"),
                }
            except (OSError, json.JSONDecodeError):
                ollama_readiness = {
                    "ready": False,
                    "diagnostic": "Invalid Ollama receipt",
                }
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
        "ollama": ollama_readiness,
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


def _ollama_resource_diagnostics(appdata: Path) -> dict[str, object]:
    """Expose local inference readiness in AppRC's existing application doctor."""
    receipt = appdata / "deployment" / "ollama.json"
    if not receipt.is_file():
        raise ValueError("Ollama setup receipt is missing.")
    try:
        data = json.loads(receipt.read_text(encoding="utf-8"))
        from ltcook_distr.payload.app_lifecycle.prepare_ollama import (
            ENDPOINT,
            IBB_MODEL,
            MODEL,
            _json,
        )

        version = _json(f"{ENDPOINT}/api/version").get("version")
        models = _json(f"{ENDPOINT}/api/tags").get("models", [])
        model_details = _json(
            f"{ENDPOINT}/api/show", data={"name": IBB_MODEL, "verbose": False}
        )
        names = {item.get("name") for item in models if isinstance(item, dict)}
        ready = (
            data.get("ready") is True
            and MODEL in names
            and IBB_MODEL in names
            and "PARAMETER num_ctx 8192" in str(model_details.get("modelfile", ""))
            and version == data.get("version")
        )
        if not ready:
            raise ValueError("Ollama service or required Spark model is not ready.")
        return {
            "ollama": {
                "ready": True,
                "version": version,
                "model": MODEL,
                "model_present": True,
                "ibb_model": IBB_MODEL,
                "ibb_model_present": True,
                "context_tokens": 8192,
                "endpoint": ENDPOINT,
            }
        }
    except (OSError, RuntimeError, ValueError) as error:
        raise ValueError(f"Ollama readiness check failed: {error}") from error


runtime = rc.cli.CliRuntime(
    APP_RC,
    runtime_policy=rc.cli.CliRuntimePolicy(
        runtime_independent_commands={
            "stop": rc.cli.RuntimeIndependentCommand(skip_empty=True),
            "planning": rc.cli.RuntimeIndependentCommand(skip_empty=True),
            "guidance": rc.cli.RuntimeIndependentCommand(skip_empty=True),
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
            "diagnose": rc.cli.RuntimeIndependentCommand(skip_empty=True),
        },
        extra_cli_flag_options={"--json"},
    ),
    runtime_payload=_config_show_payload,
    setup_logging=_setup_app_logging,
)
runtime.mount_app_groups(
    app,
    handlers=maintenance_handlers(),
    installation_management=True,
    installation_hooks=InstallationHooks(
        initialize="ltcook_distr.payload.app_lifecycle.actions:initialize",
    ),
    resource_diagnostics={"appdata": _ollama_resource_diagnostics},
)


@app.callback()
def app_callback(
    ctx: typer.Context,
    version: Annotated[
        bool,
        typer.Option(
            "--version",
            "-V",
            is_eager=True,
            callback=_version_callback,
            help="Show the package version and exit.",
        ),
    ] = False,
    verbose: Annotated[
        bool,
        typer.Option(
            "--verbose",
            help="Show complete diagnostics for bare desktop startup.",
        ),
    ] = False,
    env_files: rc.cli.EnvFilesOption = None,
    env_file_overrides_os_environ: rc.cli.EnvFileOverridesOption = False,
    skip_dotenv_layers: rc.cli.SkipDotenvLayersOption = False,
    workspace: rc.cli.WorkspaceOption = None,
    layout: rc.cli.LayoutOption = None,
    app_root: rc.cli.AppRootOption = None,
    log_level: rc.cli.LogLevelOption = None,
) -> None:
    """Capture AppRC bootstrap inputs before optional runtime preparation."""
    if verbose and ctx.invoked_subcommand is not None:
        raise typer.BadParameter(
            "--verbose is supported only for bare desktop startup; use "
            "`ltcook launch runtime --verbose` for the foreground viewer."
        )
    try:
        options = rc.cli.CliRuntimeOptions.from_typer(
            env_files=env_files,
            env_file_overrides_os_environ=env_file_overrides_os_environ,
            load_dotenv_layers=not skip_dotenv_layers,
            workspace=workspace,
            layout=layout,
            app_root=app_root,
            log_level=log_level,
        )
    except ValueError as error:
        raise typer.BadParameter(str(error)) from error
    runtime.prepare(ctx, options)


@app.command("stop")
def stop_cmd() -> None:
    """Stop only the authenticated runtime instance for this installation."""
    try:
        raise typer.Exit(stop_runtime(resolve_launch(None).environment))
    except RuntimeClientError as error:
        raise typer.BadParameter(str(error)) from error


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
    completion_requested = any(
        key.startswith("_") and key.endswith("_COMPLETE") and value
        for key, value in os.environ.items()
    )
    if arguments and arguments[0] == "--verbose":
        if completion_requested or any(
            argument in {"--help", "--version", "-V"} for argument in arguments
        ):
            app(args=arguments)
            return
        if len(arguments) == 1:
            raise SystemExit(desktop_command(verbose=True))
        raise SystemExit(
            "`ltcook --verbose` is supported only without a command; "
            "use `ltcook launch runtime --verbose` for foreground logs."
        )
    app(args=arguments)


if __name__ == "__main__":
    main()
