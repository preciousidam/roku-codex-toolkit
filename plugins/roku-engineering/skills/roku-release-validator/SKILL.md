---
name: roku-release-validator
description: Validate and prepare Roku application releases from branch through production packaging and promotion. Use for version bumps, manifest and runtime-config checks, production ZIP creation, release readiness, release pull requests, CI monitoring, rollback planning, and evidence-backed release approval for Roku BrightScript or SceneGraph apps.
---

# Roku Release Validator

Use the repository's instructions for project-specific code and branch handling and `$roku-flow-verifier` when the Roku Device Toolkit plugin is installed for device acceptance. Read [references/release-gates.md](references/release-gates.md) for the gate checklist.

## Workflow

1. Identify source branch, target branch, merge base, worktree changes, and already-published version. Never release from an ambiguous or dirty scope.
2. Review the complete diff and separate Roku-app changes from companion backend or infrastructure changes when present; they have different release boundaries.
3. Discover and run the compile, test, production-package, and repository-health checks required by the project's instruction files. Do not invent or weaken checks.
4. Inspect the manifest version, production endpoint/config injection, package contents, and absence of secrets or local artifacts.
5. Require physical-device acceptance for changed auth, playback, subscription, focus, navigation, deep-link, or persistence behavior.
6. Prepare the PR/release only when authorized. Verify CI and report warnings separately from failures.
7. Record rollback target, feature-flag fallback, and whether the package or backend change can be independently reverted.

## Output

Report every gate as pass, fail, blocked, or not applicable, with the exact command/evidence. Never equate a successful build with a successful Roku Store release or on-device behavior.
