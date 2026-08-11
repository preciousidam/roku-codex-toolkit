#!/usr/bin/env python3
"""Dependency-free MCP server for operating a Roku development device."""

from __future__ import annotations

import json
import math
import os
import signal
import socket
import subprocess
import sys
import tempfile
import threading
import traceback
from contextlib import nullcontext
from contextvars import ContextVar
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any, Optional


ROOT = Path(__file__).resolve().parents[1]
DEVICE_TOOL = ROOT / "skills/roku-device-operator/scripts/roku_device.py"
FLOW_TOOL = ROOT / "skills/roku-flow-verifier/scripts/run_flow.py"
sys.path.insert(0, str(ROOT / "scripts"))
from roku_config import configuration_status, resolve_target, save_target  # noqa: E402

PROTOCOL_VERSION = "2025-06-18"
MAX_LOG_SECONDS = 120.0
FLOW_STEP_TIMEOUT = 130.0
ECP_REQUEST_TIMEOUT = 10.0
DEVELOPER_MODE_REQUEST_TIMEOUT = 120.0
SCREENSHOT_TIMEOUT = DEVELOPER_MODE_REQUEST_TIMEOUT * 2 + 20.0
SIDELOAD_TIMEOUT = DEVELOPER_MODE_REQUEST_TIMEOUT + 20.0
WINDOWS_TERMINATION_TIMEOUT = 10.0
CURRENT_REQUEST_ID: ContextVar[Any] = ContextVar("current_request_id", default=None)
RESOLVED_DEVICE_TARGET: ContextVar[Optional[str]] = ContextVar("resolved_device_target", default=None)
IN_FLIGHT: dict[Any, subprocess.Popen[str]] = {}
PENDING_REQUESTS: set[Any] = set()
CANCELLED_REQUESTS: set[Any] = set()
IN_FLIGHT_LOCK = threading.Lock()
DEVICE_MUTATION_NAMES = {"launch", "press", "enter_text", "take_screenshot", "sideload", "run_flow"}
DEVICE_MUTATION_LOCKS: dict[str, threading.Lock] = {}
DEVICE_MUTATION_LOCKS_LOCK = threading.Lock()
SHUTDOWN_REQUESTED = threading.Event()


class RequestCancelled(Exception):
    pass


class CommandFailure(RuntimeError):
    def __init__(self, message: str, result: dict[str, Any]):
        super().__init__(message)
        self.result = result


def valid_request_id(value: Any) -> bool:
    return not isinstance(value, bool) and isinstance(value, (str, int))


def canonical_device_identity(target: str) -> str:
    try:
        addresses = {
            address[4][0].casefold()
            for address in socket.getaddrinfo(
                target, None, family=socket.AF_INET, type=socket.SOCK_STREAM
            )
        }
    except socket.gaierror:
        addresses = set()
    return sorted(addresses)[0] if addresses else target.casefold()


def resolved_mutation_target(name: str, arguments: Any) -> Optional[str]:
    if name not in DEVICE_MUTATION_NAMES or not isinstance(arguments, dict):
        return None
    explicit_host = arguments.get("host")
    if name == "run_flow" and explicit_host is None:
        try:
            scenario = Path(arguments.get("scenario", "")).expanduser()
            data = json.loads(scenario.read_text(encoding="utf-8"))
            if isinstance(data, dict):
                explicit_host = data.get("host")
            else:
                return None
        except (OSError, TypeError, ValueError, json.JSONDecodeError):
            return None
    return resolve_target(explicit_host)


def device_mutation_lock(target: Optional[str]):
    if target is None:
        return nullcontext()
    identity = canonical_device_identity(target)
    with DEVICE_MUTATION_LOCKS_LOCK:
        return DEVICE_MUTATION_LOCKS.setdefault(identity, threading.Lock())


def schema(properties: dict[str, Any], required: Optional[list[str]] = None) -> dict[str, Any]:
    result: dict[str, Any] = {
        "type": "object",
        "properties": properties,
        "additionalProperties": False,
    }
    if required:
        result["required"] = required
    return result


HOST = {
    "type": "string",
    "minLength": 1,
    "description": "Optional bare Roku IP/hostname. Overrides ROKU_DEV_TARGET and saved configuration.",
}

TOOLS = [
    {
        "name": "configure_target",
        "description": "Save the default Roku IP address or hostname in the toolkit's private user configuration file.",
        "inputSchema": schema(
            {"target": {"type": "string", "description": "Bare Roku IP address or hostname."}},
            ["target"],
        ),
        "annotations": {"readOnlyHint": False, "destructiveHint": False},
    },
    {
        "name": "configuration_status",
        "description": "Show the resolved Roku target and whether a developer password is available, without revealing it.",
        "inputSchema": schema({}),
        "annotations": {"readOnlyHint": True, "destructiveHint": False},
    },
    {
        "name": "device_info",
        "description": "Query Roku device identity, model, network, software, and developer-mode information over ECP.",
        "inputSchema": schema({"host": HOST}),
        "annotations": {"readOnlyHint": True, "destructiveHint": False},
    },
    {
        "name": "list_apps",
        "description": "List applications installed on the Roku device.",
        "inputSchema": schema({"host": HOST}),
        "annotations": {"readOnlyHint": True, "destructiveHint": False},
    },
    {
        "name": "active_app",
        "description": "Query the application currently active on the Roku device.",
        "inputSchema": schema({"host": HOST}),
        "annotations": {"readOnlyHint": True, "destructiveHint": False},
    },
    {
        "name": "player_state",
        "description": "Query Roku media-player state, including playback and stream information when available.",
        "inputSchema": schema({"host": HOST}),
        "annotations": {"readOnlyHint": True, "destructiveHint": False},
    },
    {
        "name": "launch",
        "description": "Launch a Roku channel or deep-link content. Use channel_id 'dev' for the sideloaded app.",
        "inputSchema": schema(
            {
                "channel_id": {"type": "string", "minLength": 1},
                "host": HOST,
                "content_id": {"type": "string"},
                "media_type": {"type": "string"},
            },
            ["channel_id"],
        ),
        "annotations": {"readOnlyHint": False, "destructiveHint": False},
    },
    {
        "name": "press",
        "description": "Send an intentional sequence of Roku remote-control keys.",
        "inputSchema": schema(
            {
                "keys": {"type": "array", "items": {"type": "string"}, "minItems": 1},
                "host": HOST,
                "delay": {"type": "number", "minimum": 0, "maximum": 10, "default": 0.35},
            },
            ["keys"],
        ),
        "annotations": {"readOnlyHint": False, "destructiveHint": False},
    },
    {
        "name": "enter_text",
        "description": "Enter non-secret text through Roku ECP Lit_ keypresses. Do not use for passwords or tokens.",
        "inputSchema": schema(
            {
                "text": {"type": "string"},
                "host": HOST,
                "delay": {"type": "number", "minimum": 0, "maximum": 10, "default": 0.05},
            },
            ["text"],
        ),
        "annotations": {"readOnlyHint": False, "destructiveHint": False},
    },
    {
        "name": "take_screenshot",
        "description": "Capture the visible sideloaded-app UI. Writes or replaces the requested output file; cannot capture protected video.",
        "inputSchema": schema(
            {
                "host": HOST,
                "output": {"type": "string", "description": "Optional absolute .jpg, .jpeg, or .png output path."},
            }
        ),
        "annotations": {"readOnlyHint": False, "destructiveHint": True},
    },
    {
        "name": "collect_logs",
        "description": "Collect BrightScript console output for a bounded interval and write or replace the requested output file.",
        "inputSchema": schema(
            {
                "host": HOST,
                "seconds": {"type": "number", "minimum": 0.1, "maximum": MAX_LOG_SECONDS, "default": 10},
                "output": {"type": "string", "description": "Optional absolute local output path."},
            }
        ),
        "annotations": {"readOnlyHint": False, "destructiveHint": True},
    },
    {
        "name": "sideload",
        "description": "Replace the current Roku development app with a ZIP. Uses Keychain or ROKU_DEV_PASSWORD and requires confirmation.",
        "inputSchema": schema(
            {
                "archive": {"type": "string", "description": "Absolute path to an existing Roku ZIP."},
                "confirm_replace_dev_app": {"type": "boolean", "description": "Must be true."},
                "host": HOST,
            },
            ["archive", "confirm_replace_dev_app"],
        ),
        "annotations": {"readOnlyHint": False, "destructiveHint": True},
    },
    {
        "name": "run_flow",
        "description": "Run a JSON Roku flow and write screenshots, queries, and report.json to an evidence directory.",
        "inputSchema": schema(
            {
                "scenario": {"type": "string", "description": "Absolute path to a JSON flow scenario."},
                "evidence_dir": {"type": "string", "description": "Absolute directory path for evidence artifacts."},
                "host": HOST,
                "dry_run": {"type": "boolean", "default": False},
            },
            ["scenario", "evidence_dir"],
        ),
        "annotations": {"readOnlyHint": False, "destructiveHint": True},
    },
]


def validate_tool_arguments(name: str, arguments: Any) -> None:
    if not isinstance(arguments, dict):
        raise ValueError("Tool arguments must be an object.")
    tool = next((candidate for candidate in TOOLS if candidate["name"] == name), None)
    if tool is None:
        raise ValueError(f"Unknown tool: {name}")
    allowed = set(tool["inputSchema"].get("properties", {}))
    unknown = sorted(set(arguments) - allowed)
    if unknown:
        raise ValueError(f"Unknown argument(s) for {name}: {', '.join(unknown)}")


def bounded_number(
    arguments: dict[str, Any], name: str, default: float, minimum: float, maximum: float
) -> float:
    value = arguments.get(name, default)
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(f"{name} must be a number between {minimum} and {maximum}.")
    result = float(value)
    if not math.isfinite(result) or result < minimum or result > maximum:
        raise ValueError(f"{name} must be a number between {minimum} and {maximum}.")
    return result


def host_args(arguments: dict[str, Any]) -> list[str]:
    try:
        target = RESOLVED_DEVICE_TARGET.get() or resolve_target(arguments.get("host"))
        return ["--host", target]
    except (ValueError, RuntimeError) as error:
        raise ValueError(f"{error} Use configure_target first.") from error


def path_arg(value: Any, label: str, allow_directory: bool = False) -> Path:
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{label} must be a non-empty path.")
    path = Path(value).expanduser()
    if not path.is_absolute():
        raise ValueError(f"{label} must be an absolute path because MCP runs from the plugin directory.")
    candidate = path.parent.resolve() / path.name
    if candidate.is_symlink():
        raise ValueError(f"{label} must not be a symlink: {candidate}")
    if candidate.exists() and allow_directory and not candidate.is_dir():
        raise ValueError(f"{label} must resolve to a directory: {candidate}")
    if candidate.exists() and not allow_directory and not candidate.is_file():
        raise ValueError(f"{label} must resolve to a regular file: {candidate}")
    return candidate


def default_artifact(suffix: str) -> Path:
    directory = Path(tempfile.mkdtemp(prefix="roku-device-mcp-"))
    handle, name = tempfile.mkstemp(prefix="roku-", suffix=suffix, dir=directory)
    os.close(handle)
    return Path(name)


def artifact_fingerprint(path: Path) -> Optional[tuple[int, int, int]]:
    try:
        status = path.stat()
        return (status.st_ino, status.st_size, status.st_mtime_ns)
    except FileNotFoundError:
        return None


def flow_timeout(scenario: Path, dry_run: bool) -> float:
    if dry_run:
        return 60.0
    try:
        data = json.loads(scenario.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return 60.0
    steps = data.get("steps") if isinstance(data, dict) else None
    if not isinstance(steps, list):
        return 60.0
    required_delay_seconds = 0.0
    step_timeout_seconds = 0.0
    for step in steps:
        if not isinstance(step, dict):
            continue
        action = step.get("action")
        step_timeout_seconds += SCREENSHOT_TIMEOUT if action == "screenshot" else FLOW_STEP_TIMEOUT
        if action == "pause":
            value = step.get("seconds", 0)
            if isinstance(value, (int, float)) and not isinstance(value, bool):
                seconds = float(value)
                if math.isfinite(seconds) and 0 <= seconds <= 3600:
                    required_delay_seconds += seconds
            continue
        delay = step.get("delay", 0.35 if action == "press" else 0.05)
        if not isinstance(delay, (int, float)) or isinstance(delay, bool):
            continue
        delay = float(delay)
        if not math.isfinite(delay) or not 0 <= delay <= 10:
            continue
        if action == "press" and isinstance(step.get("keys"), list):
            request_count = len(step["keys"])
            required_delay_seconds += request_count * ECP_REQUEST_TIMEOUT
            required_delay_seconds += max(0, request_count - 1) * delay
        elif action == "text" and isinstance(step.get("value"), str):
            request_count = len(step["value"])
            required_delay_seconds += request_count * ECP_REQUEST_TIMEOUT
            required_delay_seconds += max(0, request_count - 1) * delay
    return 60.0 + required_delay_seconds + step_timeout_seconds


def terminate_process(process: subprocess.Popen[str]) -> None:
    if process.poll() is not None:
        return
    try:
        if os.name == "posix":
            os.killpg(process.pid, signal.SIGTERM)
        else:
            subprocess.run(
                ["taskkill", "/PID", str(process.pid), "/T", "/F"],
                check=False,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                timeout=WINDOWS_TERMINATION_TIMEOUT,
            )
            if process.poll() is None:
                process.terminate()
    except ProcessLookupError:
        pass
    except (OSError, subprocess.TimeoutExpired):
        try:
            if process.poll() is None:
                process.terminate()
        except ProcessLookupError:
            pass


def reserve_request_id(request_id: Any) -> bool:
    """Atomically reserve an ID until its response lifecycle is complete."""
    if not valid_request_id(request_id):
        return False
    with IN_FLIGHT_LOCK:
        if request_id in PENDING_REQUESTS or request_id in IN_FLIGHT:
            return False
        PENDING_REQUESTS.add(request_id)
        return True


def release_request_id(request_id: Any) -> None:
    if not valid_request_id(request_id):
        return
    with IN_FLIGHT_LOCK:
        PENDING_REQUESTS.discard(request_id)
        CANCELLED_REQUESTS.discard(request_id)


def cancel_request(request_id: Any) -> None:
    if not valid_request_id(request_id):
        return
    try:
        with IN_FLIGHT_LOCK:
            if request_id not in PENDING_REQUESTS and request_id not in IN_FLIGHT:
                return
            CANCELLED_REQUESTS.add(request_id)
            process = IN_FLIGHT.get(request_id)
    except TypeError:
        return
    if process is not None:
        terminate_process(process)


def cancel_all_requests() -> None:
    with IN_FLIGHT_LOCK:
        request_ids = list(PENDING_REQUESTS | set(IN_FLIGHT))
    for request_id in request_ids:
        cancel_request(request_id)


def handle_shutdown_signal(signum: int, _frame: Any) -> None:
    SHUTDOWN_REQUESTED.set()
    raise SystemExit(128 + signum)


def execute(command: list[str], timeout: float = 30.0, env: Optional[dict[str, str]] = None) -> dict[str, Any]:
    request_id = CURRENT_REQUEST_ID.get()
    if request_id is not None:
        with IN_FLIGHT_LOCK:
            if request_id in CANCELLED_REQUESTS:
                raise RequestCancelled("Request cancelled before command execution.")
    process = subprocess.Popen(
        command,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        env=env,
        start_new_session=os.name == "posix",
    )
    if request_id is not None:
        try:
            with IN_FLIGHT_LOCK:
                IN_FLIGHT[request_id] = process
                cancelled = request_id in CANCELLED_REQUESTS
        except TypeError:
            request_id = None
            cancelled = False
        if cancelled:
            terminate_process(process)
    try:
        stdout, stderr = process.communicate(timeout=timeout)
    except subprocess.TimeoutExpired:
        terminate_process(process)
        stdout, stderr = process.communicate()
        raise subprocess.TimeoutExpired(command, timeout, stdout, stderr)
    finally:
        if request_id is not None:
            with IN_FLIGHT_LOCK:
                IN_FLIGHT.pop(request_id, None)
    if request_id is not None:
        with IN_FLIGHT_LOCK:
            if request_id in CANCELLED_REQUESTS:
                raise RequestCancelled("Request cancelled during command execution.")
    result = {
        "command_succeeded": process.returncode == 0,
        "return_code": process.returncode,
        "stdout": stdout.strip(),
        "stderr": stderr.strip(),
    }
    if process.returncode != 0:
        message = result["stderr"] or result["stdout"] or "Roku command failed without output."
        raise CommandFailure(message, result)
    return result


def call_tool(name: str, arguments: dict[str, Any]) -> dict[str, Any]:
    validate_tool_arguments(name, arguments)
    query_commands = {
        "device_info": "info",
        "list_apps": "apps",
        "active_app": "active-app",
        "player_state": "player",
    }
    base = [] if name in {"configure_target", "configuration_status", "run_flow"} else [
        sys.executable, str(DEVICE_TOOL), *host_args(arguments)
    ]
    artifact: Optional[Path] = None

    if name == "configure_target":
        target = arguments.get("target")
        if not isinstance(target, str) or not target.strip():
            raise ValueError("target must be a non-empty string.")
        path = save_target(target)
        result = {
            "command_succeeded": True,
            "target": resolve_target(),
            "config_path": str(path),
            "stdout": f"Saved Roku target to {path}",
            "stderr": "",
        }
    elif name == "configuration_status":
        status = configuration_status()
        result = {"command_succeeded": True, **status, "stdout": json.dumps(status, indent=2), "stderr": ""}
    elif name in query_commands:
        result = execute([*base, query_commands[name]])
    elif name == "launch":
        channel_id = arguments.get("channel_id")
        if not isinstance(channel_id, str) or not channel_id.strip():
            raise ValueError("channel_id must be a non-empty string.")
        channel_id = channel_id.strip()
        command = [*base, "launch"]
        for field, option in (("content_id", "--content-id"), ("media_type", "--media-type")):
            if arguments.get(field) is not None:
                if not isinstance(arguments[field], str):
                    raise ValueError(f"{field} must be a string when provided.")
                command += [option, arguments[field]]
        command += ["--", channel_id]
        result = execute(command)
    elif name == "press":
        keys = arguments.get("keys")
        if not isinstance(keys, list) or not keys or not all(
            isinstance(key, str) and bool(key.strip()) for key in keys
        ):
            raise ValueError("keys must be a non-empty array of non-empty strings.")
        delay = bounded_number(arguments, "delay", 0.35, 0.0, 10.0)
        timeout = 30 + len(keys) * ECP_REQUEST_TIMEOUT + max(0, len(keys) - 1) * delay
        result = execute([*base, "press", "--delay", str(delay), "--", *keys], timeout)
    elif name == "enter_text":
        value = arguments.get("text")
        if not isinstance(value, str):
            raise ValueError("text must be a string.")
        delay = bounded_number(arguments, "delay", 0.05, 0.0, 10.0)
        timeout = 30 + len(value) * ECP_REQUEST_TIMEOUT + max(0, len(value) - 1) * delay
        result = execute([*base, "text", "--delay", str(delay), "--", value], timeout)
    elif name == "take_screenshot":
        artifact = path_arg(arguments["output"], "output") if "output" in arguments else default_artifact(".jpg")
        if artifact.suffix.lower() not in {".jpg", ".jpeg", ".png"}:
            raise ValueError("Screenshot output must end in .jpg, .jpeg, or .png.")
        if not artifact.parent.is_dir():
            raise ValueError(f"Screenshot output directory does not exist: {artifact.parent}")
        result = execute([*base, "screenshot", "--output", str(artifact)], SCREENSHOT_TIMEOUT)
    elif name == "collect_logs":
        seconds = bounded_number(arguments, "seconds", 10.0, 0.1, MAX_LOG_SECONDS)
        artifact = path_arg(arguments["output"], "output") if "output" in arguments else default_artifact(".log")
        if not artifact.parent.is_dir():
            raise ValueError(f"Log output directory does not exist: {artifact.parent}")
        previous_artifact = artifact_fingerprint(artifact)
        try:
            result = execute([*base, "logs", "--seconds", str(seconds), "--output", str(artifact)], seconds + 20)
        except CommandFailure as error:
            if artifact_fingerprint(artifact) != previous_artifact:
                error.result["artifact"] = str(artifact)
            raise
    elif name == "sideload":
        if arguments.get("confirm_replace_dev_app") is not True:
            raise ValueError("Sideloading replaces the current dev app; set confirm_replace_dev_app to true.")
        archive = path_arg(arguments.get("archive"), "archive")
        if not archive.is_file() or archive.suffix.lower() != ".zip":
            raise ValueError(f"Expected an existing Roku ZIP archive: {archive}")
        result = execute([*base, "sideload", str(archive), "--yes"], SIDELOAD_TIMEOUT)
    elif name == "run_flow":
        if "dry_run" in arguments and not isinstance(arguments["dry_run"], bool):
            raise ValueError("dry_run must be a boolean when provided.")
        if "host" in arguments and (
            not isinstance(arguments["host"], str) or not arguments["host"].strip()
        ):
            raise ValueError("host must be a non-empty string when provided.")
        scenario = path_arg(arguments.get("scenario"), "scenario")
        evidence = path_arg(arguments.get("evidence_dir"), "evidence_dir", allow_directory=True)
        if not scenario.is_file() or scenario.suffix.lower() != ".json":
            raise ValueError(f"Expected an existing JSON scenario: {scenario}")
        command = [sys.executable, str(FLOW_TOOL), "--scenario", str(scenario), "--evidence-dir", str(evidence)]
        target = RESOLVED_DEVICE_TARGET.get()
        if target is None and "host" in arguments:
            target = resolve_target(arguments["host"])
        if target is not None:
            command += ["--host", target]
        dry_run = arguments.get("dry_run") is True
        if dry_run:
            command.append("--dry-run")
        flow_env = {**os.environ, "ROKU_DEVICE_TOOL": str(DEVICE_TOOL)}
        artifact = evidence / "report.json"
        previous_artifact = artifact_fingerprint(artifact)
        try:
            result = execute(command, flow_timeout(scenario, dry_run), env=flow_env)
        except CommandFailure as error:
            if artifact.is_file() and artifact_fingerprint(artifact) != previous_artifact:
                error.result["artifact"] = str(artifact)
            raise
    if artifact is not None:
        result["artifact"] = str(artifact)
    return result


def tool_result(name: str, arguments: dict[str, Any]) -> dict[str, Any]:
    try:
        validate_tool_arguments(name, arguments)
        target = resolved_mutation_target(name, arguments)
        token = RESOLVED_DEVICE_TARGET.set(target)
        try:
            with device_mutation_lock(target):
                data = call_tool(name, arguments)
        finally:
            RESOLVED_DEVICE_TARGET.reset(token)
        text = data.get("stdout") or f"{name} completed successfully."
        if data.get("artifact"):
            text = f"{text}\nArtifact: {data['artifact']}".strip()
        return {"content": [{"type": "text", "text": text}], "structuredContent": data, "isError": False}
    except CommandFailure as error:
        data = error.result
        text = str(error)
        if data.get("artifact"):
            text = f"{text}\nArtifact: {data['artifact']}"
        return {"content": [{"type": "text", "text": text}], "structuredContent": data, "isError": True}
    except (ValueError, RuntimeError, subprocess.TimeoutExpired, OSError) as error:
        return {"content": [{"type": "text", "text": str(error)}], "isError": True}


def handle(message: dict[str, Any]) -> Optional[dict[str, Any]]:
    request_id = message.get("id")
    if "id" in message and not valid_request_id(request_id):
        return {"jsonrpc": "2.0", "id": None, "error": {"code": -32600, "message": "Invalid Request"}}
    if message.get("jsonrpc") != "2.0":
        return {"jsonrpc": "2.0", "id": request_id, "error": {"code": -32600, "message": "Invalid Request"}}
    method = message.get("method")
    if request_id is None:
        return None
    if method == "initialize":
        result = {
            "protocolVersion": PROTOCOL_VERSION,
            "capabilities": {"tools": {"listChanged": False}},
            "serverInfo": {"name": "roku-device-toolkit", "version": "0.1.0"},
        }
    elif method == "ping":
        result = {}
    elif method == "tools/list":
        result = {"tools": TOOLS}
    elif method == "tools/call":
        params = message.get("params", {})
        arguments = params.get("arguments") if "arguments" in params else {}
        if arguments is None:
            arguments = {}
        result = tool_result(str(params.get("name", "")), arguments)
    elif method in {"resources/list", "prompts/list"}:
        result = {"resources": []} if method == "resources/list" else {"prompts": []}
    else:
        return {"jsonrpc": "2.0", "id": request_id, "error": {"code": -32601, "message": f"Method not found: {method}"}}
    return {"jsonrpc": "2.0", "id": request_id, "result": result}


def main() -> None:
    if not DEVICE_TOOL.is_file() or not FLOW_TOOL.is_file():
        print("Bundled Roku operator scripts are missing.", file=sys.stderr)
        raise SystemExit(1)
    output_lock = threading.Lock()
    signal.signal(signal.SIGTERM, handle_shutdown_signal)
    signal.signal(signal.SIGINT, handle_shutdown_signal)

    def emit(response: dict[str, Any]) -> None:
        with output_lock:
            print(json.dumps(response, separators=(",", ":")), flush=True)

    def process(message: dict[str, Any]) -> None:
        request_id = message.get("id")
        token = CURRENT_REQUEST_ID.set(request_id)
        try:
            with IN_FLIGHT_LOCK:
                if request_id in CANCELLED_REQUESTS:
                    raise RequestCancelled("Request cancelled before dispatch.")
            response = handle(message)
            if response is not None:
                emit(response)
        except RequestCancelled as error:
            emit({"jsonrpc": "2.0", "id": request_id, "error": {"code": -32800, "message": str(error)}})
        except Exception as error:  # Keep the server alive after malformed requests.
            emit({"jsonrpc": "2.0", "id": request_id, "error": {"code": -32603, "message": str(error)}})
            traceback.print_exc(file=sys.stderr)
        finally:
            release_request_id(request_id)
            CURRENT_REQUEST_ID.reset(token)

    executor = ThreadPoolExecutor(max_workers=4, thread_name_prefix="roku-device-mcp")
    try:
        for line in sys.stdin:
            if not line.strip():
                continue
            try:
                message = json.loads(line)
                if not isinstance(message, dict):
                    emit({"jsonrpc": "2.0", "id": None, "error": {"code": -32600, "message": "Invalid Request"}})
                    continue
                if "id" in message and not valid_request_id(message.get("id")):
                    emit({"jsonrpc": "2.0", "id": None, "error": {"code": -32600, "message": "Invalid Request"}})
                    continue
                if message.get("jsonrpc") != "2.0":
                    emit({"jsonrpc": "2.0", "id": message.get("id"), "error": {"code": -32600, "message": "Invalid Request"}})
                    continue
                if isinstance(message, dict) and message.get("method") == "notifications/cancelled":
                    params = message.get("params")
                    if isinstance(params, dict) and valid_request_id(params.get("requestId")):
                        cancel_request(params.get("requestId"))
                    continue
                if message.get("id") is not None and not reserve_request_id(message["id"]):
                    emit({
                        "jsonrpc": "2.0",
                        "id": message["id"],
                        "error": {"code": -32600, "message": "Duplicate request id"},
                    })
                    continue
                executor.submit(process, message)
            except json.JSONDecodeError as error:
                emit({"jsonrpc": "2.0", "id": None, "error": {"code": -32700, "message": "Parse error"}})
                print(error, file=sys.stderr)
    finally:
        cancel_all_requests()
        executor.shutdown(wait=True, cancel_futures=True)


if __name__ == "__main__":
    main()
