#!/usr/bin/env python3
"""Shared configuration and macOS Keychain access for the Roku toolkit."""

from __future__ import annotations

import argparse
import getpass
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any, Optional


CONFIG_ENV = "ROKU_TOOLKIT_CONFIG"
DEFAULT_CONFIG = Path("~/.config/roku-device-toolkit/config.json").expanduser()
KEYCHAIN_SERVICE = "roku-device-toolkit"
KEYCHAIN_ACCOUNT = "rokudev"
KEYCHAIN_TIMEOUT_SECONDS = 15


def ensure_private_directory(path: Path, harden_existing: bool = False) -> None:
    """Create missing directories privately without changing an existing parent."""
    if path.is_symlink():
        raise RuntimeError(f"Roku configuration directory must not be a symlink: {path}")
    missing = []
    current = path
    while not current.exists():
        if current.parent == current:
            raise RuntimeError(
                f"Unable to reach an existing parent for Roku configuration directory: {path}"
            )
        missing.append(current)
        current = current.parent
    if not current.is_dir():
        raise RuntimeError(f"Roku configuration parent is not a directory: {current}")
    path.mkdir(parents=True, exist_ok=True, mode=0o700)
    if os.name == "posix":
        for directory in missing:
            os.chmod(directory, 0o700)
        if harden_existing and not missing:
            os.chmod(path, 0o700)


def config_path() -> Path:
    configured_override = os.environ.get(CONFIG_ENV, "").strip()
    if not configured_override:
        return DEFAULT_CONFIG
    path = Path(configured_override).expanduser()
    if not path.is_absolute():
        raise RuntimeError(f"{CONFIG_ENV} must be an absolute path.")
    return path


def validate_target(value: str) -> str:
    target = value.strip()
    if not target:
        raise ValueError("Roku target cannot be empty.")
    if any(part in target for part in (":", "/", "?", "#", "@")):
        raise ValueError("The Roku target must be a bare IP address or hostname without a port.")
    return target


def load_config() -> dict[str, Any]:
    path = effective_config_path()
    if not path.exists():
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise RuntimeError(f"Unable to read Roku configuration at {path}: {error}") from error
    if not isinstance(data, dict):
        raise RuntimeError(f"Roku configuration must contain a JSON object: {path}")
    return data


def effective_config_path() -> Path:
    return config_path()


def save_target(target: str) -> Path:
    value = validate_target(target)
    path = config_path()
    ensure_private_directory(
        path.parent,
        harden_existing=not bool(os.environ.get(CONFIG_ENV, "").strip()),
    )
    data = load_config()
    data["target"] = value
    descriptor, temporary_name = tempfile.mkstemp(prefix="config-", suffix=".json", dir=path.parent)
    temporary = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            json.dump(data, handle, indent=2)
            handle.write("\n")
        os.chmod(temporary, 0o600)
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)
    return path


def resolve_target(explicit: Optional[str] = None) -> str:
    if explicit is not None:
        if not isinstance(explicit, str) or not explicit.strip():
            raise ValueError("Explicit Roku target must be a non-empty string.")
        candidate = explicit
    else:
        environment_target = os.environ.get("ROKU_DEV_TARGET", "").strip()
        saved_target = load_config().get("target")
        if not environment_target and saved_target is not None and not isinstance(saved_target, str):
            raise ValueError("Saved Roku target must be a non-empty string.")
        candidate = environment_target or saved_target or ""
    return validate_target(candidate)


def keychain_password() -> str:
    if os.environ.get("ROKU_DEV_PASSWORD"):
        return os.environ["ROKU_DEV_PASSWORD"]
    if sys.platform != "darwin":
        return ""
    try:
        completed = subprocess.run(
            ["security", "find-generic-password", "-a", KEYCHAIN_ACCOUNT, "-s", KEYCHAIN_SERVICE, "-w"],
            text=True,
            capture_output=True,
            check=False,
            timeout=KEYCHAIN_TIMEOUT_SECONDS,
        )
    except (OSError, subprocess.TimeoutExpired):
        return ""
    if completed.returncode == 0:
        return completed.stdout.rstrip("\n")
    return ""


def store_keychain_password(password: str) -> None:
    if sys.platform != "darwin":
        raise RuntimeError("Secure password setup currently requires macOS Keychain.")
    if not password:
        raise ValueError("Developer password cannot be empty.")
    try:
        completed = subprocess.run(
            [
                "security", "add-generic-password", "-U", "-a", KEYCHAIN_ACCOUNT,
                "-s", KEYCHAIN_SERVICE, "-l", "Roku developer password", "-w",
            ],
            input=password + "\n",
            text=True,
            capture_output=True,
            check=False,
            timeout=KEYCHAIN_TIMEOUT_SECONDS,
        )
    except (OSError, subprocess.TimeoutExpired) as error:
        raise RuntimeError("Unable to store the password in macOS Keychain.") from error
    if completed.returncode != 0:
        raise RuntimeError(completed.stderr.strip() or "Unable to store the password in macOS Keychain.")


def configuration_status() -> dict[str, Any]:
    data = load_config()
    environment_target = os.environ.get("ROKU_DEV_TARGET", "").strip()
    environment_password = bool(os.environ.get("ROKU_DEV_PASSWORD"))
    password_available = environment_password or bool(keychain_password())
    return {
        "config_path": str(effective_config_path()),
        "target": environment_target or data.get("target"),
        "target_source": "environment" if environment_target else ("config" if data.get("target") else None),
        "password_available": password_available,
        "password_source": "environment" if environment_password else ("keychain" if password_available else None),
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Configure a Roku development device.")
    parser.add_argument("--target", help="Bare Roku IP address or hostname; prompts when omitted")
    parser.add_argument("--skip-password", action="store_true", help="Configure only the target")
    parser.add_argument("--status", action="store_true", help="Show configuration without revealing the password")
    args = parser.parse_args()
    if args.status:
        print(json.dumps(configuration_status(), indent=2))
        return
    target = args.target or input("Roku IP address or hostname: ")
    path = save_target(target)
    if not args.skip_password and sys.platform == "darwin":
        password = getpass.getpass("Roku developer password (stored in macOS Keychain): ")
        store_keychain_password(password)
    elif not args.skip_password and os.environ.get("ROKU_DEV_PASSWORD"):
        print("Using ROKU_DEV_PASSWORD from the environment; no password was stored.")
    elif not args.skip_password:
        print(
            "Password storage was skipped because macOS Keychain is unavailable. "
            "Set ROKU_DEV_PASSWORD before using developer-mode tools.",
            file=sys.stderr,
        )
    print(f"Roku configuration saved to {path}")


if __name__ == "__main__":
    main()
