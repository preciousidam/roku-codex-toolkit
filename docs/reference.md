# Toolkit reference index

This page points to the implementation-owned references so the portal does not duplicate contracts
that can drift.

## Plugins and skills

### Roku Device Toolkit

- [Plugin manifest](https://github.com/preciousidam/roku-codex-toolkit/blob/main/plugins/roku-device-toolkit/.codex-plugin/plugin.json)
- [Roku Device Operator](https://github.com/preciousidam/roku-codex-toolkit/tree/main/plugins/roku-device-toolkit/skills/roku-device-operator)
- [Roku Flow Verifier](https://github.com/preciousidam/roku-codex-toolkit/tree/main/plugins/roku-device-toolkit/skills/roku-flow-verifier)
- [MCP server and 13 tool declarations](https://github.com/preciousidam/roku-codex-toolkit/blob/main/plugins/roku-device-toolkit/mcp/server.py)

### Roku Engineering

- [Plugin manifest](https://github.com/preciousidam/roku-codex-toolkit/blob/main/plugins/roku-engineering/.codex-plugin/plugin.json)
- [Roku Runtime Log Analyzer](https://github.com/preciousidam/roku-codex-toolkit/tree/main/plugins/roku-engineering/skills/roku-runtime-log-analyzer)
- [Roku Accessibility Reviewer](https://github.com/preciousidam/roku-codex-toolkit/tree/main/plugins/roku-engineering/skills/roku-accessibility-reviewer)
- [Roku Release Validator](https://github.com/preciousidam/roku-codex-toolkit/tree/main/plugins/roku-engineering/skills/roku-release-validator)

## Flow contracts and examples

- [Flow scenario JSON Schema](https://github.com/preciousidam/roku-codex-toolkit/blob/main/plugins/roku-device-toolkit/skills/roku-flow-verifier/references/flow-scenario.schema.json)
- [Flow report JSON Schema](https://github.com/preciousidam/roku-codex-toolkit/blob/main/plugins/roku-device-toolkit/skills/roku-flow-verifier/references/flow-report.schema.json)
- [Scenario format and semantic validation](https://github.com/preciousidam/roku-codex-toolkit/blob/main/plugins/roku-device-toolkit/skills/roku-flow-verifier/references/scenario-format.md)
- [Sanitized flow examples](https://github.com/preciousidam/roku-codex-toolkit/tree/main/examples/flow)

Schema validation establishes document structure. The companion semantic checks and physical-device
evidence rules still apply; valid JSON is not proof that a Roku UI is correct.
