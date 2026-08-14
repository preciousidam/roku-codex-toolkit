# Troubleshooting

Start with:

```sh
npx --yes roku-codex-toolkit@latest doctor
```

`doctor` performs bounded host checks and does not contact a Roku. Do not paste passwords, device
addresses, screenshots, console output, or configuration contents into a public issue.

## Python is not found

The toolkit requires Python 3.9 or newer. On Windows it probes `py -3`, `python`, then `python3`. On
macOS and Linux it probes `python3`, `python`, then `py -3`. It uses the first candidate that reports
a supported version, so it does not require the command to be named `python3`.

Check the interpreter normally used by your platform:

```sh
python3 --version
python --version
```

On Windows, also try:

```powershell
py -3 --version
```

Install a supported Python through the platform's normal package source, open a new terminal so its
PATH is refreshed, and rerun `doctor`. Do not add an untrusted executable or wrapper to PATH merely
to satisfy discovery.

## Git is not found

Git is required because npm setup registers the toolkit's matching versioned Git tag as the durable
Codex marketplace source. Confirm it is available:

```sh
git --version
```

Install Git from its official or platform-supported distribution, open a new terminal, and rerun
`doctor`. Corporate proxies or firewalls must also permit read access to GitHub for setup.

## Codex or the plugins are not discovered

Confirm that the current Codex CLI supports plugin marketplaces:

```sh
codex plugin marketplace --help
codex plugin marketplace list --json
codex plugin list --json
```

After a successful setup, restart Codex and open a new task. The installed list should include
`roku-device-toolkit` and `roku-engineering` from the `roku-codex-toolkit` marketplace.

Setup deliberately refuses to overwrite an existing marketplace or repair ambiguous orphaned plugin
state. Inspect the two JSON listings, preserve any intentionally disabled state, and use the explicit
upgrade steps in the [README](../README.md#install-with-npm). Do not repeatedly rerun setup after a
partial failure.

## Windows command shims fail

Use a normal PowerShell or Command Prompt session where Node, Git, Python, and Codex were installed.
Check how Windows resolves each command:

```powershell
Get-Command node, npm, npx, git, codex
Get-Command python, py -ErrorAction SilentlyContinue
```

Restart the terminal after installation or PATH changes. Avoid copying `.cmd` shims between machines
or invoking a Unix shell script as though it were a Windows executable. The toolkit invokes Windows
`.cmd` shims through the platform command processor and tests that path in Windows CI.

## The Roku is unreachable

Device queries use ECP on the local network. Verify that:

- the configured target is a bare hostname or address, without `http://`, a port, or a path;
- the computer and Roku are on the same trusted LAN and client isolation is not blocking peers;
- **Control by mobile apps > Network access** permits third-party local ECP requests (typically
  **Permissive**; labels can vary by Roku OS version); and
- local firewall policy permits the connection.

Do not guess or scan device addresses. Confirm the address on the Roku or in the network's trusted
administration interface. Ask `$roku-device-operator` to run only `info` first. A port `8060`
failure means ECP is unreachable or restricted; it is not evidence that developer credentials are
wrong.

## Developer-mode access fails

Developer-mode screenshots and sideloading use the Development Application Installer. Confirm
developer mode using Roku's official [setup instructions](https://developer.roku.com/dev/docs/developer-setup),
then verify its page manually from the same computer before retrying the toolkit.

The username is the fixed Roku development user documented by Roku. Keep the password out of command
arguments and Codex tasks. On macOS, rerun interactive toolkit configuration to update Keychain. On
Linux or Windows, set `ROKU_DEV_PASSWORD` only in the process performing the operation and remove it
afterward. An authentication failure on port `80` usually indicates developer mode or credential
access, not ECP reachability.

During macOS configuration, enter the password only at the toolkit's hidden terminal prompt. The
toolkit writes it through the native Keychain API and does not pass it through subprocess arguments,
streams, captured output, or error messages. If the prompt is cancelled or Keychain rejects the
update, the target and Codex plugins remain installed; rerun interactive configuration when
Keychain is available.

Sideloading replaces the currently sideloaded development application. Never retry it after an
ambiguous timeout until the active app and console evidence have been inspected.

## Screenshot capture fails or is rejected

Roku's screenshot utility is for the visible UI of a sideloaded application and cannot capture video
playback. Make sure the development app is in the foreground, video is not playing, developer mode
is active, and the developer credential is available to the process.

Write artifacts only to a new private directory you control. The toolkit rejects unsafe destinations,
symlinks, path traversal, unsupported extensions, and conflicting artifact names. Do not weaken those
checks to make a capture succeed.

A successful download is still not a visual pass. Inspect the image, confirm it came from the intended
device and scenario, and compare it with explicit visual criteria before reporting UI correctness.

## BrightScript console capture fails

The console is normally available only while a sideloaded development app is running. Confirm
developer mode, launch the approved development app, then reproduce the issue during a bounded capture
window. A port `8085` failure means the console is unavailable; it does not prove the app has no
runtime errors.

Console logs may contain tokens, account data, content identifiers, and private endpoints. Keep them
local, inspect them before sharing, and sanitize derived excerpts rather than committing raw logs.

## Report a toolkit defect

Run `doctor` and record only its `ok`/`not ok` check names, the operating system, Node and Python
versions, the toolkit version, and a sanitized error message. State whether the failure was host-side
or required physical hardware. Never attach configuration, environment dumps, screenshots, console
logs, network captures, credentials, or device addresses to a public issue.
