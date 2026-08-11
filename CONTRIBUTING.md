# Contributing

## Setup

Install Node.js 18+ and Python 3.9+, clone the repository, and run:

```sh
npm run validate
```

The tests are dependency-free and do not require a Roku. Run `npm run test:node` or `npm run test:python` for focused feedback. Both focused commands use the same portable interpreter discovery as `npm run validate`: `python3`, `python`, or Windows `py -3`.

## Change expectations

- Keep the plugins project-neutral and never add private product endpoints, credentials, logs, or assumptions.
- Add focused tests for behavior changes. Prefer Python tests for device, flow, analyzer, and MCP logic; prefer Node tests for manifests, installation, launchers, and repository integration.
- Preserve strict schemas, bounded external operations, cancellation, private artifacts, and evidence-based reporting.
- Do not label a flow verified merely because commands or screenshots completed.
- Update `docs/v0.1.0.md` when changing a compatibility surface or release boundary.

Physical-device testing should record host OS, Roku model, firmware, scenario, and artifacts, and must distinguish observed facts from inferences. Never commit captured evidence.

## Pull requests

Keep changes focused, explain security or compatibility effects, and include the output of `npm run validate`. License selection, release publication, external services, and new credential-storage mechanisms require maintainer approval.
