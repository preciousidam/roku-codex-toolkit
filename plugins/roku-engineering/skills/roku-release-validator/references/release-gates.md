# Roku release gates

## Source integrity

- Correct issue/release branch and target branch.
- No unrelated tracked or untracked artifacts.
- Reviewed diff and known merge base.
- Commit and PR link back to the intended issue/release.

## Build integrity

- Repository-defined compile or BrighterScript validation command.
- Repository-defined unit or package-build tests.
- Repository-defined production packaging command.
- Repository health or policy checks when defined.
- `git diff --check`

## Package integrity

- Manifest title/version/build are intentional.
- Production package uses production public configuration only.
- No `.env`, credentials, logs, screenshots, test fixtures with accounts, or local analysis files.
- Package output exists at the expected release path and is attributable to the reviewed commit.

## Runtime acceptance

- Cold launch and relaunch.
- Sign-in/session restoration and sign-out.
- Subscription/paywall path when affected.
- VOD entitlement, DRM, start, seek, pause/resume, and completion when affected.
- FAST launch/channel switching when affected.
- Deep links and Back behavior when affected.
- Focus visibility and no unreachable controls.

## Promotion and recovery

- Required CI passes on the exact head SHA.
- Roku app and companion service deployments are promoted independently when applicable.
- Feature flags and rollback commit/package are identified.
- Store submission remains a separate user-authorized external action.
