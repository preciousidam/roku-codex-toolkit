# Physical Roku validation matrix

Status: **partially executed; v0.1.0 hardware gate remains blocked**. A physical run on 2026-08-11 covered queries, interaction delivery, launch, screenshot, console, confirmed sideload, and evidence-aware flow cases. Independent UI confirmation of the keypress and text-entry effects remains incomplete, so no complete hardware pass is claimed.

Run this matrix from one supported host first. Additional host/device combinations are useful evidence but are not required to prove every permutation. Before starting, record only non-sensitive metadata:

- Validation date and tested commit
- Host OS and version
- Roku model number
- Roku OS/firmware version
- A sanitized local evidence label, such as `local-run-2026-08-11` (never a committed path containing a user name)

Do not put a device IP address, developer password, token, serial number, device ID, private app name, entered personal data, screenshot, raw XML, ZIP, or console log in Git. Store raw evidence in a private local directory with restricted access. The references below should identify an operator-controlled local evidence set without revealing its contents or location.

## Execution checklist

- [x] Confirm the target is a test Roku on the same trusted network and developer mode is intentionally enabled.
- [x] Use an approved external test build and test account/state. Confirm the exact ZIP before sideloading; sideload replaces the current development channel.
- [x] Create a private evidence directory outside the repository.
- [x] Record device info and active-app query success; sanitize model and firmware into the result table, and keep raw XML private.
- [ ] Send a harmless keypress and verify its expected effect independently. Delivery completed, but visual verification remains pending.
- [ ] Focus a disposable text field, enter a non-secret marker, and verify the resulting text independently. A non-secret marker was delivered, but visual verification remains pending.
- [x] Launch the development channel or an approved public test channel/deep link; verify active-app state independently.
- [x] Capture a screenshot, then visually inspect it. Capture success alone is not a UI pass.
- [x] Capture a short BrightScript console window and confirm expected startup output is present. Keep the raw log private.
- [x] Sideload the pre-confirmed development ZIP with `--yes`; require the installer success response, then independently query the active app.
- [x] Run `examples/flow/hardware-pass.json`; require its query checkpoint to pass.
- [x] Run `examples/flow/hardware-intentional-failure.json`; require the flow to fail because its impossible query checkpoint is absent. A command-only success is not a passing flow.
- [ ] Remove or retain local artifacts according to the operator's private-data policy; commit only this sanitized result table.

## Result record

Replace `Pending` only after observing the corresponding evidence. Use a local evidence label, not a sensitive path.

| Host OS | Roku model | Roku OS/firmware | Scenario | Outcome | Sanitized artifact reference |
| --- | --- | --- | --- | --- | --- |
| macOS 26.5.2 | 4662RW | 15.3.4 | Device info and active app | Pass | `local-run-2026-08-11/item-01` |
| macOS 26.5.2 | 4662RW | 15.3.4 | Keypress and disposable text entry | Partial: commands completed; independent UI confirmation pending | `local-run-2026-08-11/item-02` |
| macOS 26.5.2 | 4662RW | 15.3.4 | Development-channel launch | Pass: active-app independently reported `dev` | `local-run-2026-08-11/item-03` |
| macOS 26.5.2 | 4662RW | 15.3.4 | Screenshot capture plus visual review | Pass after confirmed sideload: valid private 1920×1080 image showed a complete foreground UI and visible focus; no broader UI correctness claimed | `local-run-2026-08-11/item-04` |
| macOS 26.5.2 | 4662RW | 15.3.4 | BrightScript console capture | Pass: non-empty private capture; raw log not committed | `local-run-2026-08-11/item-05` |
| macOS 26.5.2 | 4662RW | 15.3.4 | Confirmed sideload plus active-app query | Pass: approved external test ZIP received explicit installer success; active-app independently reported `dev` | `local-run-2026-08-11/item-06` |
| macOS 26.5.2 | 4662RW | 15.3.4 | Evidence-aware passing flow | Pass: required active-app checkpoint verified | `local-run-2026-08-11/item-07` |
| macOS 26.5.2 | 4662RW | 15.3.4 | Intentionally failing flow | Expected failure observed: impossible checkpoint was not found | `local-run-2026-08-11/item-08` |

For every completed row, record `Pass` or `Expected failure observed` and a label such as `local-run-YYYY-MM-DD/item-03`. If a check fails unexpectedly, record a sanitized failure summary and keep v0.1.0 tagging blocked until it is fixed or explicitly removed from the release boundary.
