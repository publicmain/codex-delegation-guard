---
name: delegation-guard
description: Decide the Claude/Codex split before editing, then dispatch, wait, verify or justify direct work when the guard fires.
---

A piece of work suits Codex when ALL of these hold:
1. It can be written as a self-contained brief of about one page, without the conversation history.
2. It has an objective acceptance check, such as tests, a probe, or a data comparison.
3. It is big or slow enough that the brief plus the verification cost less than doing it, or it can run while the lead does something else.

It stays with Claude when ANY of these holds:
- it depends on context that is costly to transfer;
- it needs judgement, trade-offs or the user's decision;
- it is a small edit;
- verifying it would cost about as much as doing it.

Claude always keeps these jobs: splitting the work, writing briefs, verifying on the real path, integrating and committing.

For a coding task, state the split in one line before the first edit:
"Split: Codex does X (brief + tests), I do Y."
Use the criteria to decide; a line threshold is a prompt to reconsider the split.
SessionStart re-injects this policy on startup, resume and compact.
UserPromptSubmit reminds you before editing eligible coding tasks in a git work tree.

## When the guard fires

The guard has identified a substantial direct code change.
Choose either delegation with a brief, or direct work with a one-line reason.
Follow the user's scope, data restrictions and permission to change files.
Never send personal or student data to Codex, including in a brief or log.
Replace sensitive examples with synthetic fixtures before dispatching.

## Prepare a self-contained brief

Include these items so a worker needs no hidden conversation context:
- Goal and the concrete behavior that should change.
- Repository path, relevant files, and the files the worker owns.
- Constraints, existing conventions and actions that are out of scope.
- What done looks like, including edge cases and acceptance checks.
- The project's exact test command and relevant validation commands.
- A requirement to show new tests failing on base before they pass on the fix.

Do not ask the worker to commit unless the user explicitly authorized it.
Keep independent workers' file ownership separate when parallel work is useful.

## Dispatch and check progress

Use the official openai/codex-plugin-cc integration already installed by the user.
Dispatch with `/codex:rescue --background` and the brief.
Alternatively, use the `codex:codex-rescue` subagent with the same brief.
Use that integration's documented options; do not invent companion CLI flags.
Save the returned job ID, worker PID and output/artifact paths when available.
About 15 seconds after dispatch, check that the job is actually running.
If it never started, report the dispatch failure and inspect the recorded error.

Continue useful independent work while the worker runs.
Avoid editing the worker's files at the same time.
Wait for completion with the integration's `status --wait` operation.
Keep progress checks bounded so the user still receives useful updates.

## Handle a vanished job record

A known codex-plugin-cc race can remove a job record before work completes.
If `status --wait` errors, first check whether the recorded worker is alive.
If it is alive, wait for that process to finish instead of declaring success.
Then call the integration's `result` operation and inspect its output artifacts.
If the process is gone and no result exists, report an unresolved job.
A missing record alone proves neither success nor failure.

## Verify and finish on the real path

Read the actual diff in the target repository after the worker finishes.
Check scope, correctness, data handling and unwanted unrelated changes.
Run the project's real tests through its normal entry point.
For new tests, demand evidence that they fail on base and pass on the change.
Verify that failures reflect the intended regression, not a setup error.
Worker assertions alone do not replace inspecting the diff and test evidence.
If the user authorized a commit, commit yourself after verification;
Codex workers often cannot commit. Otherwise leave changes for review.
Report what changed, the checks run and any limits that remain.

Soft mode requires a reason before an identical retry in the same turn by default.
Run the exact command printed by the guard, which includes its absolute script path
and the hook's session ID: `node "<absolute-plugin-path>/scripts/guard.mjs" justify --session-id <id> --reason "<why this stays with Claude>"`.
Then retry the identical change; a different change still receives its first denial.
The reason is trimmed, capped at 200 characters and logged on overrides; keep it free of sensitive data.
A new user prompt clears the reason. `requireReason:false` restores the v0.1 retry flow.
Strict mode requires a pause to allow an oversized direct change.
Use pause only when it fits the user's instructions; never silently disable the guard.
