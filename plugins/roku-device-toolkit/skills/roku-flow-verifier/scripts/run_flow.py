#!/usr/bin/env python3
"""Run a JSON Roku flow through the installed roku-device-operator."""

from __future__ import annotations

import argparse
import json
import math
import os
import subprocess
import sys
import time
from pathlib import Path
from typing import Optional


DEFAULT_DEVICE_TOOL = Path(__file__).resolve().parents[2] / "roku-device-operator/scripts/roku_device.py"
DEVICE_TOOL = Path(os.environ.get("ROKU_DEVICE_TOOL", str(DEFAULT_DEVICE_TOOL))).expanduser()
PLUGIN_ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(PLUGIN_ROOT / "scripts"))
from roku_artifacts import write_private_text  # noqa: E402
from roku_config import resolve_target  # noqa: E402

QUERY_KINDS = {"info", "apps", "active-app", "player"}
STEP_FIELDS = {
    "query": {"action", "kind", "contains", "save"},
    "launch": {"action", "channel_id", "content_id", "media_type"},
    "press": {"action", "keys", "delay"},
    "text": {"action", "value", "delay"},
    "screenshot": {"action", "save"},
    "pause": {"action", "seconds"},
}
SCENARIO_FIELDS = {"name", "host", "continue_on_failure", "steps"}


def is_verification_checkpoint(step: object) -> bool:
    if not isinstance(step, dict):
        return False
    expected = step.get("contains")
    return step.get("action") == "query" and isinstance(expected, str) and bool(expected.strip())


def safe_artifact(root: Path, relative: str) -> Path:
    resolved_root = root.resolve()
    portable_parts = relative.replace("\\", "/").split("/")
    if ".." in portable_parts:
        raise ValueError(f"Artifact path must not contain parent-directory segments: {relative}")
    relative_path = Path(relative)
    if relative_path.parts and relative_path.parts[0].casefold() == "report.json":
        raise ValueError("report.json is reserved for the flow report.")
    candidate = (root / relative).resolve()
    if candidate == resolved_root or candidate.is_dir():
        raise ValueError(f"Artifact path must resolve to a file: {relative}")
    if str(candidate).casefold() == str((root / "report.json").resolve()).casefold():
        raise ValueError("report.json is reserved for the flow report.")
    try:
        candidate.relative_to(resolved_root)
    except ValueError as error:
        raise ValueError(f"Artifact path escapes evidence directory: {relative}") from error
    return candidate


def ensure_private_directory(path: Path) -> None:
    missing = []
    current = path
    while not current.exists():
        missing.append(current)
        current = current.parent
    path.mkdir(parents=True, exist_ok=True, mode=0o700)
    for directory in missing:
        os.chmod(directory, 0o700)


def write_flow_text(root: Path, path: Path, value: str) -> None:
    ensure_private_directory(path.parent)
    write_private_text(path, value, "Flow artifact", allowed_root=root)


def bounded_delay(value: object) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError("delay must be a number between 0 and 10 seconds")
    delay = float(value)
    if not math.isfinite(delay) or delay < 0 or delay > 10:
        raise ValueError("delay must be a number between 0 and 10 seconds")
    return delay


def bounded_pause(value: object) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError("pause seconds must be a number between 0 and 3600")
    seconds = float(value)
    if not math.isfinite(seconds) or seconds < 0 or seconds > 3600:
        raise ValueError("pause seconds must be a number between 0 and 3600")
    return seconds


def elapsed_seconds(started: float) -> float:
    return round(time.monotonic() - started, 3)


def command_for(step: dict, host: str, evidence: Path) -> tuple[Optional[list[str]], Optional[Path]]:
    action = step.get("action")
    if action not in STEP_FIELDS:
        raise ValueError(f"Unsupported action: {action}")
    unknown = sorted(set(step) - STEP_FIELDS[action])
    if unknown:
        raise ValueError(f"Unknown field(s) for {action}: {', '.join(unknown)}")
    base = [sys.executable, str(DEVICE_TOOL), "--host", host]
    capture_path = None
    if action == "query":
        kind = step.get("kind")
        if kind not in QUERY_KINDS:
            raise ValueError(f"Unsupported query kind: {kind}")
        if "contains" in step and (
            not isinstance(step["contains"], str) or not step["contains"].strip()
        ):
            raise ValueError("query contains must be a non-empty string when provided")
        if "save" in step:
            if not isinstance(step["save"], str) or not step["save"].strip():
                raise ValueError("query save must be a non-empty string when provided")
            capture_path = safe_artifact(evidence, step["save"])
        return base + [kind], capture_path
    if action == "launch":
        channel = step.get("channel_id")
        if not isinstance(channel, str) or not channel.strip():
            raise ValueError("launch requires a non-empty string channel_id")
        channel = channel.strip()
        command = base + ["launch"]
        for field, option in (("content_id", "--content-id"), ("media_type", "--media-type")):
            if step.get(field) is not None:
                if not isinstance(step[field], str):
                    raise ValueError(f"launch {field} must be a string when provided")
                command.append(f"{option}={step[field]}")
        command += ["--", channel]
        return command, None
    if action == "press":
        keys = step.get("keys")
        if (
            not isinstance(keys, list)
            or not keys
            or not all(isinstance(key, str) and bool(key.strip()) for key in keys)
        ):
            raise ValueError("press requires a non-empty array of non-empty string keys")
        delay = bounded_delay(step.get("delay", 0.35))
        return base + ["press", "--delay", str(delay), "--", *keys], None
    if action == "text":
        if not isinstance(step.get("value"), str):
            raise ValueError("text requires a string value")
        delay = bounded_delay(step.get("delay", 0.05))
        return base + ["text", "--delay", str(delay), "--", step["value"]], None
    if action == "screenshot":
        name = str(step.get("save", ""))
        portable_parts = name.replace("\\", "/").split("/")
        if portable_parts[-1] in {"", "."}:
            raise ValueError("screenshot save must name a file, not a trailing directory alias")
        if Path(name).suffix.lower() not in {".jpg", ".jpeg", ".png"}:
            raise ValueError("screenshot save must end in .jpg, .jpeg, or .png")
        capture_path = safe_artifact(evidence, name)
        return base + ["screenshot", "--output", str(capture_path)], None
    if action == "pause":
        bounded_pause(step.get("seconds", 0))
        return None, None
    raise ValueError(f"Unsupported action: {action}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--scenario", type=Path, required=True)
    parser.add_argument("--evidence-dir", type=Path, required=True)
    parser.add_argument("--host", help="Override scenario host")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    scenario = json.loads(args.scenario.read_text(encoding="utf-8"))
    if not isinstance(scenario, dict) or not isinstance(scenario.get("steps"), list):
        raise SystemExit("Scenario must be an object with a steps array.")
    unknown_scenario_fields = sorted(set(scenario) - SCENARIO_FIELDS)
    if unknown_scenario_fields:
        raise SystemExit(
            f"Unknown scenario field(s): {', '.join(unknown_scenario_fields)}"
        )
    if "name" in scenario and (
        not isinstance(scenario["name"], str) or not scenario["name"].strip()
    ):
        raise SystemExit("Scenario name must be a non-empty string when provided.")
    if not scenario["steps"]:
        raise SystemExit("Scenario must contain at least one verification step.")
    if "continue_on_failure" in scenario and not isinstance(scenario["continue_on_failure"], bool):
        raise SystemExit("Scenario continue_on_failure must be a boolean when provided.")
    continue_on_failure = scenario.get("continue_on_failure", False)
    try:
        selected_host = args.host if args.host is not None else scenario.get("host")
        host = resolve_target(selected_host)
    except (ValueError, RuntimeError) as error:
        raise SystemExit(str(error)) from error
    if not DEVICE_TOOL.is_file():
        raise SystemExit(f"Roku device operator is missing: {DEVICE_TOOL}")

    evidence = args.evidence_dir.resolve()
    ensure_private_directory(evidence)
    scenario_path = args.scenario.resolve()
    report_path = (evidence / "report.json").resolve()
    if str(scenario_path).casefold() == str(report_path).casefold():
        raise SystemExit("Scenario path must not be the reserved flow report path.")
    checkpoint_count = sum(1 for step in scenario["steps"] if is_verification_checkpoint(step))
    screenshot_count = sum(
        1 for step in scenario["steps"]
        if isinstance(step, dict) and step.get("action") == "screenshot"
    )
    claimed_artifacts: set[str] = {str(scenario_path).casefold()}
    prepared_steps = []
    preflight_errors = []
    preflight_results = []
    for index, step in enumerate(scenario["steps"], start=1):
        try:
            if not isinstance(step, dict):
                raise ValueError(f"Step {index} must be an object.")
            command, capture_path = command_for(step, host, evidence)
            step_artifact = capture_path
            if step.get("action") == "screenshot":
                step_artifact = safe_artifact(evidence, str(step["save"]))
            if step_artifact is not None:
                folded_artifact = str(step_artifact).casefold()
                if folded_artifact in claimed_artifacts:
                    raise ValueError(f"Artifact path is used by more than one step: {step_artifact}")
                claimed_artifacts.add(folded_artifact)
            prepared_steps.append((command, capture_path, step_artifact))
            preflight_results.append({
                "index": index,
                "action": step.get("action"),
                "checkpoint": is_verification_checkpoint(step),
                "passed": False,
                "status": "skipped",
                "duration_seconds": 0,
            })
        except Exception as error:
            prepared_steps.append((None, None, None))
            invalid_action = step.get("action") if isinstance(step, dict) else None
            invalid_result = {
                "index": index,
                "action": invalid_action if isinstance(invalid_action, str) else None,
                "checkpoint": is_verification_checkpoint(step),
                "passed": False,
                "status": "invalid",
                "error": str(error),
                "duration_seconds": 0,
            }
            preflight_errors.append(invalid_result)
            preflight_results.append(invalid_result)
    if checkpoint_count == 0 and screenshot_count == 0:
        preflight_errors.append({
            "index": 0,
            "passed": False,
            "status": "invalid",
            "error": "Scenario requires a screenshot or a query with a contains assertion.",
            "duration_seconds": 0,
        })
    if preflight_errors:
        report = {
            "name": scenario.get("name", args.scenario.stem),
            "host": host,
            "dry_run": args.dry_run,
            "verified": False,
            "checkpoint_count": checkpoint_count,
            "screenshot_count": screenshot_count,
            "passed": False,
            "steps": preflight_results,
            "verification_error": "Flow preflight failed before any device actions were executed.",
        }
        report_path = evidence / "report.json"
        write_flow_text(evidence, report_path, json.dumps(report, indent=2) + "\n")
        print(report_path)
        raise SystemExit(1)

    results = []
    overall = True
    for index, step in enumerate(scenario["steps"], start=1):
        started_at = time.time()
        elapsed_started = time.monotonic()
        result = {"index": index, "started_at": started_at}
        try:
            result["action"] = step.get("action")
            result["checkpoint"] = is_verification_checkpoint(step)
            command, capture_path, step_artifact = prepared_steps[index - 1]
            if step.get("action") == "screenshot" and not args.dry_run:
                ensure_private_directory(step_artifact.parent)
            if step.get("action") == "pause":
                if not args.dry_run:
                    time.sleep(bounded_pause(step.get("seconds", 0)))
                completed = subprocess.CompletedProcess([], 0, "", "")
            elif args.dry_run:
                print(" ".join(command or []))
                completed = subprocess.CompletedProcess(command or [], 0, "", "")
            else:
                completed = subprocess.run(command, text=True, capture_output=True, check=False)
            output = completed.stdout
            if capture_path is not None and not args.dry_run and completed.returncode == 0:
                write_flow_text(evidence, capture_path, output)
                result["artifact"] = str(capture_path)
            expected = step.get("contains")
            passed = not args.dry_run and completed.returncode == 0 and (expected is None or str(expected) in output)
            step_succeeded = passed
            if step.get("action") == "screenshot":
                screenshot_path = safe_artifact(evidence, str(step["save"]))
                capture_succeeded = passed and screenshot_path.is_file()
                step_succeeded = capture_succeeded
                passed = False
                result["capture_succeeded"] = capture_succeeded
                if capture_succeeded:
                    os.chmod(screenshot_path, 0o600)
                    result["artifact"] = str(screenshot_path)
                    result["visual_review_required"] = True
            result.update({
                "passed": passed,
                "status": (
                    "skipped" if args.dry_run
                    else ("pending_visual_review" if step_succeeded and step.get("action") == "screenshot"
                          else ("passed" if passed else "failed"))
                ),
                "return_code": completed.returncode,
                "stderr": completed.stderr.strip(),
                "duration_seconds": elapsed_seconds(elapsed_started),
            })
        except Exception as error:
            passed = False
            step_succeeded = False
            result.update({
                "passed": False,
                "status": "invalid" if args.dry_run else "failed",
                "error": str(error),
                "duration_seconds": elapsed_seconds(elapsed_started),
            })
        results.append(result)
        overall = overall and step_succeeded
        if not step_succeeded and not args.dry_run and not continue_on_failure:
            break

    completed_all_steps = len(results) == len(scenario["steps"])
    verified = not args.dry_run and any(
        result.get("checkpoint") is True and result.get("passed") is True
        for result in results
    )
    pending_visual_review = any(
        result.get("status") == "pending_visual_review" for result in results
    )
    report = {
        "name": scenario.get("name", args.scenario.stem),
        "host": host,
        "dry_run": args.dry_run,
        "verified": verified,
        "checkpoint_count": checkpoint_count,
        "screenshot_count": screenshot_count,
        "pending_visual_review": pending_visual_review,
        "passed": overall and completed_all_steps and verified and not pending_visual_review,
        "steps": results,
    }
    if pending_visual_review:
        report["verification_error"] = (
            "Captured screenshots still require visual review before this flow can pass."
        )
    elif checkpoint_count == 0:
        report["verification_error"] = (
            "Captured screenshots require visual review; add a query with a contains assertion "
            "for automated verification."
        )
    report_path = evidence / "report.json"
    write_flow_text(evidence, report_path, json.dumps(report, indent=2) + "\n")
    print(report_path)
    if args.dry_run:
        raise SystemExit(0)
    raise SystemExit(0 if report["passed"] else 1)


if __name__ == "__main__":
    main()
