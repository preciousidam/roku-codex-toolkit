#!/usr/bin/env python3
"""Small, dependency-free Roku development-device operator."""

from __future__ import annotations

import argparse
import ipaddress
import math
import os
import select
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
import xml.dom.minidom
from pathlib import Path
from typing import Optional


PLUGIN_ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(PLUGIN_ROOT / "scripts"))
from roku_config import keychain_password, resolve_target  # noqa: E402


DEFAULT_TIMEOUT = 10.0
MAX_ECP_TIMEOUT = 60.0
DEVELOPER_MODE_TIMEOUT = 120.0
MAX_LOG_SECONDS = 120.0
KEY_ALIASES = {"ok": "Select"}
ECP_QUERY_ROOTS = {
    "/query/device-info": "device-info",
    "/query/apps": "apps",
    "/query/active-app": "active-app",
    "/query/media-player": "player",
}
ECP_OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def target_host(value: Optional[str]) -> str:
    try:
        return resolve_target(value)
    except (ValueError, RuntimeError) as error:
        raise SystemExit(f"{error} Configure it with the Roku Device Toolkit setup command.") from error


def request(host: str, method: str, path: str, timeout: float) -> bytes:
    req = urllib.request.Request(f"http://{host}:8060{path}", method=method)
    try:
        with ECP_OPENER.open(req, timeout=timeout) as response:
            return response.read()
    except urllib.error.HTTPError as error:
        raise SystemExit(f"Roku ECP returned HTTP {error.code} for {path}.") from error
    except urllib.error.URLError as error:
        raise SystemExit(f"Unable to reach Roku ECP at {host}:8060: {error.reason}") from error


def pretty_xml(payload: bytes, expected_root: str) -> str:
    try:
        document = xml.dom.minidom.parseString(payload)
    except Exception as error:
        raise SystemExit("Roku ECP query returned malformed XML.") from error
    if document.documentElement.tagName != expected_root:
        raise SystemExit(
            f"Roku ECP query returned unexpected root element {document.documentElement.tagName!r}; "
            f"expected {expected_root!r}."
        )
    return document.toprettyxml(indent="  ").strip()


def query(host: str, endpoint: str, timeout: float) -> None:
    print(pretty_xml(request(host, "GET", endpoint, timeout), ECP_QUERY_ROOTS[endpoint]))


def keypress(host: str, key: str, timeout: float) -> None:
    normalized = KEY_ALIASES.get(key.lower(), key)
    encoded = urllib.parse.quote(normalized, safe="")
    request(host, "POST", f"/keypress/{encoded}", timeout)


def require_password() -> str:
    password = keychain_password()
    if not password:
        raise SystemExit("Configure the Roku developer password in macOS Keychain or set ROKU_DEV_PASSWORD.")
    return password


def trusted_developer_host(host: str) -> str:
    try:
        addresses = {ipaddress.ip_address(host)}
    except ValueError:
        try:
            addresses = {
                ipaddress.ip_address(item[4][0])
                for item in socket.getaddrinfo(host, 80, family=socket.AF_INET, type=socket.SOCK_STREAM)
            }
        except socket.gaierror as error:
            raise SystemExit(f"Unable to resolve Roku developer target {host}: {error}") from error
    trusted = [
        address for address in addresses
        if not address.is_multicast
        and not address.is_reserved
        and not address.is_unspecified
        and (address.is_private or address.is_link_local or address.is_loopback)
    ]
    if not addresses or len(trusted) != len(addresses):
        raise SystemExit(
            "Developer-mode authentication is restricted to private, link-local, or loopback Roku targets."
        )
    return str(sorted(trusted, key=str)[0])


def curl_digest(host: str, path: str, extra: list[str], output: Optional[Path] = None) -> str:
    trusted_host = trusted_developer_host(host)
    password = require_password()
    command = [
        "curl", "--fail", "--silent", "--show-error", "--digest", "--noproxy", "*",
        "--connect-timeout", str(DEFAULT_TIMEOUT), "--max-time", str(DEVELOPER_MODE_TIMEOUT),
        "--config", "-", *extra, f"http://{trusted_host}{path}",
    ]
    if output is not None:
        command.extend(["--output", str(output)])
    try:
        escaped_password = password.replace("\\", "\\\\").replace('"', '\\"')
        completed = subprocess.run(
            command,
            input=f'user = "rokudev:{escaped_password}"\n',
            text=True,
            capture_output=True,
            check=True,
        )
        return completed.stdout
    except FileNotFoundError as error:
        raise SystemExit("curl is required for developer-mode operations.") from error
    except subprocess.CalledProcessError as error:
        raise SystemExit(f"Roku developer-mode request failed for {path}.") from error


def take_screenshot(host: str, output: Path) -> None:
    if output.suffix.lower() not in {".jpg", ".jpeg", ".png"}:
        raise SystemExit("Screenshot output must end in .jpg, .jpeg, or .png.")
    if not output.parent.exists():
        raise SystemExit(f"Output directory does not exist: {output.parent}")
    if output.is_dir():
        raise SystemExit(f"Screenshot output must be a file path, not a directory: {output}")
    curl_digest(host, "/plugin_inspect", ["--form", "mysubmit=Screenshot"])
    candidates = ["/pkgs/dev.png"] if output.suffix.lower() == ".png" else ["/pkgs/dev.jpg"]
    descriptor, temporary_name = tempfile.mkstemp(prefix=f".{output.name}.", dir=output.parent)
    os.close(descriptor)
    temporary_path = Path(temporary_name)
    try:
        for candidate in candidates:
            try:
                curl_digest(host, candidate, [], temporary_path)
                header = temporary_path.read_bytes()[:8]
                expected_image = (
                    header.startswith(b"\x89PNG\r\n\x1a\n")
                    if output.suffix.lower() == ".png"
                    else header.startswith(b"\xff\xd8\xff")
                )
                if expected_image:
                    os.chmod(temporary_path, 0o600)
                    os.replace(temporary_path, output)
                    print(output.resolve())
                    return
            except SystemExit:
                continue
    finally:
        temporary_path.unlink(missing_ok=True)
    raise SystemExit("Screenshot was requested, but no valid image could be downloaded.")


def sideload(host: str, archive: Path, confirmed: bool) -> None:
    if not confirmed:
        raise SystemExit("Sideloading replaces the current dev app; pass --yes after confirming scope.")
    if not archive.is_file() or archive.suffix.lower() != ".zip":
        raise SystemExit(f"Expected an existing Roku ZIP archive: {archive}")
    response = curl_digest(
        host,
        "/plugin_install",
        ["--form", "mysubmit=Install", "--form", f"archive=@{archive.resolve()}"],
    )
    if "install success" not in response.lower():
        summary = " ".join(response.replace("<", " <").split())[:300]
        raise SystemExit(f"Roku rejected or did not confirm the sideload: {summary or 'empty installer response'}")
    print(f"Sideload installed successfully: {archive.resolve()}")


def write_private_text(path: Path, value: str) -> None:
    descriptor, temporary_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    temporary_path = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            handle.write(value)
        os.chmod(temporary_path, 0o600)
        os.replace(temporary_path, path)
    finally:
        temporary_path.unlink(missing_ok=True)


def collect_logs(host: str, seconds: float, output: Optional[Path]) -> None:
    temporary_path: Optional[Path] = None
    output_handle = None
    if output is not None:
        if not output.parent.exists():
            raise SystemExit(f"Output directory does not exist: {output.parent}")
        if output.is_dir():
            raise SystemExit(f"Log output must be a file path, not a directory: {output}")
        descriptor, temporary_name = tempfile.mkstemp(prefix=f".{output.name}.", dir=output.parent)
        temporary_path = Path(temporary_name)
        output_handle = os.fdopen(descriptor, "wb")
    disconnected_early = False
    capture_error: Optional[OSError] = None
    bytes_written = 0
    try:
        with socket.create_connection((host, 8085), timeout=DEFAULT_TIMEOUT) as connection:
            connection.setblocking(False)
            deadline = time.monotonic() + seconds
            while time.monotonic() < deadline:
                remaining = max(0.0, deadline - time.monotonic())
                readable, _, _ = select.select([connection], [], [], min(0.5, remaining))
                if not readable:
                    continue
                data = connection.recv(65536)
                if not data:
                    disconnected_early = time.monotonic() < deadline
                    break
                if output_handle is None:
                    sys.stdout.buffer.write(data)
                    sys.stdout.buffer.flush()
                else:
                    output_handle.write(data)
                bytes_written += len(data)
    except OSError as error:
        capture_error = error
    finally:
        if output_handle is not None:
            output_handle.close()
    if capture_error is not None:
        if temporary_path is not None:
            if bytes_written:
                os.chmod(temporary_path, 0o600)
                os.replace(temporary_path, output)
                print(output.resolve())
            else:
                temporary_path.unlink(missing_ok=True)
        detail = " Partial logs were preserved." if bytes_written else ""
        raise SystemExit(f"Unable to read BrightScript console at {host}:8085: {capture_error}.{detail}") from capture_error
    if temporary_path is not None:
        if disconnected_early and bytes_written == 0:
            temporary_path.unlink(missing_ok=True)
        else:
            os.chmod(temporary_path, 0o600)
            os.replace(temporary_path, output)
            print(output.resolve())
    if disconnected_early:
        detail = "partial logs were preserved" if bytes_written else "no logs were captured; any prior output was preserved"
        raise SystemExit(
            "BrightScript console disconnected before the requested capture interval completed; "
            f"{detail}."
        )


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(description=__doc__)
    result.add_argument("--host", help="Bare Roku IP/hostname; defaults to ROKU_DEV_TARGET")
    result.add_argument("--timeout", type=float, default=DEFAULT_TIMEOUT, help="ECP timeout in seconds")
    commands = result.add_subparsers(dest="command", required=True)
    for name, help_text in (
        ("info", "Query device information"),
        ("apps", "List installed apps"),
        ("active-app", "Query the active app"),
        ("player", "Query media-player state"),
    ):
        commands.add_parser(name, help=help_text)

    press = commands.add_parser("press", help="Send one or more remote keys")
    press.add_argument("keys", nargs="+", help="Keys such as left, down, ok, back, home")
    press.add_argument("--delay", type=float, default=0.35, help="Delay between keys")

    text_command = commands.add_parser("text", help="Enter text through ECP Lit_ keypresses")
    text_command.add_argument("value")
    text_command.add_argument("--delay", type=float, default=0.05, help="Delay between characters")

    launch = commands.add_parser("launch", help="Launch or deep-link an app")
    launch.add_argument("channel_id", help="Use dev for the sideloaded app")
    launch.add_argument("--content-id")
    launch.add_argument("--media-type")

    screenshot = commands.add_parser("screenshot", help="Capture the visible dev-app UI")
    screenshot.add_argument("--output", type=Path, default=Path("roku-screenshot.jpg"))

    install = commands.add_parser("sideload", help="Replace the current dev app with a ZIP")
    install.add_argument("archive", type=Path)
    install.add_argument("--yes", action="store_true", help="Confirm replacement of the dev app")

    logs = commands.add_parser("logs", help="Read the BrightScript console")
    logs.add_argument("--seconds", type=float, default=10.0)
    logs.add_argument("--output", type=Path)
    return result


def main() -> None:
    args = parser().parse_args()
    if not math.isfinite(args.timeout) or not 0.1 <= args.timeout <= MAX_ECP_TIMEOUT:
        raise SystemExit(f"ECP timeout must be between 0.1 and {MAX_ECP_TIMEOUT:g} seconds.")
    host = target_host(args.host)
    endpoints = {
        "info": "/query/device-info",
        "apps": "/query/apps",
        "active-app": "/query/active-app",
        "player": "/query/media-player",
    }
    if args.command in endpoints:
        query(host, endpoints[args.command], args.timeout)
    elif args.command == "press":
        if not math.isfinite(args.delay) or not 0 <= args.delay <= 10:
            raise SystemExit("Key delay must be between 0 and 10 seconds.")
        for index, key in enumerate(args.keys):
            keypress(host, key, args.timeout)
            if index + 1 < len(args.keys):
                time.sleep(max(0.0, args.delay))
    elif args.command == "text":
        if not math.isfinite(args.delay) or not 0 <= args.delay <= 10:
            raise SystemExit("Text delay must be between 0 and 10 seconds.")
        for index, character in enumerate(args.value):
            keypress(host, f"Lit_{character}", args.timeout)
            if index + 1 < len(args.value):
                time.sleep(max(0.0, args.delay))
    elif args.command == "launch":
        query_values = {}
        if args.content_id:
            query_values["contentId"] = args.content_id
        if args.media_type:
            query_values["mediaType"] = args.media_type
        suffix = urllib.parse.urlencode(query_values)
        path = f"/launch/{urllib.parse.quote(args.channel_id, safe='')}"
        if suffix:
            path += f"?{suffix}"
        request(host, "POST", path, args.timeout)
    elif args.command == "screenshot":
        take_screenshot(host, args.output)
    elif args.command == "sideload":
        sideload(host, args.archive, args.yes)
    elif args.command == "logs":
        if not math.isfinite(args.seconds) or not 0.1 <= args.seconds <= MAX_LOG_SECONDS:
            raise SystemExit(f"Log duration must be between 0.1 and {MAX_LOG_SECONDS:g} seconds.")
        collect_logs(host, args.seconds, args.output)


if __name__ == "__main__":
    main()
