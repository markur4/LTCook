"""Prepare LTCook's host-local Ollama service and bootstrap model."""

from __future__ import annotations

import json
import logging
import os
import platform
import re
import shutil
import socket
import subprocess
import time
from collections.abc import Mapping
from pathlib import Path
from urllib.error import URLError
from urllib.parse import urlsplit
from urllib.request import Request, urlopen

from ._common import SetupError, download, no_links, run, write_json

MODEL = "bonsai-2:27b"
EVAL_MODEL = "ltcook-bonsai-2-27b-ctx65536:latest"
CONTEXT_TOKENS = 65536
ENDPOINT = "http://127.0.0.1:11434"
LOG = logging.getLogger(__name__)


def _has_expected_context(modelfile: object) -> bool:
    return isinstance(modelfile, str) and any(
        re.fullmatch(rf"\s*PARAMETER\s+num_ctx\s+{CONTEXT_TOKENS}\s*", line)
        for line in modelfile.splitlines()
    )


def _port_is_open() -> bool:
    with socket.socket() as probe:
        return probe.connect_ex(("127.0.0.1", 11434)) == 0


def _json(url: str, *, timeout: float = 3, data: object | None = None) -> dict:
    request = Request(
        url,
        data=json.dumps(data).encode() if data is not None else None,
        headers={"Content-Type": "application/json"},
    )
    try:
        with urlopen(request, timeout=timeout) as response:
            value = json.load(response)
    except (OSError, URLError, json.JSONDecodeError) as exc:
        raise SetupError(f"Ollama endpoint is unavailable or invalid: {url}") from exc
    if not isinstance(value, dict):
        raise SetupError("Ollama returned an invalid JSON response.")
    return value


def summarizer_readiness(
    *,
    environment: Mapping[str, str] | None = None,
    pull_with: str | None = None,
    previous: object = None,
) -> dict[str, str | bool]:
    """Probe the AppRC-configured summarizer and optionally prepare its model.

    :param environment: Original shell environment for global AppRC resolution.
    :param pull_with: Ollama CLI to use during explicit installation initialization.
    :param previous: Previous setup diagnostic for the same endpoint and model.
    :return: Readiness properties independent of Bonsai preparation.
    """
    from ltcook.config.pi_config import resolve_global_config
    from ltcook.config.sections.runtime import RuntimeSettings

    status: dict[str, str | bool] = {"ready": False}
    try:
        settings = resolve_global_config(environment=environment).build(RuntimeSettings)
        model = settings.summarizer_model.strip()
        parsed = urlsplit(settings.ollama_endpoint.strip())
        if (
            parsed.scheme != "http"
            or parsed.hostname not in {"127.0.0.1", "::1", "localhost"}
            or parsed.username is not None
            or parsed.password is not None
            or parsed.path not in {"", "/"}
            or parsed.query
            or parsed.fragment
            or not parsed.port
        ):
            raise SetupError(
                "Configure the Ollama endpoint as an HTTP loopback URL with a port."
            )
        if not model or settings.summarizer_keep_alive < -1:
            raise SetupError(
                "Configure a summarizer model and a keep-alive of -1 or nonnegative seconds."
            )
        endpoint = f"{parsed.scheme}://{parsed.netloc}"
        status.update(endpoint=endpoint, model=model)

        def model_available() -> bool:
            models = _json(f"{endpoint}/api/tags").get("models")
            if not isinstance(models, list):
                raise SetupError("Ollama returned an invalid model inventory.")
            return any(
                isinstance(item, dict) and item.get("name") == model for item in models
            )

        ready = model_available()
        if not ready and pull_with is not None:
            env = dict(os.environ if environment is None else environment)
            run(
                [pull_with, "pull", model], environment={**env, "OLLAMA_HOST": endpoint}
            )
            ready = model_available()
        if not ready:
            if (
                isinstance(previous, dict)
                and previous.get("model") == model
                and previous.get("endpoint") == endpoint
                and isinstance(previous.get("error"), str)
            ):
                raise SetupError(previous["error"])
            raise SetupError("Summarizer model is missing. Run LTCook setup or repair.")
        status["ready"] = True
    except (OSError, RuntimeError, ValueError) as error:
        status["error"] = str(error)
    return status


def _install_ollama(deployment: Path, environment: dict[str, str]) -> str:
    """Use Ollama's official platform installer; never invoke Windows from WSL."""
    system = platform.system()
    if system == "Linux":
        script = deployment / "ollama-install.sh"
        download("https://ollama.com/install.sh", script)
        run(["sh", str(script)], environment=environment)
        executable = shutil.which("ollama", path=environment.get("PATH"))
    elif system == "Windows":
        if platform.machine().lower() not in {"amd64", "x86_64"}:
            raise SetupError("The official Ollama Windows installer supports x64 only.")
        installer = deployment / "OllamaSetup.exe"
        download("https://ollama.com/download/OllamaSetup.exe", installer)
        run([str(installer)], environment=environment)
        executable = shutil.which("ollama.exe", path=environment.get("PATH"))
    elif system == "Darwin":
        raise SetupError(
            "Ollama is missing. Install the official macOS application from "
            "https://ollama.com/download/macOS, then rerun LTCook setup."
        )
    else:
        raise SetupError(f"Official Ollama installation is unsupported on {system}.")
    if not executable:
        raise SetupError(
            "Official Ollama installer completed but ollama was not found."
        )
    return executable


def _wait_for_server(
    environment: dict[str, str], executable: str | None
) -> tuple[bool, str, int | None]:
    try:
        version = _json(f"{ENDPOINT}/api/version")["version"]
        return False, str(version), None
    except (SetupError, KeyError):
        pass
    if _port_is_open():
        raise SetupError("Port 11434 is occupied by a non-Ollama local service.")
    if executable is None:
        raise SetupError("A healthy Ollama API exists, but no executable is available.")
    try:
        child = subprocess.Popen(
            [executable, "serve"],
            env={**environment, "OLLAMA_HOST": "127.0.0.1:11434"},
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            start_new_session=os.name != "nt",
        )
    except OSError as exc:
        raise SetupError("Could not start the LTCook Ollama service.") from exc
    for _ in range(60):
        if child.poll() is not None:
            raise SetupError("LTCook-owned Ollama exited before becoming ready.")
        try:
            version = _json(f"{ENDPOINT}/api/version")["version"]
            return True, str(version), child.pid
        except (SetupError, KeyError):
            time.sleep(0.5)
    child.terminate()
    child.wait(timeout=5)
    raise SetupError("Ollama did not become ready on the loopback endpoint.")


def prepare_ollama(appdata: Path, *, environment: dict[str, str] | None = None) -> Path:
    """Reuse/install Ollama, ensure Bonsai, and record private readiness."""
    env = dict(os.environ if environment is None else environment)
    deployment = appdata / "deployment"
    deployment.mkdir(parents=True, exist_ok=True, mode=0o700)
    receipt_path = deployment / "ollama.json"
    no_links(receipt_path)
    executable = (
        env.get("LTCOOK_OLLAMA_EXECUTABLE")
        or shutil.which("ollama", path=env.get("PATH"))
        or shutil.which("ollama.exe", path=env.get("PATH"))
    )
    installed = False
    try:
        server_version = str(_json(f"{ENDPOINT}/api/version")["version"])
        owned_process, version, process_id = False, server_version, None
    except (SetupError, KeyError):
        if _port_is_open():
            raise SetupError("Port 11434 is occupied by a non-Ollama local service.")
        if executable is None:
            executable = _install_ollama(deployment, env)
            installed = True
        owned_process, version, process_id = _wait_for_server(env, executable)
    tags = _json(f"{ENDPOINT}/api/tags").get("models", [])
    if not isinstance(tags, list):
        raise SetupError("Ollama returned an invalid model inventory.")
    model = next((item for item in tags if item.get("name") == MODEL), None)
    if model is None:
        if executable is None:
            raise SetupError(f"The exact Bonsai model is missing: {MODEL}")
        run([executable, "pull", MODEL], environment=env)
        tags = _json(f"{ENDPOINT}/api/tags").get("models", [])
        model = next((item for item in tags if item.get("name") == MODEL), None)
    if model is None:
        raise SetupError(f"Ollama did not make the required model available: {MODEL}")
    derived = next((item for item in tags if item.get("name") == EVAL_MODEL), None)
    if derived is None:
        if executable is None:
            raise SetupError(f"The LTCook 65536 context model is missing: {EVAL_MODEL}")
        modelfile = deployment / "bonsai-65536.Modelfile"
        modelfile.write_text(
            f"FROM {MODEL}\nPARAMETER num_ctx {CONTEXT_TOKENS}\n", encoding="utf-8"
        )
        run([executable, "create", EVAL_MODEL, "-f", str(modelfile)], environment=env)
        tags = _json(f"{ENDPOINT}/api/tags").get("models", [])
        derived = next((item for item in tags if item.get("name") == EVAL_MODEL), None)
    if derived is None:
        raise SetupError("Ollama did not create the LTCook 65536-token Bonsai model.")
    show = _json(f"{ENDPOINT}/api/show", data={"name": EVAL_MODEL, "verbose": False})
    if not _has_expected_context(show.get("modelfile")):
        raise SetupError("Ollama did not confirm the 65536-token Bonsai configuration.")
    summarizer = summarizer_readiness(environment=env, pull_with=executable)
    if not summarizer["ready"]:
        LOG.warning("Ollama summarizer is unavailable: %s", summarizer.get("error"))
    write_json(
        receipt_path,
        {
            "schema": 1,
            "endpoint": ENDPOINT,
            "executable": str(Path(executable).resolve()) if executable else None,
            "version": version,
            "model": MODEL,
            "model_digest": model.get("digest"),
            "eval_model": EVAL_MODEL,
            "eval_model_digest": derived.get("digest"),
            "context_tokens": CONTEXT_TOKENS,
            "summarizer": summarizer,
            "ollama_installed_by_ltcook": installed,
            "server_started_by_ltcook": owned_process,
            "server_process_id": process_id,
            "ready": True,
        },
    )
    return receipt_path
