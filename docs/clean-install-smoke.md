# Clean-install smoke matrix

This matrix validates the published `roku-codex-toolkit@0.2.0` package from isolated npm caches and
temporary host configuration directories. It is host-side evidence only: it does not contact a Roku
and does not claim that any Roku UI is correct.

## Automated scenarios

Pull requests run `node scripts/smoke-published-package.mjs --version 0.2.0` on clean GitHub-hosted macOS, Linux,
and Windows runners. The script:

- invokes the published package through `npm exec` and runs `doctor --no-codex`;
- runs `setup --skip-config` against an isolated Codex command-contract double;
- verifies the marketplace source is `preciousidam/roku-codex-toolkit` at Git tag `v0.2.0`;
- verifies both plugins are registered;
- installs the registry package into a clean prefix and confirms that it has no lifecycle mutation
  scripts;
- starts the packaged MCP launcher and confirms that all 13 tools are listed;
- exercises the documented plugin and marketplace removal sequence, then reinstalls cleanly; and
- emits a sanitized JSON summary containing only host/runtime versions and scenario outcomes.

The contract double prevents CI from mutating a runner's real Codex account. The test still uses the
real npm registry package, real Python launcher, and real Git network check for the matching public
release tag. Temporary npm, home, and configuration directories are deleted after each run.

## Results

| Host | Node | Python | Git | Published package | Automated result | Physical Roku evidence |
| --- | --- | --- | --- | --- | --- | --- |
| macOS GitHub-hosted runner | 22 | 3.13 | Runner-provided | `0.2.0` | Pending first PR matrix | Not in scope |
| Ubuntu GitHub-hosted runner | 22 | 3.13 | Runner-provided | `0.2.0` | Pending first PR matrix | Not in scope |
| Windows GitHub-hosted runner | 22 | 3.13 | Runner-provided | `0.2.0` | Pending first PR matrix | Not in scope |

Replace the pending cells with the linked GitHub Actions run after the first complete matrix. Record
reproducible failures as separate `bug` issues suitable for v0.2.1. Do not add runner paths, account
details, credentials, device addresses, screenshots, console logs, or private artifacts.

## Manual Codex confirmation

The automated matrix cannot prove account-specific Codex UI behavior. On one clean Codex profile:

1. Run `npx --yes roku-codex-toolkit@0.2.0 doctor` and confirm every check reports `ok`.
2. Run `npx --yes roku-codex-toolkit@0.2.0 setup --skip-config`.
3. Restart Codex and confirm `roku-device-toolkit` and `roku-engineering` appear and are enabled.
4. Confirm the marketplace reports the public repository at `v0.2.0`.
5. Remove both plugins and the marketplace with the documented commands.

Record only the Codex version and pass/fail outcomes. This confirmation does not require a physical
Roku and must not include account identifiers or configuration contents.
