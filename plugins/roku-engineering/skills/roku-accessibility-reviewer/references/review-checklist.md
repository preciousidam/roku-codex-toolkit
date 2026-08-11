# Roku accessibility and remote usability checklist

## Focus

- A visible control receives initial focus after content is ready.
- Focus indicator is unmistakable on every background.
- Directional navigation matches spatial layout and has no dead ends.
- Hidden, disabled, or removed nodes cannot retain focus.
- Dialogs and paywalls trap focus while open and restore it on close.
- Network errors return focus to a retryable action.

## Remote behavior

- OK performs the focused action once.
- Back closes keyboard/dialog/detail layers in order and does not unexpectedly exit.
- Play/Pause, Replay, Options, and transport keys behave consistently where supported.
- Repeated keypresses do not create duplicate overlays or requests.

## Readability and layout

- Text remains legible at intended viewing distance and display modes.
- Long/localized text wraps or truncates intentionally without hiding meaning.
- Focused/unfocused and enabled/disabled states do not rely only on color.
- Content stays within title-safe/overscan bounds.
- Busy, error, empty, and offline states explain what happened and expose a next action.

## Evidence

For each issue, record screen, starting state, exact remote sequence, expected result, actual result, screenshot path, device model/OS, and relevant XML/BrightScript location.
