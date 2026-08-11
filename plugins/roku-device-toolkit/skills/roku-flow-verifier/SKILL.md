---
name: roku-flow-verifier
description: Execute repeatable end-to-end Roku app flows on a development device and collect runtime evidence. Use for sign-in, sign-out, subscription/paywall, VOD, FAST, deep-link, navigation, focus, restart-persistence, and regression verification that requires remote actions, screenshots, active-app or player-state checks, and BrightScript logs.
---

# Roku Flow Verifier

Compose this skill with `$roku-device-operator`; use the repository's maintainer workflow when code changes are needed. Read [references/scenario-format.md](references/scenario-format.md) before creating a scenario.

## Workflow

1. Define the expected start state, actions, checkpoints, and pass criteria. Never infer credentials or purchase approval.
2. Verify the device with `info` and `active-app`. Build/sideload only when explicitly requested; sideloading replaces the dev app.
3. Put the scenario JSON and evidence directory in `/tmp` unless the user requests repository artifacts.
4. Run `scripts/run_flow.py --scenario ... --evidence-dir ...`; it delegates device actions to `$roku-device-operator`.
5. Inspect every screenshot and query artifact. Correlate checkpoints with console timestamps when logs are collected separately.
6. Report each checkpoint as passed, failed, or not verified. Do not treat action completion as proof of UI correctness.

## Verification rules

- Prefer state-aware `query` checks over fixed pauses. Use pauses only for asynchronous UI transitions without a queryable signal.
- Capture non-video screenshots at focus or layout checkpoints. Roku cannot capture protected video playback.
- Confirm playback through `/query/media-player`, player logs, and entitlement/DRM evidence.
- For restart persistence, launch once, establish state, relaunch `dev`, then verify state again without signing in a second time.
- Stop when a checkpoint fails unless the scenario explicitly sets `continue_on_failure`.
- Keep credentials out of scenarios. Use Roku certification placeholders in `.rasp` files and coordinate real credential entry separately.

## Typical invocation

```bash
python3 "<roku-flow-verifier-skill-dir>/scripts/run_flow.py" \
  --scenario /tmp/signin-restart.json \
  --evidence-dir /tmp/roku-signin-restart
```

Do not claim on-device verification unless the generated report and artifacts came from the intended physical device.
