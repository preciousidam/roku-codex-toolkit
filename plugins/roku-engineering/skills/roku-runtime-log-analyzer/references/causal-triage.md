# Causal triage

Prioritize signatures in this order:

1. BrightScript runtime error, debugger stop, parse/compile error, or unhandled exception.
2. First failed network/auth/entitlement/license request preceding a playback failure.
3. Invalid state transition, missing content field, focus loss, or task timeout.
4. Downstream user-facing error.
5. Repeated warnings unrelated to the failure.

Common distinctions:

- `signalBeacon ... already signaled` is usually secondary.
- `ParseJSON: Data is empty` followed by array/index access indicates an unguarded boundary response.
- Entitlement `401` plus `missing_token` describes the playback block; inspect why no valid or refreshable session header was sent.
- A backtrace file/line is stronger evidence than a nearby log label, but only for the matching package digest/version.
- Multiple exports with identical dates, totals, and signatures may be alternate views of the same incidents; do not sum them blindly.

Always include the smallest source location that owns the violated contract and the runtime scenario that reaches it.
