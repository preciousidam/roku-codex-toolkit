# Transactional upgrade state model

This model defines when Roku Codex Toolkit may replace an existing marketplace and how it must
recover after interruption. It is based on the Codex CLI state available in August 2026. The model
does not read or change device configuration, Keychain, environment credentials, or private device
artifacts.

## Observable state

The installer may use only bounded, read-only inspection before deciding whether mutation is safe:

- `codex plugin marketplace list --json` provides marketplace name, resolved root, and source type
  and location.
- `codex plugin list --json` provides plugin ID, name, marketplace, version, installed state, and
  enabled state.
- A Git marketplace root may contain Codex's `.codex-marketplace-install.json` receipt with
  `source_type`, `source`, `ref_name`, `sparse_paths`, and `revision`.
- Bounded Git commands can confirm that the root has no changes other than Codex's expected
  untracked receipt, its `HEAD` equals the receipt revision, and the recorded ref resolves to that
  revision.
- A bounded remote lookup can confirm that the target release tag exists before mutation.

When the receipt exists, it is required and must be valid. Some current Codex installations omit
it. In that case only, the toolkit may reconstruct equivalent metadata when the marketplace and Git
origin are the same canonical public source, `HEAD` has exactly one stable `v<semver>` tag, both
installed plugin versions equal that tag, and every other checkout-safety condition passes. A
malformed receipt, multiple matching tags, or inference from plugin versions or a commit alone is
not sufficient for rollback.

Codex currently reports whether a plugin is disabled but exposes no plugin enable/disable command.
Therefore an intentional disabled choice cannot be restored transactionally and must not be
mutated.

## State classification

| State | Required observations | Disposition |
| --- | --- | --- |
| Fresh | No toolkit marketplace and no toolkit plugin entries | Use existing `setup`; `upgrade` refuses because there is nothing to upgrade. |
| Supported healthy version | One official Git marketplace; valid receipt or the strict receipt-less reconstruction above; immutable `v<semver>` ref and matching revision; clean root; exactly both toolkit plugins installed from that marketplace at the same version; both enabled | Transactional upgrade is permitted. |
| Already at target | Supported healthy state whose receipt ref, revision, and both plugin versions match the requested package version | Successful no-op after preflight; no mutation. |
| Disabled choice | Either toolkit plugin has `enabled: false` | Refuse without mutation because the choice cannot be restored through the public CLI. |
| Orphaned | Toolkit plugins exist without the toolkit marketplace | Refuse without mutation. |
| Partial or mixed | Only one plugin exists, duplicate toolkit entries exist, versions differ, or installed state is ambiguous | Refuse without mutation. |
| Local or unversioned | Marketplace is local, source metadata is missing, ref is absent, or ref is not an immutable semantic-version tag | Refuse without mutation. |
| Untrusted source | Source is not the canonical public repository or the receipt and marketplace source disagree | Refuse without mutation. |
| Unverifiable checkout | Receipt is malformed, a missing receipt cannot be reconstructed exactly, receipt path is unsafe, root is dirty, `HEAD` or ref differs from verified metadata, or bounded Git inspection fails | Refuse without mutation. |
| Newer/equal incompatible request | Target is older than the installed version, or metadata cannot establish an ordered semantic version | Refuse without mutation; downgrade is not an upgrade. |

Refusal is a successful safety outcome. Diagnostics should identify the category and point to the
manual inspection procedure without guessing how to repair unknown state.

## Supported transition

For a supported healthy version `vA` and target package version `vB`, where `vB > vA`:

1. Complete all runtime, Codex-state, receipt, Git-root, target-tag, and configuration-preservation
   preflight checks.
2. Hold an in-memory snapshot containing only the prior public marketplace source/ref/revision and
   plugin names, versions, and enabled states. Never persist credentials or device configuration.
3. Remove `roku-engineering@roku-codex-toolkit`.
4. Remove `roku-device-toolkit@roku-codex-toolkit`.
5. Remove the `roku-codex-toolkit` marketplace.
6. Add `preciousidam/roku-codex-toolkit --ref vB`.
7. Add `roku-device-toolkit@roku-codex-toolkit`.
8. Add `roku-engineering@roku-codex-toolkit`.
9. Reinspect and require the canonical source, target ref/revision, both target plugin versions,
   installed state, and enabled state.

The device target file and Keychain are outside this sequence and must remain untouched. The
command should instruct the user to restart Codex only after final verification succeeds.

## Rollback model

Any thrown error, nonzero exit, timeout, cancellation, malformed response, or failed final
verification after step 3 begins triggers reconciliation toward the snapshot:

1. Reinspect current state because a failed or timed-out command may have mutated persistent state.
2. Remove either toolkit plugin if currently installed from the toolkit marketplace.
3. Remove the toolkit marketplace if present.
4. Re-add the snapshot's canonical source with its exact immutable ref.
5. Re-add both snapshot plugins in their original order.
6. Reinspect the receipt, revision, plugin versions, installed state, and enabled state against the
   snapshot.

Rollback operations are bounded and best-effort as a group: one rollback failure must not prevent
later recovery attempts. The final error reports the initiating failure separately from every
rollback or verification failure. It contains no environment values, configuration contents, or
command output that could expose secrets.

If rollback verifies the snapshot, retrying the upgrade is safe. If rollback cannot be verified,
the command stops and directs the user to inspect Codex state; it must not automatically retry or
claim either version is installed.

## Concurrency and interruption boundary

Codex does not expose a marketplace transaction lock. The first implementation must use a private,
process-owned lock file in the toolkit configuration directory, created atomically and containing no
secret data. A live lock refuses a second toolkit setup/upgrade operation. Stale-lock recovery must
require explicit inspection rather than age-based deletion.

Subprocesses remain shell-free, bounded, and process-tree cancellable. Tests must inject failure
before and after every mutation, including ambiguous failures where Codex changes state before
returning nonzero or timing out.

## Acceptance tests for implementation

- Cross-platform success and already-at-target no-op cases.
- Every refused state in the classification table performs zero mutation.
- Failure and ambiguous failure at every mutation step restore the exact snapshot.
- Rollback continues after individual recovery failures and reports them separately.
- Final-state verification catches wrong source, ref, revision, version, plugin set, or enabled state.
- Cancellation and timeout terminate descendants and enter the same reconciliation path.
- Concurrent invocation is refused without touching Codex state.
- Device configuration and credential stores are byte-for-byte or status-equivalent before and
  after success, refusal, failure, and rollback.

Until all implementation tests and the v0.3.0 release gates pass, the existing conservative setup
behavior and documented manual upgrade procedure remain the supported fallback.
