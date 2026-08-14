# Roku Codex Toolkit

Reusable Codex plugins for Roku development, device automation, flow verification, diagnostics, accessibility review, and release preparation.

[Documentation](https://preciousidam.github.io/roku-codex-toolkit/) ·
[Plugin guide](https://preciousidam.github.io/roku-codex-toolkit/marketplace/) ·
[npm](https://www.npmjs.com/package/roku-codex-toolkit)

## Plugins

- `roku-device-toolkit`: Roku ECP controls, developer-mode sideloading, screenshots, console capture, an MCP server, and evidence-backed flow verification.
- `roku-engineering`: Runtime-log analysis, accessibility review, and project-neutral Roku release validation.

The repository intentionally excludes product-specific authentication, entitlement, deployment, and operational workflows.

## Requirements

- Codex with plugin support
- Node.js 18 or newer
- Python 3.9 or newer
- Git (used to verify and install versioned marketplace tags)
- A Roku device on the same network with developer mode enabled for sideloading, screenshots, or console capture

## Install from a clone

```bash
git clone https://github.com/preciousidam/roku-codex-toolkit.git
cd roku-codex-toolkit
npm ci
npm run validate
npm run setup
```

`npm run setup` registers this repository as the `roku-codex-toolkit` marketplace, installs both plugins, and optionally prompts for device configuration. Use `npm run setup -- --skip-config` to install without configuring a Roku.

## Install with npm

Starting with v0.2.0, the public npm distribution provides this installation workflow:

```sh
npx roku-codex-toolkit doctor
npx roku-codex-toolkit setup
```

For a clean first installation, device setup, and an evidence-aware first flow, follow the
[getting-started tutorial](docs/getting-started.md). Common environment and connectivity failures
are covered in [troubleshooting](docs/troubleshooting.md).

Python 3.9+ and Git remain external requirements; the npm package bundles neither. `doctor` checks Node, Python, Git, and Codex. `setup` completes those runtime checks before changing Codex configuration, then registers the matching versioned Git tag as the durable marketplace source. The transient `npx` cache is never registered. Use `--skip-config` to install the plugins without prompting for a Roku target.

`setup` intentionally refuses to replace an existing marketplace or alter orphaned toolkit plugin state.
For a healthy public installation created by npm setup, upgrade with the desired published version:

```sh
npx --yes roku-codex-toolkit@<version> upgrade
```

The command changes nothing unless it can verify and reconstruct the exact existing version. It
refuses local, partial, dirty, unversioned, mixed-version, intentionally disabled, and downgrade
states. After mutation begins, failure or cancellation triggers bounded rollback and verification.
Existing Roku device configuration and credentials are outside the transaction and remain intact.
See the [transactional upgrade state model](docs/upgrade-state-model.md) for the precise boundary.

To uninstall, remove both plugins and then the marketplace explicitly before uninstalling any
globally installed npm package.

Installing from the GitHub marketplace remains supported and canonical. Repository changes alone do not publish, tag, or promote a package; publication requires an approved versioned GitHub release.

Device configuration is stored at `~/.config/roku-device-toolkit/config.json`. On macOS, the developer password is stored in Keychain. Linux and Windows users should provide `ROKU_DEV_PASSWORD` only to the process that needs developer-mode access.

## Validate

```bash
npm run validate
```

Validation does not require a physical Roku. Device-dependent operations should be verified separately on hardware.

The test suite runs on macOS, Linux, and Windows in CI. That establishes host-side portability only; it is not a claim that every operation has been exercised against Roku hardware from every host OS.

## Project status

v0.1.0 established the public plugin baseline. v0.2.0 added npm delivery and stable flow JSON
contracts. The proposed [v0.3.0 boundary](docs/v0.3.0.md) is limited to configuration reliability
and recoverable upgrades while preserving the established Python and Node.js responsibilities. See
also the [clean-install smoke matrix](docs/clean-install-smoke.md),
[stabilization audit](docs/stabilization-audit.md),
[hardware validation matrix](docs/hardware-validation.md), and [contributor guide](CONTRIBUTING.md).
The proposed upgrade safety boundary is documented in the
[transactional upgrade state model](docs/upgrade-state-model.md).

## Roku tooling landscape

The toolkit complements editor-oriented Roku tooling: it gives Codex bounded device operations, evidence-aware flow execution, and repository review workflows. It does not replace an editor, language server, debugger, packaging toolchain, or Roku's developer portal. See [the tooling comparison](docs/tooling-comparison.md).

For the public feature matrix, plugin selection guide, capability inventory, and sanitized media, see
the hosted [plugin guide](https://preciousidam.github.io/roku-codex-toolkit/marketplace/).
Its Markdown source remains available in [docs/marketplace.md](docs/marketplace.md).

## Security

Do not commit Roku developer passwords, captured console logs, screenshots, or flow evidence. See [SECURITY.md](SECURITY.md) for reporting guidance.

## License

Licensed under the [Apache License 2.0](LICENSE). The selection rationale is documented in [the Apache-2.0 versus MIT evaluation](docs/license-evaluation.md).
