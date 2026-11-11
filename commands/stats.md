---
description: Review seven-day delegation rates, sizes and recent override reasons by project
allowed-tools: Bash(node:*)
---

Run this command through Bash, then summarize the JSON result by project.

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/guard.mjs" stats
```

Report lines allowed, denials, overrides and observed delegations for the last seven days.
The report includes rotated logs. Denied lines do not count as lines written.
Include `recentOverrides` (the ten most recent paths and reasons) and the total and
per-project metrics: delegation rate, allowed-large count, override size median,
delegated-turn size median and number of measurable delegated turns.
The rate is delegations / (delegations + overrides + allowedLarge).
Explain null rates/sizes as unavailable; do not infer sizes for legacy dispatches.
