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

The repository is a Codex marketplace source, not an npm or PyPI package. Keeping the root npm package private prevents accidental registry publication. Public distribution should initially use tagged GitHub source releases after the release checklist passes.

## Follow-up backlog

- P2: add mocked HTTP/digest and socket integration tests, including Windows process-tree cancellation.
- P3: add JSON Schema files for flow scenarios and reports.
- P3: add structured server logging with automatic redaction.
- P3: evaluate signed release artifacts and checksums once distribution begins.
- P3: build a static documentation portal and marketplace media only after v0.1.0 behavior freezes.

## License recommendation

Apache License 2.0 is recommended because this is developer tooling intended for broad commercial and open-source use, and its explicit patent grant is useful for ecosystem adoption. MIT is a reasonable simpler alternative if minimal text is the overriding preference. See [the license evaluation](license-evaluation.md). No license should be added until the owner approves the choice.
