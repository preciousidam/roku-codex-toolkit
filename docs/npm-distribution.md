# npm distribution

Issue #6 tracks the first npm distribution. The npm package is the delivery mechanism for the
existing project-neutral Codex plugins. Python 3.9+ and Git remain external requirements.

## Package boundary

The tarball contains the two plugin directories, marketplace manifest, dependency-free Node CLI, Python runtime sources, schemas, README, and license. It excludes tests, CI configuration, contribution material, hardware evidence, local configuration, credentials, logs, caches, and development dependencies.

The CLI exposes:

- `roku-codex-toolkit doctor` for runtime discovery.
- `roku-codex-toolkit validate` for installed-tarball integrity and runtime validation.
- `roku-codex-toolkit setup` for explicit installation from the matching versioned Git tag. The npm cache is not used as a persistent marketplace path.
- `roku-codex-toolkit upgrade` for guarded replacement of a verified, reconstructible public installation.

Setup is deliberately fresh-install-only. Upgrade accepts only a healthy canonical version-pinned
installation whose exact prior source, ref, revision, and plugin state can be restored. Unsupported
or ambiguous states are refused without mutation. See the [upgrade safety model](upgrade-state-model.md).

There is no `postinstall` script. Installation alone performs no configuration changes, network requests, credential prompts, or device operations.

## Versioning

The npm package, package lock, both plugin manifests, release notes, and GitHub tag are one release unit. Before publishing, update and validate every version-bearing file in one release PR. A GitHub tag must exactly match the npm package version as `v<version>`.

The first npm publication was v0.2.0. Version changes happen only in an approved release PR.

## Publication gate

Publication requires all of the following:

1. Confirm npm package-name ownership.
2. Review the exact `npm pack --dry-run` inventory.
3. Install and exercise the tarball on the supported CI host and runtime matrix.
4. Approve the release version and GitHub tag.
5. Keep the protected `npm` GitHub environment and npm trusted-publisher configuration active.

The release-preparation PR does not publish, tag, reserve the package name, or create registry configuration.

## Trusted publishing

The v0.2.0 bootstrap publication established the package and was followed by trusted-publisher
configuration for `preciousidam/roku-codex-toolkit`, workflow `publish.yml`, environment `npm`.
The bootstrap token and repository secret are no longer part of the release path.

Future releases use GitHub Actions OIDC with `id-token: write`; they must not restore a long-lived
npm token merely to publish. Verify the public package version, tarball inventory, CLI entry point,
provenance, and post-publication host smoke matrix after every publication.

The publish workflow runs only for a published GitHub release, verifies that the release tag exactly matches every package and plugin version, reruns validation, and uses a GitHub-hosted runner. Publishing remains a separate approved action after the release PR merges.
