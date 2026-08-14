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
| macOS 26.5.2 GitHub-hosted runner (Darwin 25.5.0, arm64) | 22.23.1 | 3.13.14 | 2.55.0 | `0.2.0` | [Pass](https://github.com/preciousidam/roku-codex-toolkit/actions/runs/31785650322) | Not in scope |
| Ubuntu GitHub-hosted runner (Linux 6.17.0-1020-azure, x64) | 22.23.1 | 3.13.14 | 2.54.0 | `0.2.0` | [Pass](https://github.com/preciousidam/roku-codex-toolkit/actions/runs/31785650322) | Not in scope |
| Windows 10.0.26100 GitHub-hosted runner (x64) | 22.23.2 | 3.14.6 | 2.55.0.windows.3 | `0.2.0` | [Pass](https://github.com/preciousidam/roku-codex-toolkit/actions/runs/31785650322) | Not in scope |

The first complete matrix passed on August 14, 2026. The Windows smoke selected the newest supported
`py -3` interpreter available on that runner, independently confirming the toolkit's portable Python
discovery behavior. Record future reproducible failures as separate `bug` issues suitable for a patch
release. Do not add runner paths, account details, credentials, device addresses, screenshots,
console logs, or private artifacts.

## Manual Codex confirmation

The automated matrix cannot prove account-specific Codex UI behavior. On one clean Codex profile:

1. Run `npx --yes roku-codex-toolkit@0.2.0 doctor` and confirm every check reports `ok`.
2. Run `npx --yes roku-codex-toolkit@0.2.0 setup --skip-config`.
3. Restart Codex and confirm `roku-device-toolkit` and `roku-engineering` appear and are enabled.
4. Confirm the marketplace reports the public repository at `v0.2.0`.
5. Remove both plugins and the marketplace with the documented commands.

Record only the Codex version and pass/fail outcomes. This confirmation does not require a physical
Roku and must not include account identifiers or configuration contents.
