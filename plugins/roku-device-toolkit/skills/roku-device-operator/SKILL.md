---
name: roku-device-operator
description: Operate and inspect Roku development devices using ECP and developer-mode interfaces. Use when Codex needs to send remote keypresses or text, launch or deep-link an app, query device/app/player state, sideload a development ZIP, capture a Roku screenshot, collect BrightScript console logs, run a repeatable device exercise, or diagnose Roku connectivity and developer-mode access.
---

# Roku Device Operator

Use the bundled `scripts/roku_device.py` for deterministic device operations. Read [references/device-interfaces.md](references/device-interfaces.md) when diagnosing connectivity, selecting ports, or using screenshot/sideload features.

## Establish scope

1. Resolve the target from `--host`, then `ROKU_DEV_TARGET`, then `~/.config/roku-device-toolkit/config.json`; never guess an address.
2. Run `info` before mutations when the target has not already been verified in the current task.
3. Treat sideloading as destructive because Roku replaces the currently sideloaded development app. Require an explicit user request and pass `--yes`.
4. Read the developer password from `ROKU_DEV_PASSWORD` when set, otherwise from the `roku-device-toolkit` macOS Keychain item. Never print or commit it.
5. Do not capture screens containing secrets or private account data. Roku screenshots cannot capture video playback.

## Quick commands

Configure the device once with the packaged setup script. It saves only the target in the config file. On macOS it prompts invisibly for the password and stores it in Keychain; on Linux and Windows, set `ROKU_DEV_PASSWORD` only in the calling process:

```bash
python3 "<roku-device-toolkit-plugin-dir>/scripts/roku_config.py"
```

Use the MCP `configure_target` and `configuration_status` tools for non-secret setup and diagnostics. Use the interactive script when adding or changing the password so it does not enter the Codex transcript.

Set paths without changing the user environment:

```bash
ROKU_DEVICE_TOOL="<roku-device-operator-skill-dir>/scripts/roku_device.py"
python3 "$ROKU_DEVICE_TOOL" --host 192.168.1.50 info
python3 "$ROKU_DEVICE_TOOL" --host 192.168.1.50 apps
python3 "$ROKU_DEVICE_TOOL" --host 192.168.1.50 active-app
python3 "$ROKU_DEVICE_TOOL" --host 192.168.1.50 player
```

Operate the app:

```bash
python3 "$ROKU_DEVICE_TOOL" --host 192.168.1.50 press left down down ok
python3 "$ROKU_DEVICE_TOOL" --host 192.168.1.50 text "search term"
python3 "$ROKU_DEVICE_TOOL" --host 192.168.1.50 launch dev
python3 "$ROKU_DEVICE_TOOL" --host 192.168.1.50 launch dev --content-id movie-1 --media-type movie
```

Use `--delay` with `press` for focus-sensitive flows. After navigation, query `active-app` or `player` and capture a screenshot when visual evidence is needed.

## Developer-mode operations

Export `ROKU_DEV_PASSWORD` in the calling shell without echoing its value. Then:

```bash
python3 "$ROKU_DEVICE_TOOL" --host 192.168.1.50 screenshot --output /tmp/roku-screen.jpg
python3 "$ROKU_DEVICE_TOOL" --host 192.168.1.50 sideload path/to/app.zip --yes
python3 "$ROKU_DEVICE_TOOL" --host 192.168.1.50 logs --seconds 20 --output /tmp/roku-console.log
```

Use `screenshot` only while the sideloaded app is visible and video is not playing. Use `logs` while reproducing the failure; do not claim runtime verification from compilation alone.

## Exercise a flow

For short ad hoc flows, send a deliberate key sequence with `press`, pausing between state transitions. For certification sign-in/sign-out flows, prefer repository `.rasp` scripts and the Roku Remote Tool. Preserve `script-login` and `script-password` placeholders; never insert real credentials into committed scripts.

Unless the user requests a different sequence, collect evidence in this order:

1. `info` and `active-app` to verify the target.
2. Start `logs` when runtime output matters.
3. Launch and operate the app.
4. Query `player` for playback state.
5. Capture a screenshot for non-video UI state.
6. Report exactly which device actions ran and whether each succeeded.

For user-driven reproduction windows, coordinate a clear start signal before running `logs --seconds ...`. Keep collected artifacts local until they have been inspected for sensitive content; if redaction is needed, ask before creating a modified derivative unless the user already authorized artifact preparation.

## Failure handling

- A port `8060` failure means ECP is unreachable or restricted; verify the same LAN/subnet and Roku network-control settings.
- A port `80` authentication failure means developer mode or its password is unavailable.
- A port `8085` failure means the BrightScript console is unavailable, often because developer mode is disabled or no dev app is running.
- Never retry sideloading automatically after an ambiguous timeout; first query the active app and inspect logs.
- Do not send `home`, `back`, or arbitrary key loops when they could exit an app or disrupt a user without the request authorizing that behavior.
