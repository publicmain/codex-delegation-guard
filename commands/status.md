---
description: Show mode, thresholds, pauses, session lines and observed delegations
---

Run this command through Bash in the current project and summarize the JSON result.
Use the actual current session ID; never invent one or reuse another session's ID.

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/guard.mjs" status --session-id "${CLAUDE_SESSION_ID}"
```

Report mode, per-call/per-turn thresholds, pause state, turn/session lines and delegations.
Include planReminder, requireReason and the current turn's justification when present.
These count permitted tool proposals and observed dispatch attempts, not completed work.
