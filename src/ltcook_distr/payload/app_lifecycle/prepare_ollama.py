"""Prepare LTCook's host-local Ollama service and bootstrap model."""

from __future__ import annotations

import json
import os
import platform
import shutil
import socket
import subprocess
import time
from pathlib import Path
from urllib.error import URLError
from urllib.request import Request, urlopen

from ._common import SetupError, download, no_links, run, write_json

MODEL = "SparkLLM/Spark-X2.6-4B:q8_0"
EVAL_MODEL = "ltcook-spark-x2.6-4b-q8_0-ctx8192:latest"
ENDPOINT = "http://127.0.0.1:11434"


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
    """Reuse/install Ollama, ensure Spark Q8_0, and record private readiness."""
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
            raise SetupError(f"The exact Spark model is missing: {MODEL}")
        run([executable, "pull", MODEL], environment=env)
        tags = _json(f"{ENDPOINT}/api/tags").get("models", [])
        model = next((item for item in tags if item.get("name") == MODEL), None)
    if model is None:
        raise SetupError(f"Ollama did not make the required model available: {MODEL}")
    derived = next((item for item in tags if item.get("name") == EVAL_MODEL), None)
    if derived is None:
        if executable is None:
            raise SetupError(f"The LTCook 8192 context model is missing: {EVAL_MODEL}")
        modelfile = deployment / "spark-8192.Modelfile"
        modelfile.write_text(
            f"FROM {MODEL}\nPARAMETER num_ctx 8192\n", encoding="utf-8"
        )
        run([executable, "create", EVAL_MODEL, "-f", str(modelfile)], environment=env)
        tags = _json(f"{ENDPOINT}/api/tags").get("models", [])
        derived = next((item for item in tags if item.get("name") == EVAL_MODEL), None)
    if derived is None:
        raise SetupError("Ollama did not create the LTCook 8192-token Spark model.")
    show = _json(f"{ENDPOINT}/api/show", data={"name": EVAL_MODEL, "verbose": False})
    if "PARAMETER num_ctx 8192" not in str(show.get("modelfile", "")):
        raise SetupError("Ollama did not confirm the 8192-token Spark allocation.")
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
            "context_tokens": 8192,
            "ollama_installed_by_ltcook": installed,
            "server_started_by_ltcook": owned_process,
            "server_process_id": process_id,
            "ready": True,
        },
    )
    return receipt_path
