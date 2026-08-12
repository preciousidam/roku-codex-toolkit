# npm distribution

Issue #6 tracks the first npm distribution. The npm package is a delivery mechanism for the existing project-neutral Codex plugins, not a rewrite of the Python runtime. Python 3.9+ and Git are external requirements.

## Package boundary

The tarball contains the two plugin directories, marketplace manifest, dependency-free Node CLI, Python runtime sources, schemas, README, and license. It excludes tests, CI configuration, contribution material, hardware evidence, local configuration, credentials, logs, caches, and development dependencies.

The CLI exposes:

- `roku-codex-toolkit doctor` for runtime discovery.
- `roku-codex-toolkit validate` for installed-tarball integrity and runtime validation.
- `roku-codex-toolkit setup` for explicit installation from the matching versioned Git tag. The npm cache is not used as a persistent marketplace path.

There is no `postinstall` script. Installation alone performs no configuration changes, network requests, credential prompts, or device operations.

## Versioning

The npm package, both plugin manifests, marketplace release notes, and GitHub tag are one release unit. Before publishing, update and validate every version-bearing file in one release PR. A GitHub tag must exactly match the npm package version as `v<version>`.

The first npm publication is planned as a distinct minor release after the schema work is merged. The repository remains at its current version during implementation; version changes happen only in the approved release PR.

## Publication gate

Publication requires all of the following:

1. Confirm npm package-name ownership.
2. Review the exact `npm pack --dry-run` inventory.
3. Install and exercise the tarball on the supported CI host and runtime matrix.
4. Approve the release version and GitHub tag.
5. Configure npm trusted publishing for the repository and an environment-gated GitHub Actions workflow with provenance.

The implementation PR does not publish, tag, reserve the package name, or create registry configuration.
