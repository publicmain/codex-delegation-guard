---
description: Pause the delegation guard for the rest of this session
allowed-tools: Bash(node:*)
---

Run this command through Bash in the current project, then report its result.
Use the actual current session ID; never invent one or reuse another session's ID.

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/guard.mjs" pause --session-id "${CLAUDE_SESSION_ID}"
```

This pauses this session across subsequent prompts. It does not edit configuration.
