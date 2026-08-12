# Flow scenario format

Use JSON so the runner remains dependency-free.

Machine-readable contracts are available for both the
[scenario](flow-scenario.schema.json) and generated [report](flow-report.schema.json).
Editors can associate the scenario schema with flow files for completion and early validation.
JSON Schema validates structure and individual fields, but it cannot express semantic rules that
compare normalized values across steps. In particular, two artifact paths must not resolve to the
same case-folded destination; `same.xml` and `./same.xml` are duplicates.

Run the companion semantic preflight before using a scenario:

```bash
python3 "<roku-flow-verifier-skill-dir>/scripts/run_flow.py" \
  --scenario /tmp/flow.json \
  --evidence-dir /tmp/roku-flow-preflight \
  --host 192.168.1.50 \
  --dry-run
```

`--dry-run` performs runner preflight without device actions and writes a report describing any
invalid steps. The host may instead come from `ROKU_DEV_TARGET` or saved toolkit configuration.

```json
{
  "name": "launch-and-open-sidebar",
  "host": "192.168.1.50",
  "continue_on_failure": false,
  "steps": [
    {"action": "query", "kind": "info", "save": "device.xml"},
    {"action": "launch", "channel_id": "dev"},
    {"action": "pause", "seconds": 5},
    {"action": "press", "keys": ["left"], "delay": 0.4},
    {"action": "screenshot", "save": "sidebar.jpg"},
    {"action": "query", "kind": "active-app", "save": "active-app.xml", "contains": "dev"}
  ]
}
```

Supported actions:

- `query`: `kind` is `info`, `apps`, `active-app`, or `player`; optionally save output and require a case-sensitive `contains` string.
- `launch`: accepts `channel_id`, optional `content_id`, and optional `media_type`.
- `press`: accepts a non-empty `keys` array and optional delay.
- `text`: accepts `value`; never store real credentials in scenario files.
- `pause`: accepts finite numeric seconds from 0 through 3600.
- `screenshot`: requires a relative `save` path ending in `.jpg`, `.jpeg`, or `.png`.

All saved paths must remain inside the evidence directory and must be unique after normalization.
The runner writes `report.json` with timing, command status, and checkpoint results. A successful
screenshot action proves only that an image was captured; inspect it before passing visual criteria.
