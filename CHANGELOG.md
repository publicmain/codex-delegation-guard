# Changelog

## 0.2.1

- Treat background and system notifications as continuations, not new user turns: preserve line budgets, reasons, denial fingerprints, pauses and reminder cadence.
- Add `reminderRequiresGit` (default `true`) to optionally allow coding-prompt reminders outside Git work trees.
- Prepare public GitHub manifests, English and Simplified Chinese documentation, and a Windows/macOS/Linux CI matrix for Node 18, 20 and 22.

## 0.2.0

- Inject the split-first policy and division-of-labour criteria at session startup, resume and compaction; add rate-limited coding-prompt reminders.
- Add a turn-scoped `justify` CLI reason for identical soft-mode retries.
- Add reasons, delegation rates and size metrics to seven-day `stats`.

## 0.1.0

- Introduce the code-write guard with per-call and per-turn limits in Git work trees.
- Add soft, strict and off modes, pause/resume/status commands, delegation observation and metadata-only logs.
- Keep hooks fail-open and dependency-free on Node 18 or later.
