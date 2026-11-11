# Privacy

codex-delegation-guard runs entirely on your machine. It makes no network requests and sends nothing to any service, including the plugin author.

## What it reads
- The hook input Claude Code passes to it: session id, working directory, tool name and tool arguments. Prompt text is read only to detect pause phrases and notification markers.
- For a `Write` to an existing file, the current file content, so it can count the changed lines.
- Its own config files: `~/.claude/delegation-guard.json` and `<repo>/.claude/delegation-guard.json`.

## What it stores, all locally
- **Per-session state** in your OS temp directory under `codex-delegation-guard/`:
  - line counts for the turn and the session;
  - pause flags;
  - reminder cadence;
  - a SHA-256 fingerprint of the last blocked change;
  - the one-line reason Claude recorded with `justify`, if any.
- **A log** at `~/.claude/delegation-guard/log.jsonl`. It rotates at 5 MB. Each entry holds:
  - time and session id;
  - project folder name and file path relative to the repository;
  - line count, decision, tool name and delegation events;
  - the recorded reason for an override.

It never stores file contents, prompts, command text or transcripts.

## Credentials
It reads no credentials, tokens or keys.

## Deleting the data
Delete `~/.claude/delegation-guard/` and the `codex-delegation-guard/` folder in your temp directory. Uninstalling the plugin stops all collection.

## Reasons are your text
Reasons recorded with `justify` are written by Claude in your session and stored as-is. Don't put sensitive data in them.
