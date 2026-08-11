# Roku Codex Toolkit

Reusable Codex plugins for Roku development, device automation, flow verification, diagnostics, accessibility review, and release preparation.

## Plugins

- `roku-device-toolkit`: Roku ECP controls, developer-mode sideloading, screenshots, console capture, an MCP server, and evidence-backed flow verification.
- `roku-engineering`: Runtime-log analysis, accessibility review, and project-neutral Roku release validation.

The repository intentionally excludes product-specific authentication, entitlement, deployment, and operational workflows.

## Requirements

- Codex with plugin support
- Node.js 18 or newer
- Python 3.9 or newer
- A Roku device on the same network with developer mode enabled for sideloading, screenshots, or console capture

## Install from a clone

```bash
git clone https://github.com/preciousidam/roku-codex-toolkit.git
cd roku-codex-toolkit
npm run validate
npm run setup
```

`npm run setup` registers this repository as the `roku-codex-toolkit` marketplace, installs both plugins, and optionally prompts for device configuration. Use `npm run setup -- --skip-config` to install without configuring a Roku.

Device configuration is stored at `~/.config/roku-device-toolkit/config.json`. On macOS, the developer password is stored in Keychain. Linux and Windows users should provide `ROKU_DEV_PASSWORD` only to the process that needs developer-mode access.

## Validate

```bash
npm run validate
```

Validation does not require a physical Roku. Device-dependent operations should be verified separately on hardware.

## Security

Do not commit Roku developer passwords, captured console logs, screenshots, or flow evidence. See [SECURITY.md](SECURITY.md) for reporting guidance.

## License status

An open-source license has not yet been selected. Until a license is added, copyright remains with the author and reuse rights are not granted beyond viewing the public source.
