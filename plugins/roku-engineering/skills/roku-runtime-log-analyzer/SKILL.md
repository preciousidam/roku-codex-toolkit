---
name: roku-runtime-log-analyzer
description: Analyze Roku BrightScript console logs, debugger dumps, crash exports, and flow evidence to identify the first causal failure and recurring signatures. Use for runtime errors, backtraces, ParseJSON failures, SceneGraph focus faults, entitlement or DRM errors, playback failures, startup problems, repeated warnings, and comparing logs across builds or reproductions.
---

# Roku Runtime Log Analyzer

Use `scripts/analyze_roku_log.py` for deterministic signature extraction, then inspect source using the repository's own instructions. Read [references/causal-triage.md](references/causal-triage.md) for interpretation rules.

## Workflow

1. Preserve the raw log and note build/version, device model, Roku OS, scenario, and timestamps when known.
2. Run the analyzer on one or more text logs. For vendor CSV crash exports, use a project-specific export parser when available.
3. Find the earliest actionable error, its preceding request/state messages, runtime line, and backtrace.
4. Separate causal failures from secondary warnings and downstream symptoms.
5. Map deployed line numbers to the matching release commit before proposing code changes.
6. Report confidence and missing evidence. Do not fabricate a root cause from a final `missing_token` or generic playback error alone.

```bash
python3 "<roku-runtime-log-analyzer-skill-dir>/scripts/analyze_roku_log.py" console.log
```
