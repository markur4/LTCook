"""Host URL formatting and browser dispatch stay within the OS boundary."""

import subprocess

import pytest

from ltcook import _browser


@pytest.mark.parametrize(
    ("listen", "expected"),
    [
        ("127.0.0.1:6767", "http://127.0.0.1:6767/"),
        ("0.0.0.0:6767", "http://127.0.0.1:6767/"),
        ("localhost:1", "http://localhost:1/"),
        ("[::1]:65535", "http://[::1]:65535/"),
        ("[::]:8080", "http://[::1]:8080/"),
        ("[2001:db8::5]:8080", "http://[2001:db8::5]:8080/"),
    ],
)
def test_paseo_url_formats_host_and_port(listen, expected):
    assert _browser.paseo_url(listen) == expected


@pytest.mark.parametrize(
    "listen",
    [
        "",
        "localhost",
        "http://localhost:6767",
        "user@localhost:6767",
        "localhost:6767/path",
        "localhost:6767?token=x",
        "localhost:6767#fragment",
        "localhost:0",
        "localhost:65536",
        "localhost:999999",
        "localhost:abc",
        "localhost:6767:2",
        "[::1]",
        "[not-ipv6]:6767",
        "[::1]:6767/path",
        "999.1.1.1:6767",
        "bad host:6767",
        "-bad.example:6767",
    ],
)
def test_paseo_url_rejects_non_host_addresses(listen):
    with pytest.raises(ValueError):
        _browser.paseo_url(listen)


def test_open_wsl_uses_explorer_even_when_linux_handler_exists(monkeypatch):
    calls = []
    monkeypatch.setenv("WSL_INTEROP", "/run/interop")
    monkeypatch.setattr(_browser.sys, "platform", "linux")
    monkeypatch.setattr(_browser.shutil, "which", lambda command: f"/bin/{command}")
    monkeypatch.setattr(
        _browser.subprocess,
        "Popen",
        lambda *args, **kwargs: calls.append((args, kwargs)),
    )

    _browser.open_paseo_url("http://127.0.0.1:6767/")

    assert calls[0][0] == (["/bin/explorer.exe", "http://127.0.0.1:6767/"],)
    assert calls[0][1]["close_fds"] is True


def test_open_wsl_missing_explorer_does_not_fallback(monkeypatch):
    handlers = []
    monkeypatch.setenv("WSL_DISTRO_NAME", "Ubuntu")
    monkeypatch.setattr(_browser.sys, "platform", "linux")
    monkeypatch.setattr(
        _browser.shutil,
        "which",
        lambda command: "/bin/xdg-open" if command == "xdg-open" else None,
    )
    monkeypatch.setattr(
        _browser.subprocess, "Popen", lambda *args, **kwargs: handlers.append(args)
    )

    with pytest.raises(RuntimeError, match="explorer.exe"):
        _browser.open_paseo_url("http://127.0.0.1:6767/")
    assert handlers == []


def test_open_detects_wsl_from_kernel_release(monkeypatch):
    calls = []
    monkeypatch.delenv("WSL_INTEROP", raising=False)
    monkeypatch.delenv("WSL_DISTRO_NAME", raising=False)
    monkeypatch.setattr(_browser.sys, "platform", "linux")
    monkeypatch.setattr(
        _browser.platform, "release", lambda: "6.6.1-microsoft-standard"
    )
    monkeypatch.setattr(
        _browser.shutil,
        "which",
        lambda _command: "/mnt/c/Windows/explorer.exe",
    )
    monkeypatch.setattr(
        _browser.subprocess,
        "Popen",
        lambda *args, **kwargs: calls.append(args),
    )

    _browser.open_paseo_url("http://127.0.0.1:6767/")

    assert calls == [(["/mnt/c/Windows/explorer.exe", "http://127.0.0.1:6767/"],)]


def test_linux_uses_argument_vector_without_shell(monkeypatch):
    calls = []
    monkeypatch.delenv("WSL_INTEROP", raising=False)
    monkeypatch.delenv("WSL_DISTRO_NAME", raising=False)
    monkeypatch.setattr(_browser.platform, "release", lambda: "6.6.1-linux")
    monkeypatch.setattr(_browser.sys, "platform", "linux")
    monkeypatch.setattr(_browser.shutil, "which", lambda _command: "/usr/bin/xdg-open")
    monkeypatch.setattr(
        _browser.subprocess,
        "Popen",
        lambda *args, **kwargs: calls.append((args, kwargs)),
    )

    _browser.open_paseo_url("http://127.0.0.1:6767/")

    assert calls[0][0] == (["/usr/bin/xdg-open", "http://127.0.0.1:6767/"],)
    assert calls[0][1]["stdin"] is subprocess.DEVNULL
    assert calls[0][1]["stdout"] is subprocess.DEVNULL
    assert calls[0][1]["stderr"] is subprocess.DEVNULL
    assert calls[0][1]["close_fds"] is True


def test_macos_uses_open_handler(monkeypatch):
    calls = []
    monkeypatch.delenv("WSL_INTEROP", raising=False)
    monkeypatch.delenv("WSL_DISTRO_NAME", raising=False)
    monkeypatch.setattr(_browser.sys, "platform", "darwin")
    monkeypatch.setattr(_browser.shutil, "which", lambda _command: "/usr/bin/open")
    monkeypatch.setattr(
        _browser.subprocess,
        "Popen",
        lambda *args, **kwargs: calls.append(args),
    )

    _browser.open_paseo_url("http://localhost:6767/")

    assert calls == [(["/usr/bin/open", "http://localhost:6767/"],)]


def test_windows_uses_startfile(monkeypatch):
    calls = []
    monkeypatch.delenv("WSL_INTEROP", raising=False)
    monkeypatch.delenv("WSL_DISTRO_NAME", raising=False)
    monkeypatch.setattr(_browser.sys, "platform", "win32")
    monkeypatch.setattr(
        _browser.os, "startfile", lambda url: calls.append(url), raising=False
    )

    _browser.open_paseo_url("http://localhost:6767/")

    assert calls == ["http://localhost:6767/"]


@pytest.mark.parametrize(
    "url",
    [
        "http://user@localhost:6767/",
        "http://localhost:6767/path/",
        "https://localhost:6767/",
    ],
)
def test_open_rejects_nonordinary_urls(url):
    with pytest.raises(ValueError):
        _browser.open_paseo_url(url)


def test_open_reports_missing_handler(monkeypatch):
    monkeypatch.delenv("WSL_INTEROP", raising=False)
    monkeypatch.delenv("WSL_DISTRO_NAME", raising=False)
    monkeypatch.setattr(_browser.platform, "release", lambda: "Linux")
    monkeypatch.setattr(_browser.sys, "platform", "linux")
    monkeypatch.setattr(_browser.shutil, "which", lambda _command: None)

    with pytest.raises(RuntimeError, match="xdg-open"):
        _browser.open_paseo_url("http://localhost:6767/")


def test_open_reports_handler_spawn_failure(monkeypatch):
    monkeypatch.delenv("WSL_INTEROP", raising=False)
    monkeypatch.delenv("WSL_DISTRO_NAME", raising=False)
    monkeypatch.setattr(_browser.platform, "release", lambda: "Linux")
    monkeypatch.setattr(_browser.sys, "platform", "linux")
    monkeypatch.setattr(_browser.shutil, "which", lambda _command: "/usr/bin/xdg-open")

    def fail_to_spawn(*_args, **_kwargs):
        raise OSError("permission denied")

    monkeypatch.setattr(_browser.subprocess, "Popen", fail_to_spawn)
    with pytest.raises(RuntimeError, match="start the host browser handler"):
        _browser.open_paseo_url("http://localhost:6767/")
