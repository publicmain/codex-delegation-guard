---
description: Resume the delegation guard in this session
allowed-tools: Bash(node:*)
---

Run this command through Bash in the current project, then report its result.
Use the actual current session ID; never invent one or reuse another session's ID.

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/guard.mjs" resume --session-id "${CLAUDE_SESSION_ID}"
```

This clears both the session pause and the prompt pause. Existing line counters remain.
