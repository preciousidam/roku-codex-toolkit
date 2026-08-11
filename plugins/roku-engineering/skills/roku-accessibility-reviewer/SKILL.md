---
name: roku-accessibility-reviewer
description: Review Roku SceneGraph interfaces for accessibility and remote-control usability. Use for focus order and visibility, unreachable controls, Back-button behavior, text clipping, contrast, overscan, readable sizing, loading/error focus recovery, keyboard and dialog navigation, screen-reader metadata where applicable, and screenshot-backed UI audits across Roku display modes.
---

# Roku Accessibility Reviewer

Combine static SceneGraph inspection with `$roku-device-operator` screenshots and `$roku-flow-verifier` navigation. Read [references/review-checklist.md](references/review-checklist.md).

## Workflow

1. Identify the screen, entry paths, actionable controls, modal layers, and supported resolutions.
2. Trace `initialFocus`, `focusedChild`, `setFocus`, visibility, and `onKeyEvent` behavior statically.
3. Exercise every control using only the Roku remote. Verify directional movement is predictable and no focus trap exists.
4. Capture screenshots for default, focused, disabled, loading, error, modal, and long-content states where applicable.
5. Verify Back closes the nearest transient surface before leaving the route/app.
6. Report discrete issues with source location, reproduction keys, visible impact, and recommended behavior.

Do not infer contrast or clipping solely from XML values when compositing, fonts, scaling, or runtime text affects the result. Do not claim screen-reader support without device/platform evidence.
