# Getting started

This tutorial takes a new user from a clean npm invocation to two installed Codex plugins, a
verified Roku connection, and an evidence-aware flow. Host-side installation can be completed
without a Roku. Device queries, remote input, screenshots, sideloading, and real flow execution
require a physical Roku reachable from the host.

Never paste a Roku developer password into a Codex task, command argument, scenario file, source
file, or committed shell script. Do not commit device addresses, screenshots, console logs, flow
evidence, or configuration files.

## 1. Check the host

Install Node.js 18 or newer, Python 3.9 or newer, Git, and Codex with plugin support. Then run the
published package without installing it globally:

```sh
npx --yes roku-codex-toolkit@latest doctor
```

Every line must start with `ok`. The command checks the host only; it does not contact a Roku or
change Codex configuration. If a check fails, use [troubleshooting](troubleshooting.md).

## 2. Install the plugins

Run setup. When it asks for the Roku target, enter a bare hostname or address:

```sh
npx --yes roku-codex-toolkit@latest setup
```

Setup registers a version-pinned GitHub marketplace and installs `roku-device-toolkit` and
`roku-engineering`. On macOS, its interactive configuration prompt stores the developer password
in Keychain. On Linux and Windows, setup stores only the target; provide the password to the
specific process that needs a developer-mode operation.

To install without recording a Roku target, use:

```sh
npx --yes roku-codex-toolkit@latest setup --skip-config
```

Restart Codex and open a new task. Confirm that both plugins appear:

```sh
codex plugin list --json
```

Do not rerun setup over an existing toolkit installation. Follow the explicit upgrade procedure in
the [README](../README.md#install-with-npm) instead.

## 3. Prepare a Roku development device

Use Roku's official [developer-mode setup](https://developer.roku.com/dev/docs/developer-setup).
Developer mode lets the device accept a development application, screenshots, and console access.
Sideloading replaces the one currently sideloaded application, so do it only when the device owner
has approved the ZIP and replacement.

For ECP remote-control actions, keep the computer and Roku on the same trusted local network. Under
**Settings > System > Advanced system settings > Control by mobile apps**, set **Network access** to
a value that permits third-party local ECP requests—typically **Permissive**. Roku OS versions may
use different labels, so consult Roku's
[current ECP documentation](https://developer.roku.com/dev/docs/external-control-api) rather than
weakening other network protections.

If setup was run with `--skip-config`, start a new Codex task and ask:

```text
Using $roku-device-operator, configure my Roku target. Prompt me for a bare hostname or address, do
not request a developer password in this task, and then show configuration status.
```

The saved configuration contains the target but not the developer password. Its default location is
`~/.config/roku-device-toolkit/config.json`; do not commit it.

For Bash or Zsh on Linux or macOS, read a password without displaying it or putting it in shell history:

```sh
read -rsp "Roku developer password: " ROKU_DEV_PASSWORD && echo
export ROKU_DEV_PASSWORD
# Run only the developer-mode operation that needs it, then:
unset ROKU_DEV_PASSWORD
```

For PowerShell 7 on Windows, keep the variable in the current process and remove it afterward:

```powershell
$env:ROKU_DEV_PASSWORD = Read-Host "Roku developer password" -MaskInput
# Run only the developer-mode operation that needs it, then:
Remove-Item Env:ROKU_DEV_PASSWORD
```

Environment variables can still be visible to child processes and local diagnostic tools. Use a
dedicated development credential and clear it promptly. On macOS, prefer the setup prompt and
Keychain instead of an environment variable.

## 4. Verify the first connection

Start with read-only queries in a new Codex task:

```text
Using $roku-device-operator, query device info and the active app for my configured Roku. Do not
send remote keys, launch an app, sideload, capture a screenshot, or collect logs. Report the target
source and the result of each query without printing private configuration.
```

A successful device-info response establishes ECP reachability. A successful active-app response
reports the device's current app state. Neither response proves that a particular UI is visible or
correct.

## 5. Run an evidence-aware flow

First use a read-only passing checkpoint. Replace `<expected-active-app-text>` with a non-secret,
case-sensitive string you have already observed in the active-app query:

```json
{
  "name": "First passing active-app checkpoint",
  "steps": [
    {
      "action": "query",
      "kind": "active-app",
      "contains": "<expected-active-app-text>",
      "save": "active-app.xml"
    }
  ]
}
```

Save it outside the repository as `first-pass.json`, then ask Codex:

```text
Using $roku-flow-verifier, run first-pass.json against my configured Roku. Store evidence in a new
temporary directory, validate the generated report, and report the checkpoint outcome. Do not
claim visual verification.
```

Next run an intentionally failing checkpoint:

```json
{
  "name": "First intentional checkpoint failure",
  "steps": [
    {
      "action": "query",
      "kind": "active-app",
      "contains": "ROKU_TOOLKIT_INTENTIONAL_MISSING_CHECKPOINT_7B2E",
      "save": "active-app.xml"
    }
  ]
}
```

Save it as `first-intentional-failure.json` outside the repository, then ask Codex:

```text
Using $roku-flow-verifier, run first-intentional-failure.json against my configured Roku. Store
evidence in a new temporary directory, validate the generated report, and confirm that the query
completed but its evidence checkpoint and overall flow failed. Do not claim visual verification.
```

The query action may complete successfully, but the checkpoint and overall flow must fail because
the response does not contain the required marker. That distinction is the core evidence rule.

Screenshots add evidence but never pass themselves. A successful screenshot capture proves only
that an image file was obtained. A person or authorized visual-review process must inspect the
correct image against explicit criteria before reporting a visual pass. Roku also cannot capture
protected video playback, so use player state and relevant runtime evidence for playback checks.

## What is and is not validated

| Activity | Host-only | Physical Roku required | What success establishes |
| --- | --- | --- | --- |
| `doctor`, package validation, scenario dry-run | Yes | No | Host runtime and input structure |
| Plugin installation and discovery | Yes | No | Codex can discover the installed plugins |
| Device info and active-app queries | No | Yes | ECP reachability and returned device state |
| Keypress, text entry, launch, or deep link | No | Yes | The device accepted the command |
| Screenshot download | No | Yes | An image was captured, not that its UI is correct |
| Console capture or sideload | No | Yes | Developer-mode operation completed |
| Evidence-aware flow | No | Yes | Only its explicit checkpoints and reviewed evidence |

Keep evidence in a temporary or ignored private directory. Sanitize any report before sharing it,
and do not retain artifacts longer than the work requires.
