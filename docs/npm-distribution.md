# npm distribution

Issue #6 tracks the first npm distribution. The npm package is the delivery mechanism for the
existing project-neutral Codex plugins. Python 3.9+ and Git remain external requirements.

## Package boundary

The tarball contains the two plugin directories, marketplace manifest, dependency-free Node CLI, Python runtime sources, schemas, README, and license. It excludes tests, CI configuration, contribution material, hardware evidence, local configuration, credentials, logs, caches, and development dependencies.

The CLI exposes:

- `roku-codex-toolkit doctor` for runtime discovery.
- `roku-codex-toolkit validate` for installed-tarball integrity and runtime validation.
- `roku-codex-toolkit setup` for explicit installation from the matching versioned Git tag. The npm cache is not used as a persistent marketplace path.

Setup is deliberately fresh-install-only. It refuses to replace an existing marketplace or modify orphaned plugin entries because the current Codex marketplace listing does not expose enough information to restore a prior version-pinned Git source transactionally. Upgrades use the documented explicit remove-and-install workflow; interrupted operations must be inspected before retrying.

There is no `postinstall` script. Installation alone performs no configuration changes, network requests, credential prompts, or device operations.

## Versioning

The npm package, package lock, both plugin manifests, release notes, and GitHub tag are one release unit. Before publishing, update and validate every version-bearing file in one release PR. A GitHub tag must exactly match the npm package version as `v<version>`.

The first npm publication is planned as v0.2.0 after the schema work. Version changes happen only in the approved release PR.

## Publication gate

Publication requires all of the following:

1. Confirm npm package-name ownership.
2. Review the exact `npm pack --dry-run` inventory.
3. Install and exercise the tarball on the supported CI host and runtime matrix.
4. Approve the release version and GitHub tag.
5. Configure the protected `npm` GitHub environment and complete the first-publication bootstrap below.

The release-preparation PR does not publish, tag, reserve the package name, or create registry configuration.

## First-publication bootstrap

npm trusted publishing cannot be configured until the package already exists. For v0.2.0 only:

1. Create a protected GitHub environment named `npm`, restrict it to release tags, and require approval when the repository plan supports it.
2. Create a short-lived npm granular access token with the minimum publication access available and 2FA bypass enabled only for this automated bootstrap. Store it as the environment secret `NPM_TOKEN` and publish v0.2.0 through `publish.yml`. Do not publish from a developer checkout.
3. Verify the public package version, tarball inventory, CLI entry point, and provenance.
4. Configure the npm trusted publisher for `preciousidam/roku-codex-toolkit`, workflow `publish.yml`, environment `npm`, with `npm publish` permission.
5. Delete the `NPM_TOKEN` environment secret and revoke the bootstrap token. Future releases use OIDC only.

The publish workflow runs only for a published GitHub release, verifies that the release tag exactly matches every package and plugin version, reruns validation, and uses a GitHub-hosted runner. Publishing remains a separate approved action after the release PR merges.
