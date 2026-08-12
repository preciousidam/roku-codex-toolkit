#!/usr/bin/env python3
"""Validate semantic invariants that JSON Schema cannot express for a flow report."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any


def validate_report_semantics(report: Any) -> None:
    if not isinstance(report, dict):
        raise ValueError("Flow report must be a JSON object.")
    steps = report.get("steps")
    if not isinstance(steps, list):
        raise ValueError("Flow report must contain a steps array.")
    indices = [step.get("index") if isinstance(step, dict) else None for step in steps]
    expected = list(range(1, len(steps) + 1))
    if indices != expected:
        raise ValueError(
            f"Flow report step indices must be the unique sequence 1..{len(steps)}; "
            f"received {indices}."
        )


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("report", type=Path)
    args = parser.parse_args()
    report = json.loads(args.report.read_text(encoding="utf-8"))
    try:
        validate_report_semantics(report)
    except ValueError as error:
        raise SystemExit(str(error)) from error
    print(args.report)


if __name__ == "__main__":
    main()
