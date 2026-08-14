# Stabilization audit

Audit date: 2026-08-11. Scope: architecture, security, portability, packaging, usability, tests, CI, and public-release readiness. The review is source- and host-test-based; no physical Roku result is claimed.

## Architecture

The current language boundary is appropriate. Python owns network/device behavior, flow execution, analysis, and the dependency-free MCP server. Node owns Codex installation and cross-platform interpreter launching. A rewrite would add packaging risk without a demonstrated benefit.

The two-plugin split is also coherent: device access has materially different permissions and failure modes from repository-only engineering guidance. The MCP server delegates to the same CLI scripts used by skills, which keeps behavior inspectable and reusable.

## Highest-priority findings

| Priority | Finding | Release disposition |
| --- | --- | --- |
| P1 | A single 931-line validation program mixed repository assertions, protocol tests, and behavior tests, making failures hard to isolate and changes hard to review. | Replace with Node and Python unit-test suites plus a thin validation orchestrator. |
| P1 | The configuration parent directory could inherit permissive POSIX permissions even though the file itself was mode `0600`. | Create and harden it to `0700`; retain atomic `0600` file replacement. |
| P1 | Keychain and interpreter-probe subprocesses had no explicit timeout. | Bound probes and Keychain calls; fail closed without exposing credentials. |
| P1 | Evidence semantics could regress into treating capture success as UI verification. | Keep screenshot steps `pending_visual_review`; test this invariant and document it as a release gate. |
| P2 | Cross-platform support was described without a CI matrix or an explicit distinction between host tests and hardware tests. | Add macOS/Linux/Windows CI and state the evidence boundary. |
| P2 | Public contribution, release, compatibility, and tooling-scope documentation was absent. | Add contributor, release-boundary, and comparison documents plus a safe example. |
| P2 | Explicit artifact validation was check-then-use and could not prevent a same-user symlink race in a hostile shared directory. | Completed: all explicit destinations now use a common private atomic replacement helper that pins the resolved parent and validates the destination and staging-file identities at commit. |
| P2 | MCP request IDs shared process-global cancellation maps without rejecting duplicate concurrent IDs. | Completed: IDs are atomically reserved until response cleanup; duplicate, cancellation, reuse, and concurrency behavior is covered by tests. |

## Security model

- ECP is unauthenticated Roku LAN control. The code bypasses ambient HTTP proxies and bounds requests.
- Developer-mode operations use digest authentication through `curl`; the password is provided on stdin through curl config rather than argv. Authenticated operations pin DNS resolution to an accepted private IPv4 address.
- macOS uses Keychain. Linux and Windows intentionally rely on process-scoped `ROKU_DEV_PASSWORD`; the toolkit does not invent plaintext credential storage.
- Sideload requires explicit replacement confirmation and checks the installer response. Screenshot downloads validate file signatures before replacement.
- Flow artifacts use private directories and atomic private text writes. Logs and screenshots can still contain sensitive data and must be treated as secrets.
- MCP subprocesses run without a shell, have computed timeouts, run in process groups on POSIX, and support cancellation. Windows termination is best-effort and must be covered by CI process tests; descendant-process behavior has not been hardware-tested.

## Portability and packaging

Paths are derived from script locations and plugin-relative MCP configuration. Interpreter discovery covers `python3`, `python`, and Windows `py -3`. Runtime code uses Python 3.9-compatible syntax. POSIX modes are asserted only on POSIX; Windows ACL equivalence is not claimed.

The repository is both a Codex marketplace source and, since v0.2.0, a public npm delivery package;
it is not a PyPI package. npm installation is side-effect free, while explicit setup registers the
matching versioned Git tag as the durable marketplace source. Publication remains restricted to the
protected release workflow after the release checklist passes.

## Follow-up backlog

- Completed: loopback HTTP/digest and socket integration tests cover device boundaries; Windows CI covers process-tree cancellation.
- Completed: Draft 2020-12 JSON Schemas document flow scenarios and generated reports and are checked by repository validation.
- P3: add structured server logging with automatic redaction.
- P3: evaluate signed release artifacts and checksums if npm provenance and Git-tag comparison prove
  insufficient for a concrete adopter or policy requirement.
- Completed: the static documentation portal and sanitized marketplace media are published through
  the isolated GitHub Pages workflow.

## License decision

Apache License 2.0 was approved and added because this is developer tooling intended for broad commercial and open-source use, and its explicit patent grant is useful for ecosystem adoption. MIT was the simpler alternative considered. See [the license evaluation](license-evaluation.md).
