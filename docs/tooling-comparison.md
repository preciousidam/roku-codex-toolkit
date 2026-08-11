# Relationship to other Roku tooling

This toolkit is an automation and evidence layer for Codex. It is complementary to editor, build, debug, and publishing tools.

| Capability | Roku Codex Toolkit | Roku Dev Studio / editor tooling | Roku platform tools and portal |
| --- | --- | --- | --- |
| BrightScript/SceneGraph editing and language features | Guidance only | Primary use case | Not primary |
| Build/package iteration | Release checks and agent workflows | Commonly integrated | Platform-defined packaging rules |
| Remote keypresses and ECP queries | Built in, bounded, agent-callable | May overlap through extensions | ECP defines the interface |
| Sideloading and screenshots | Built in with confirmation and artifact checks | Often overlaps | Developer mode provides endpoints |
| Runtime console capture and causal triage | Capture plus analysis workflow | Debug-console overlap | Device exposes the console |
| Repeatable UI flows | JSON scenarios and evidence reports | May offer manual/device controls | No claim of full UI automation |
| UI correctness | Requires assertions and/or human visual review | Human/debugger inspection | Certification and testing remain external |
| Channel publishing, certification, account management | Out of scope | Usually out of scope | Primary platform responsibility |

The overlap is intentional where Codex needs a safe, scriptable primitive. The toolkit does not bundle or impersonate Roku services, replace certification, or claim that an ECP command succeeding means the displayed UI is correct.
