"""Validate Paseo addresses and request the host OS default browser."""

import ipaddress
import os
import platform
import re
import shutil
import subprocess
import sys

_HOST_LABEL = re.compile(r"[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?")


def paseo_url(listen: str) -> str:
    """Convert a Paseo bind address into an unauthenticated browser URL.

    :param listen: A hostname or IP address with an explicit port; bracket IPv6.
    :return: An HTTP URL, with wildcard bind addresses mapped to loopback.
    :raises ValueError: If the address is not a valid host and port.
    """
    invalid = "Paseo listener must be a host and port, such as 127.0.0.1:6767."
    if not listen or any(character.isspace() for character in listen):
        raise ValueError(invalid)
    if any(character in listen for character in "/\\@?#%"):
        raise ValueError(invalid)
    if listen.startswith("["):
        match = re.fullmatch(r"\[([^\[\]]+)\]:([0-9]+)", listen)
        if match is None:
            raise ValueError(invalid)
        host, port_text = match.groups()
        try:
            address = ipaddress.IPv6Address(host)
        except ipaddress.AddressValueError as error:
            raise ValueError(invalid) from error
        browser_host = "[::1]" if address.is_unspecified else f"[{host}]"
    else:
        match = re.fullmatch(r"([^:\[\]]+):([0-9]+)", listen)
        if match is None:
            raise ValueError(invalid)
        host, port_text = match.groups()
        if all(character in "0123456789." for character in host):
            try:
                ipaddress.IPv4Address(host)
            except ipaddress.AddressValueError as error:
                raise ValueError(invalid) from error
        elif len(host) > 253 or not all(
            _HOST_LABEL.fullmatch(label) for label in host.removesuffix(".").split(".")
        ):
            raise ValueError(invalid)
        browser_host = "127.0.0.1" if host == "0.0.0.0" else host
    if len(port_text) > 5 or not 1 <= int(port_text) <= 65535:
        raise ValueError(invalid)
    return f"http://{browser_host}:{int(port_text)}/"


def open_paseo_url(url: str) -> None:
    """Request navigation in the host's default browser without a shell.

    WSL always uses the Windows Explorer bridge, never a Linux browser. Successful
    dispatch means only that the OS accepted an opening request, not that a tab
    was focused or rendered.

    :param url: An ordinary HTTP URL returned by :func:`paseo_url`.
    :raises ValueError: If the URL is not an unauthenticated Paseo address.
    :raises RuntimeError: If the platform browser handler cannot be started.
    """
    if not url.startswith("http://") or not url.endswith("/"):
        raise ValueError("Paseo browser URL must be an ordinary host-only HTTP URL.")
    if paseo_url(url[len("http://") : -1]) != url:
        raise ValueError("Paseo browser URL must be an ordinary host-only HTTP URL.")

    is_wsl = bool(os.environ.get("WSL_INTEROP") or os.environ.get("WSL_DISTRO_NAME"))
    if sys.platform.startswith("linux"):
        is_wsl = is_wsl or "microsoft" in platform.release().lower()
    if is_wsl:
        handler = shutil.which("explorer.exe")
        if handler is None:
            raise RuntimeError(
                "Cannot open the Windows browser: explorer.exe is unavailable. "
                "Enable WSL Windows interop or open the Paseo URL manually."
            )
    elif sys.platform == "win32":
        try:
            os.startfile(url)
        except (OSError, NotImplementedError) as error:
            raise RuntimeError(
                "Cannot open the Windows default browser; open the Paseo URL manually."
            ) from error
        return
    else:
        command = "open" if sys.platform == "darwin" else "xdg-open"
        handler = shutil.which(command)
        if handler is None:
            raise RuntimeError(
                f"Cannot open the default browser: {command} is unavailable; "
                "install a URL handler or open the Paseo URL manually."
            )
    try:
        subprocess.Popen(
            [handler, url],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            close_fds=True,
        )
    except OSError as error:
        raise RuntimeError(
            "Cannot start the host browser handler; open the Paseo URL manually."
        ) from error
