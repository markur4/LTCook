"""Authenticated local runtime ownership, output capture, and terminal attachment."""

from __future__ import annotations

import codecs
import errno
import json
import os
import signal
import socket
import stat
import subprocess
import sys
import time
import urllib.error
import urllib.request
from collections.abc import Mapping
from dataclasses import dataclass, field
from pathlib import Path
from typing import BinaryIO, Literal
from urllib.parse import urlsplit
from uuid import UUID

from ltcook._browser import paseo_url


class RuntimeClientError(ValueError):
    """A local lifecycle operation could not be completed safely."""


@dataclass(frozen=True)
class RuntimeStatus:
    """Authenticated installation identity returned only by a ready owner."""

    team_selection: str
    instance_id: str
    deployment_root: str
    database_path: str
    paseo_listen: str
    backend_log_path: str | None
    paseo_log_path: str
    telemetry_log_path: str


@dataclass(frozen=True)
class StartedRuntime:
    """A spawned owner candidate and the beginning of its captured output."""

    process: subprocess.Popen[bytes]
    backend_offset: int


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise RuntimeClientError(
            "The local runtime API unexpectedly redirected a request."
        )


# > Loopback requests must not use ambient proxies or forward bearer tokens.
_HTTP = urllib.request.build_opener(urllib.request.ProxyHandler({}), _NoRedirect())


def runtime_api_url(address: str) -> str:
    """Validate a loopback listener without allowing another API destination."""
    if address.startswith("["):
        host, separator, port = address[1:].partition("]:")
    else:
        host, separator, port = address.rpartition(":")
        if ":" in host:
            separator = ""
    if (
        not separator
        or host not in {"127.0.0.1", "::1"}
        or not port.isascii()
        or not port.isdigit()
        or not 1 <= int(port) <= 65535
    ):
        raise RuntimeClientError(
            "LTCOOK_API_LISTEN must be a local loopback address with a valid port"
        )
    return f"http://[{host}]:{port}" if ":" in host else f"http://{host}:{port}"


def _request(environment: Mapping[str, str], route: str, body: object = None):
    token = environment.get("LTCOOK_API_TOKEN")
    if not token:
        raise RuntimeClientError(
            "LTCOOK_API_TOKEN is missing; re-run the LTCook installer to initialize credentials."
        )
    return urllib.request.Request(
        runtime_api_url(environment["LTCOOK_API_LISTEN"]) + route,
        data=None if body is None else json.dumps(body).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
        },
        method="GET" if body is None else "POST",
    )


def _canonical(path: str) -> str:
    return str(Path(path).expanduser().resolve())


def _status(
    payload: object,
    environment: Mapping[str, str],
    previous_instance_id: str | None = None,
) -> RuntimeStatus:
    if not isinstance(payload, dict):
        raise RuntimeClientError("Running LTCook runtime returned invalid status data.")
    names = (
        "teamSelection",
        "instanceId",
        "deploymentRoot",
        "databasePath",
        "paseoListen",
        "paseoLogPath",
        "telemetryLogPath",
    )
    if any(not isinstance(payload.get(key), str) or not payload[key] for key in names):
        raise RuntimeClientError(
            "Running LTCook runtime returned incompatible status; restart it through ltcook."
        )
    backend = payload.get("backendLogPath")
    if "backendLogPath" not in payload or (
        backend is not None and not isinstance(backend, str)
    ):
        raise RuntimeClientError(
            "Running LTCook runtime returned invalid backend log data."
        )
    try:
        UUID(payload["instanceId"])
        paseo_url(payload["paseoListen"])
    except ValueError as error:
        raise RuntimeClientError(
            "Running LTCook runtime returned invalid owner identity."
        ) from error
    deployment = payload["deploymentRoot"]
    database = payload["databasePath"]
    # > A pinned viewer/stop waiter ends on replacement without adopting its config.
    if previous_instance_id is None or payload["instanceId"] == previous_instance_id:
        if payload["teamSelection"] != environment["LTCOOK_TEAM"]:
            raise RuntimeClientError(
                "A runtime is already active with a different team selection."
            )
        if _canonical(deployment) != _canonical(environment["LTCOOK_DEPLOYMENT_DIR"]):
            raise RuntimeClientError(
                "The running runtime belongs to a different deployment."
            )
        expected_database = environment["LTCOOK_DATABASE"]
        if (database == ":memory:") != (expected_database == ":memory:") or (
            database != ":memory:"
            and _canonical(database) != _canonical(expected_database)
        ):
            raise RuntimeClientError(
                "The running runtime belongs to a different database."
            )
    for value in (
        deployment,
        payload["paseoLogPath"],
        payload["telemetryLogPath"],
        backend,
    ):
        if value is not None and (not value or not Path(value).is_absolute()):
            raise RuntimeClientError(
                "Running LTCook runtime returned a non-absolute owner path."
            )
    if backend is not None and _canonical(backend) != str(
        Path(_canonical(deployment)) / "logs" / "backend.log"
    ):
        raise RuntimeClientError(
            "Running LTCook runtime returned an unsafe backend log path."
        )
    return RuntimeStatus(
        payload["teamSelection"],
        payload["instanceId"],
        deployment,
        database,
        payload["paseoListen"],
        backend,
        payload["paseoLogPath"],
        payload["telemetryLogPath"],
    )


def _timeout_probe(environment: Mapping[str, str]) -> Literal["starting"] | None:
    """Distinguish an owned port from a free port that silently drops connects."""
    address = urlsplit(runtime_api_url(environment["LTCOOK_API_LISTEN"]))
    assert address.hostname is not None and address.port is not None
    family = socket.AF_INET6 if ":" in address.hostname else socket.AF_INET
    with socket.socket(family, socket.SOCK_STREAM) as candidate:
        if os.name == "nt":
            candidate.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        else:
            # > Ignore closed connections in TIME_WAIT, never an active listener.
            candidate.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            candidate.bind((address.hostname, address.port))
        except OSError:
            return "starting"
    return None


def probe_runtime(
    environment: Mapping[str, str],
    *,
    previous_instance_id: str | None = None,
) -> RuntimeStatus | Literal["starting"] | None:
    """Probe readiness; absence requires refusal or exclusive-bind confirmation."""
    request = _request(environment, "/v1/status")
    try:
        with _HTTP.open(request, timeout=1) as response:
            if response.status != 200:
                raise RuntimeClientError(
                    f"Running LTCook runtime returned HTTP {response.status}."
                )
            payload: object = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        if error.code == 503:
            return "starting"
        if error.code == 401:
            raise RuntimeClientError(
                "The configured runtime token was rejected by the running runtime."
            ) from error
        raise RuntimeClientError(
            f"Runtime status failed (HTTP {error.code})."
        ) from error
    except TimeoutError:
        return _timeout_probe(environment)
    except urllib.error.URLError as error:
        reason = error.reason
        if isinstance(reason, TimeoutError) or (
            isinstance(reason, OSError) and reason.errno == errno.ETIMEDOUT
        ):
            return _timeout_probe(environment)
        if isinstance(reason, OSError) and reason.errno == errno.ECONNREFUSED:
            return None
        raise RuntimeClientError(
            "Could not contact the local LTCook runtime API."
        ) from error
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise RuntimeClientError(
            "Running LTCook runtime returned malformed status JSON."
        ) from error
    except OSError as error:
        if error.errno == errno.ECONNREFUSED:
            return None
        if error.errno == errno.ETIMEDOUT:
            return _timeout_probe(environment)
        raise RuntimeClientError(
            "Could not read the local LTCook runtime API response."
        ) from error
    return _status(payload, environment, previous_instance_id)


def _probe_pinned(
    environment: Mapping[str, str], instance_id: str
) -> RuntimeStatus | Literal["starting"] | None:
    """Observe an existing owner while its HTTP listener may be closing."""
    try:
        return probe_runtime(environment, previous_instance_id=instance_id)
    except RuntimeClientError as error:
        cause = error.__cause__
        if isinstance(cause, urllib.error.URLError):
            cause = cause.reason
        # > Shutdown can reset an in-flight GET before the port refuses connections.
        if isinstance(cause, (ConnectionResetError, BrokenPipeError)):
            return "starting"
        raise


def _safe_path(path: Path) -> None:
    for parent in (*reversed(path.parents), path):
        try:
            mode = parent.lstat().st_mode
        except FileNotFoundError:
            continue
        if stat.S_ISLNK(mode) or (parent != path and not stat.S_ISDIR(mode)):
            raise RuntimeClientError(f"Refusing unsafe log path: {path}")
        if parent == path and not stat.S_ISREG(mode):
            raise RuntimeClientError(f"Refusing nonregular log file: {path}")


def _open_log(path: Path, *, append: bool = False) -> BinaryIO:
    _safe_path(path)
    flags = os.O_RDONLY
    if append:
        flags = os.O_WRONLY | os.O_APPEND | os.O_CREAT
    flags |= getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0)
    descriptor = os.open(path, flags, 0o600)
    try:
        if not stat.S_ISREG(os.fstat(descriptor).st_mode):
            raise RuntimeClientError(f"Refusing nonregular log file: {path}")
        if append and os.name == "posix":
            os.fchmod(descriptor, 0o600)
        return os.fdopen(descriptor, "ab" if append else "rb")
    except BaseException:
        os.close(descriptor)
        raise


def _backend_path(environment: Mapping[str, str]) -> Path:
    deployment = Path(environment["LTCOOK_DEPLOYMENT_DIR"]).expanduser().absolute()
    # > Check links before canonicalization so a linked output directory is not hidden.
    for directory in (deployment, deployment / "logs"):
        for parent in (*reversed(directory.parents), directory):
            try:
                mode = parent.lstat().st_mode
            except FileNotFoundError:
                continue
            if stat.S_ISLNK(mode) or not stat.S_ISDIR(mode):
                raise RuntimeClientError(
                    f"Refusing unsafe runtime log directory: {directory}"
                )
        directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        if os.name == "posix":
            directory.chmod(0o700)
    return deployment.resolve() / "logs" / "backend.log"


def start_runtime(
    environment: Mapping[str, str],
    *,
    workspace_root: Path | None,
    shell_environment: Mapping[str, str],
    detached: bool,
) -> StartedRuntime:
    """Spawn one owner candidate with durable output and original shell provenance."""
    native = Path(environment["LTCOOK_JS_ROOT"]) / "runtime" / "dist" / "main.js"
    node = environment["LTCOOK_NODE_EXECUTABLE"]
    if not Path(node).is_file() or not native.is_file():
        raise RuntimeClientError(
            "Runtime prerequisites are not prepared; re-run the LTCook installer to prepare prerequisites."
        )
    path = _backend_path(environment)
    child_environment = dict(environment)
    child_environment["LTCOOK_SHELL_PROVENANCE"] = json.dumps(
        dict(shell_environment), separators=(",", ":")
    )
    child_environment["LTCOOK_BACKEND_LOG_PATH"] = str(path)
    creationflags = 0
    if detached and os.name == "nt":
        creationflags = (
            subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP
        )
    with _open_log(path, append=True) as output:
        offset = os.fstat(output.fileno()).st_size
        process = subprocess.Popen(
            [node, str(native)],
            cwd=workspace_root,
            env=child_environment,
            stdin=subprocess.DEVNULL if detached else None,
            stdout=output,
            stderr=subprocess.STDOUT,
            close_fds=True,
            start_new_session=detached and os.name == "posix",
            creationflags=creationflags,
        )
    return StartedRuntime(process, offset)


def _startup_failure(environment: Mapping[str, str], child: StartedRuntime) -> str:
    path = Path(environment["LTCOOK_DEPLOYMENT_DIR"]).resolve() / "logs" / "backend.log"
    with _open_log(path) as output:
        output.seek(max(child.backend_offset, os.fstat(output.fileno()).st_size - 8192))
        detail = output.read().decode("utf-8", errors="replace").strip()
    return f"Runtime exited with status {child.process.returncode}. Logs: {path}" + (
        f"\n{detail}" if detail else ""
    )


def wait_for_runtime(
    environment: Mapping[str, str],
    child: StartedRuntime | None,
    *,
    timeout: float = 600,
) -> RuntimeStatus:
    """Wait for the authenticated owner, including a listener-race winner."""
    deadline = time.monotonic() + timeout
    log_path = (
        Path(environment["LTCOOK_DEPLOYMENT_DIR"]).resolve() / "logs" / "backend.log"
    )
    try:
        while True:
            if child is not None:
                code = child.process.poll()
                if code is not None and code != 75:
                    raise RuntimeClientError(_startup_failure(environment, child))
            status = probe_runtime(environment)
            if isinstance(status, RuntimeStatus):
                return status
            if time.monotonic() >= deadline:
                raise RuntimeClientError(
                    f"Runtime readiness timed out; an owner may still be starting. Logs: {log_path}"
                )
            time.sleep(0.2)
    except KeyboardInterrupt:
        print(
            f"Startup viewer detached; the runtime was left alone. Logs: {log_path}",
            file=sys.stderr,
        )
        raise


@dataclass
class _LogFollower:
    path: Path
    label: str
    offset: int | None = None
    stream: BinaryIO | None = None
    identity: tuple[int, int] | None = None
    decoder: codecs.IncrementalDecoder = field(
        default_factory=lambda: codecs.getincrementaldecoder("utf-8")("replace")
    )
    fragment: str = ""

    def _emit(self, text: str, *, final: bool = False) -> None:
        self.fragment += text
        while "\n" in self.fragment:
            line, self.fragment = self.fragment.split("\n", 1)
            print(f"[{self.label}] {line}", flush=True)
        if final and self.fragment:
            print(f"[{self.label}] {self.fragment}", flush=True)
            self.fragment = ""

    def _drain(self) -> None:
        assert self.stream is not None
        while chunk := self.stream.read(65536):
            self._emit(self.decoder.decode(chunk))

    def read(self) -> None:
        _safe_path(self.path)
        try:
            info = self.path.stat()
        except FileNotFoundError:
            # > A source absent at attachment starts at its beginning when created.
            if self.offset is None:
                self.offset = 0
            if self.stream is not None:
                self._drain()
            return
        identity = (info.st_dev, info.st_ino)
        if self.stream is not None and identity != self.identity:
            self._drain()
            self.close()
            self.offset = 0
        if self.stream is None:
            self.stream = _open_log(self.path)
            opened = os.fstat(self.stream.fileno())
            self.identity = (opened.st_dev, opened.st_ino)
            self.stream.seek(
                opened.st_size
                if self.offset is None
                else min(self.offset, opened.st_size)
            )
        elif info.st_size < self.stream.tell():
            self.stream.seek(0)
            self.decoder.reset()
            self.fragment = ""
        self._drain()

    def close(self) -> None:
        if self.stream is not None:
            self._emit(self.decoder.decode(b"", final=True), final=True)
            self.stream.close()
            self.stream = None
            self.decoder.reset()


def follow_runtime_logs(
    environment: Mapping[str, str],
    status: RuntimeStatus,
    *,
    child: StartedRuntime | None = None,
    stop_owned_on_interrupt: bool = False,
) -> int:
    """Attach private owner logs; Ctrl+C normally detaches only this viewer."""
    url = paseo_url(status.paseo_listen)
    if status.backend_log_path is None:
        raise RuntimeClientError(
            f"Restart this runtime through ltcook for log attachment. UI: {url}"
        )
    followers = [
        _LogFollower(
            Path(status.backend_log_path),
            "runtime",
            child.backend_offset if child else None,
        ),
        _LogFollower(Path(status.telemetry_log_path), "events"),
        _LogFollower(Path(status.paseo_log_path), "paseo"),
    ]
    try:
        for follower in followers:
            follower.read()
        print(
            f"Attached to LTCook {status.instance_id}. UI: {url}\nCtrl+C {'stops this owned runtime' if stop_owned_on_interrupt else 'detaches this terminal; ltcook stop stops the runtime'}.",
            flush=True,
        )
        next_probe = time.monotonic() + 1
        while True:
            for follower in followers:
                follower.read()
            if time.monotonic() >= next_probe:
                current = _probe_pinned(environment, status.instance_id)
                if current is None:
                    for follower in followers:
                        follower.read()
                    if child is not None and child.process.poll() not in {None, 75}:
                        return child.process.returncode or 0
                    return 0
                if (
                    isinstance(current, RuntimeStatus)
                    and current.instance_id != status.instance_id
                ):
                    for follower in followers:
                        follower.read()
                    return 0
                next_probe = time.monotonic() + 1
            time.sleep(0.1)
    except KeyboardInterrupt:
        if (
            stop_owned_on_interrupt
            and child is not None
            and child.process.poll() is None
        ):
            # > Windows delivers the real console Ctrl+C to the shared child already.
            if os.name == "posix":
                child.process.send_signal(signal.SIGINT)
            try:
                child.process.wait(timeout=30)
            except subprocess.TimeoutExpired as error:
                raise RuntimeClientError(
                    "The owned runtime did not stop after Ctrl+C; inspect its backend log."
                ) from error
        else:
            print("Detached; the shared runtime is still running.", file=sys.stderr)
        return 130
    finally:
        for follower in followers:
            follower.close()


def stop_runtime(environment: Mapping[str, str]) -> int:
    """Stop only the authenticated observed instance, never an arbitrary PID."""
    status = probe_runtime(environment)
    if status is None:
        print("LTCook runtime is not running.")
        return 0
    if status == "starting":
        raise RuntimeClientError(
            "The runtime is still starting or unresponsive; retry ltcook stop when ready."
        )
    request = _request(
        environment, "/v1/runtime/stop", {"instanceId": status.instance_id}
    )
    try:
        with _HTTP.open(request, timeout=1) as response:
            payload: object = json.loads(response.read().decode("utf-8"))
            if response.status != 202 or payload != {"stopping": True}:
                raise RuntimeClientError(
                    "The runtime returned an invalid stop acknowledgement."
                )
    except urllib.error.HTTPError as error:
        if error.code == 409:
            detail = (
                "The runtime instance changed before stop; no replacement was stopped."
            )
        elif error.code == 503:
            detail = "The runtime is starting or stopping; retry after it settles."
        elif error.code == 401:
            detail = "The configured runtime token was rejected for stop."
        else:
            detail = f"Runtime stop failed (HTTP {error.code})."
        raise RuntimeClientError(detail) from error
    except (
        OSError,
        urllib.error.URLError,
        UnicodeDecodeError,
        json.JSONDecodeError,
    ) as error:
        raise RuntimeClientError(
            "Could not confirm the runtime stop request."
        ) from error
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline:
        current = _probe_pinned(environment, status.instance_id)
        if current is None or (
            isinstance(current, RuntimeStatus)
            and current.instance_id != status.instance_id
        ):
            print("LTCook runtime stopped.")
            return 0
        time.sleep(0.2)
    raise RuntimeClientError(
        "Timed out waiting for the targeted runtime to stop; no process was force-killed."
    )
