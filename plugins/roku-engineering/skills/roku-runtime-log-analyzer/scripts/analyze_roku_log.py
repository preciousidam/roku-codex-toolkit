#!/usr/bin/env python3
"""Extract and group actionable signatures from Roku runtime text logs."""

from __future__ import annotations

import argparse
import collections
import json
import re
from pathlib import Path


PATTERNS = [
    ("runtime_error", re.compile(r"runtime error|Array operation attempted|BrightScript Micro Debugger", re.I), 1),
    (
        "parse_error",
        re.compile(
            r"parse error|Syntax Error"
            r"|ParseJSON.*(?:error|fail|empty|invalid|malformed)"
            r"|(?:error|fail|empty|invalid|malformed).*ParseJSON",
            re.I,
        ),
        1,
    ),
    ("backtrace", re.compile(r"Backtrace:|file/line:|pkg:/.*\.(?:brs|bs)\(\d+\)", re.I), 1),
    (
        "auth_entitlement",
        re.compile(
            r"AuthGate.*(?:fail|error|denied|blocked|unauthenticated)"
            r"|Entitlement.*(?:fail|error|denied|blocked)"
            r"|missing_token|Not authorized"
            r"|(?:HTTP|status(?:Code)?|response[_ ]?code|code)\s*[=:]?\s*(?:401|403)\b",
            re.I,
        ),
        2,
    ),
    (
        "request_failure",
        re.compile(
            r"request_(?:failed|timeout|start_failed)|response_failed|http_failed|HTTP\s+[45]\d\d"
            r"|(?:^|\s)[A-Za-z]\w*:\s*timeout\b",
            re.I,
        ),
        2,
    ),
    (
        "playback",
        re.compile(
            r"PlaybackError|player.*(?:error|failed)"
            r"|(?:DRM|license).*(?:fail|error|denied|rejected|timeout)"
            r"|(?:fail|error|denied|rejected|timeout).*(?:DRM|license)",
            re.I,
        ),
        3,
    ),
    (
        "focus_state",
        re.compile(
            r"(?:focus|focusedChild|setFocus).*(?:fail|error|invalid|lost|unreachable)"
            r"|(?:fail|error|invalid|lost|unreachable).*(?:focus|focusedChild|setFocus)"
            r"|invalid state transition",
            re.I,
        ),
        3,
    ),
    ("warning", re.compile(r"warning|already signaled", re.I), 5),
]

SENSITIVE_FIELD = re.compile(
    r"(?i)((?:\\?[\"'])?\b(?:authorization|access[_ -]?token|refresh[_ -]?token|session[_ -]?token|id[_ -]?token|"
    r"password|client[_ -]?secret|api[_ -]?key|cookie|account(?:[_ -]?id)?|email|license(?:[_ -]?url)?)\b(?:\\?[\"'])?\s*[:=]\s*)"
    r"(?:\\?[\"'][^\"']*\\?[\"']|(?:bearer|basic)\s+[^\s,;]+|[^\s,;]+)"
)
SENSITIVE_URL = re.compile(
    r"(?i)https?://[^\s,;]*(?:license|licence|[?&](?:access_?token|token|signature|sig)=)[^\s,;]*"
)


def redact(line: str) -> str:
    value = SENSITIVE_URL.sub("<redacted-license-url>", line)
    return SENSITIVE_FIELD.sub(r"\1<redacted>", value)


def normalize(line: str) -> str:
    value = re.sub(r"\b[0-9a-f]{8}-[0-9a-f-]{27,}\b", "<uuid>", line, flags=re.I)
    value = re.sub(r"\brequestId=\S+", "requestId=<id>", value, flags=re.I)
    value = re.sub(r"\b\d{4}-\d\d-\d\d[T ][0-9:.+-Z]+", "<timestamp>", value)
    return value.strip()


def analyze(path: Path) -> dict:
    lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
    events = []
    counts: collections.Counter[str] = collections.Counter()
    for number, raw in enumerate(lines, start=1):
        for category, pattern, priority in PATTERNS:
            if pattern.search(raw):
                safe_line = redact(raw)
                signature = normalize(safe_line)
                counts[f"{category}: {signature}"] += 1
                events.append({"line": number, "category": category, "priority": priority, "text": safe_line.strip()})
                break
    actionable = [event for event in events if event["priority"] < 5]
    causal = min(actionable, key=lambda event: (event["priority"], event["line"])) if actionable else None
    grouped = [
        {"signature": signature, "count": count}
        for signature, count in counts.most_common()
    ]
    return {
        "file": str(path),
        "line_count": len(lines),
        "first_actionable": causal,
        "events": events,
        "signatures": grouped,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("logs", nargs="+", type=Path)
    parser.add_argument("--json", action="store_true", help="Emit JSON instead of text")
    args = parser.parse_args()
    reports = [analyze(path) for path in args.logs]
    if args.json:
        print(json.dumps(reports, indent=2))
        return
    for report in reports:
        print(f"{report['file']}: {report['line_count']} lines")
        first = report["first_actionable"]
        if first:
            print(f"  first actionable: line {first['line']} [{first['category']}] {first['text']}")
        else:
            print("  first actionable: none detected")
        for item in report["signatures"][:20]:
            print(f"  {item['count']:>4}  {item['signature']}")


if __name__ == "__main__":
    main()
