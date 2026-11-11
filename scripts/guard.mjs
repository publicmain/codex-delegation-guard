#!/usr/bin/env node
// Node >=18, deliberately dependency-free. Hook failures always allow the tool.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const DEFAULTS = Object.freeze({
  mode: 'soft',
  perCallLines: 60,
  perTurnLines: 150,
  planReminder: 'auto',
  reminderRequiresGit: true,
  nonUserPromptMarkers: [
    '<task-notification', '<system-reminder', '[SYSTEM NOTIFICATION',
    '<cross-session-message', '<side-sessions-event', '<ci-monitor-event',
  ],
  requireReason: true,
  codeExtensions: [
    '.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.mts', '.cts', '.py', '.pyw',
    '.rb', '.php', '.java', '.kt', '.kts', '.go', '.rs', '.c', '.h', '.cc', '.cpp',
    '.cxx', '.hpp', '.cs', '.fs', '.fsx', '.vb', '.swift', '.m', '.mm', '.scala',
    '.sc', '.sh', '.bash', '.zsh', '.ps1', '.psm1', '.psd1', '.bat', '.cmd', '.sql',
    '.html', '.htm', '.css', '.scss', '.sass', '.less', '.vue', '.svelte', '.astro',
    '.ex', '.exs', '.erl', '.hrl', '.clj', '.cljs', '.cljc', '.dart', '.r', '.jl',
    '.lua', '.pl', '.pm', '.groovy', '.gradle', '.tf', '.tfvars', '.sol', '.proto',
    '.graphql', '.gql', '.ipynb', '.razor', '.cshtml',
  ],
  excludeGlobs: [
    'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml',
    'bun.lockb', 'go.sum', 'Cargo.lock', 'Gemfile.lock', 'Pipfile.lock',
    '*.min.*', 'dist/', 'build/', 'node_modules/', 'vendor/', '.git/',
    'generated/', '__generated__/', '.generated/', '.next/', '.nuxt/', 'coverage/',
    '*.md', '*.txt', '*.json', '*.yaml', '*.yml', '*.toml', '*.lock', '*.csv', '*.svg',
  ],
  pausePhrases: ['这次你自己写', '你自己写', '自己改', 'write it yourself', 'no codex'],
});
const CHANGE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
const OBSERVE_TOOLS = new Set(['Bash', 'Agent', 'Task']);
const DAY = 86_400_000;
const LOG_LIMIT = 5 * 1024 * 1024;
const DIFF_CELLS = 1_000_000;
const home = process.env.HOME || process.env.USERPROFILE || os.homedir();
const stateDir = process.env.CODEX_DELEGATION_GUARD_STATE_DIR || path.join(os.tmpdir(), 'codex-delegation-guard');
const logDir = path.join(home, '.claude', 'delegation-guard');
const logFile = path.join(logDir, 'log.jsonl');
const archivePattern = /^log\.(\d{13})\.[a-f0-9]{8}\.jsonl$/;
const hash = text => createHash('sha256').update(text).digest('hex');
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const scriptPath = fileURLToPath(import.meta.url).replaceAll('\\', '/');
const CRITERIA = `A piece of work suits Codex when ALL of these hold:
1. It can be written as a self-contained brief of about one page, without the conversation history.
2. It has an objective acceptance check, such as tests, a probe, or a data comparison.
3. It is big or slow enough that the brief plus the verification cost less than doing it, or it can run while the lead does something else.
It stays with Claude when ANY of these holds:
- it depends on context that is costly to transfer;
- it needs judgement, trade-offs or the user's decision;
- it is a small edit;
- verifying it would cost about as much as doing it.
Claude always keeps these jobs: splitting the work, writing briefs, verifying on the real path, integrating and committing.`;
const SESSION_POLICY = `${CRITERIA}
Dispatch: /codex:rescue --background, or the codex:codex-rescue subagent, with a brief, keeping a waiter on it.
For a coding task, state the split in one line before your first edit: "Split: Codex does X (brief + tests), I do Y."`;
const PLAN_REMINDER = 'Before editing: state the split per the delegation criteria.\nSplit: Codex does X (brief + tests), I do Y. Keep a waiter on dispatched work; verify on the real path.';

function additionalContext(event, context) {
  process.stdout.write(`${JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: context } })}\n`);
}

function justifyCommand(session) {
  // Claude's Bash tool consumes this command. Keep ordinary IDs readable and
  // quote unusual IDs/paths so shell expansion cannot change the target session.
  const quotedPath = scriptPath.replace(/["$`]/g, char => `\\${char}`);
  const quotedSession = /^[a-zA-Z0-9_-]+$/.test(session) ? session : `'${session.replaceAll("'", "'\"'\"'")}'`;
  return `node "${quotedPath}" justify --session-id ${quotedSession} --reason "<why this stays with Claude>"`;
}

function withLock(lockPath, work) {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  const deadline = Date.now() + 750;
  while (true) {
    try {
      fs.mkdirSync(lockPath);
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      try {
        // Nothing is stored in the lock directory; recover after a killed hook.
        if (Date.now() - fs.statSync(lockPath).mtimeMs > 30_000) fs.rmdirSync(lockPath);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      if (Date.now() >= deadline) throw new Error('Lock timeout');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
  try { return work(); } finally { fs.rmdirSync(lockPath); }
}

function sessionFile(session) {
  const name = /^[a-zA-Z0-9_-]{1,128}$/.test(session) ? session : hash(session);
  return path.join(stateDir, `${name}.json`);
}

function freshState() {
  return {
    turnLines: 0, sessionLines: 0, lastDeniedFingerprint: null,
    paused: false, turnPaused: false,
    promptCount: 0, lastPlanReminderPrompt: null, justification: null, turnDeniedLines: null,
    delegations: { total: 0, bash: 0, agent: 0, task: 0 },
  };
}

function readState(file) {
  let value;
  try { value = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return freshState(); throw error; }
  const counter = number => Number.isSafeInteger(number) && number >= 0;
  if (!object(value) || !counter(value.turnLines) || !counter(value.sessionLines)
    || typeof value.paused !== 'boolean' || typeof value.turnPaused !== 'boolean'
    || !(value.lastDeniedFingerprint === null || /^[a-f0-9]{64}$/.test(value.lastDeniedFingerprint))
    || !object(value.delegations) || !['total', 'bash', 'agent', 'task'].every(key => counter(value.delegations[key]))) {
    throw new Error('Invalid state');
  }
  // Missing v0.2 fields are normal for installed v0.1 sessions. Corrupt fields
  // still fail open through the outer handler rather than authorizing a retry.
  value = { ...freshState(), ...value };
  if (!counter(value.promptCount)
    || !(value.lastPlanReminderPrompt === null || (counter(value.lastPlanReminderPrompt) && value.lastPlanReminderPrompt <= value.promptCount))
    || !(value.turnDeniedLines === null || counter(value.turnDeniedLines))
    || !(value.justification === null || (object(value.justification)
      && typeof value.justification.reason === 'string' && value.justification.reason.trim().length > 0
      && Array.from(value.justification.reason).length <= 200 && typeof value.justification.at === 'string'
      && Number.isFinite(Date.parse(value.justification.at))))) throw new Error('Invalid v0.2 state');
  return value;
}

function updateSession(session, work) {
  const file = sessionFile(session);
  return withLock(`${file}.lock`, () => {
    const state = readState(file);
    const result = work(state);
    const temporary = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
    try {
      fs.writeFileSync(temporary, JSON.stringify(state), { mode: 0o600, flag: 'wx' });
      fs.renameSync(temporary, file);
    } finally {
      try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    return result;
  });
}

function readConfigLayer(file) {
  let parsed;
  try { parsed = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); }
  catch (error) {
    if (error.code === 'ENOENT') return {};
    if (error instanceof SyntaxError) return { ...DEFAULTS };
    throw error;
  }
  if (!object(parsed)) return { ...DEFAULTS };
  const valid = {
    mode: value => ['soft', 'strict', 'off'].includes(value),
    perCallLines: value => Number.isSafeInteger(value) && value > 0,
    perTurnLines: value => Number.isSafeInteger(value) && value > 0,
    planReminder: value => ['auto', 'always', 'off'].includes(value),
    reminderRequiresGit: value => typeof value === 'boolean',
    nonUserPromptMarkers: value => Array.isArray(value) && value.every(item => typeof item === 'string' && item.trim().length > 0),
    requireReason: value => typeof value === 'boolean',
    codeExtensions: value => Array.isArray(value) && value.every(item => typeof item === 'string' && /^\.[a-z0-9]+$/i.test(item)),
    excludeGlobs: value => Array.isArray(value) && value.every(item => typeof item === 'string' && item.trim().length > 0),
    pausePhrases: value => Array.isArray(value) && value.every(item => typeof item === 'string' && item.trim().length > 0),
  };
  return Object.fromEntries(Object.entries(valid).filter(([key]) => Object.hasOwn(parsed, key))
    .map(([key, check]) => [key, check(parsed[key]) ? parsed[key] : DEFAULTS[key]]));
}

function configFor(repo) {
  return {
    ...DEFAULTS,
    ...readConfigLayer(path.join(home, '.claude', 'delegation-guard.json')),
    ...(repo ? readConfigLayer(path.join(repo, '.claude', 'delegation-guard.json')) : {}),
  };
}

function resolveFile(cwd, file) {
  if (typeof cwd !== 'string' || typeof file !== 'string' || !file || file.includes('\0')) throw new Error('Invalid path');
  // Backslashes are accepted even when a test is run on POSIX. A Windows drive
  // cannot designate a local file on POSIX, so leave it outside guard scope there.
  if (process.platform !== 'win32' && path.win32.isAbsolute(file)) {
    if (/^[a-z]:/i.test(file) || file.startsWith('\\\\')) throw new Error('Foreign absolute path');
  }
  return path.resolve(cwd, file.replaceAll('\\', '/'));
}

function nearestExisting(file) {
  let current = file;
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (current === parent) throw new Error('No existing ancestor');
    current = parent;
  }
  const resolved = fs.realpathSync(current);
  return { current, resolved };
}

function realTarget(file) {
  const { current, resolved } = nearestExisting(file);
  return path.join(resolved, path.relative(current, file));
}

function gitRoot(file) {
  const { resolved } = nearestExisting(file);
  const directory = fs.statSync(resolved).isDirectory() ? resolved : path.dirname(resolved);
  const args = ['-C', directory, 'rev-parse', '--show-toplevel'];
  const env = { ...process.env };
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR']) delete env[key];
  const options = { encoding: 'utf8', timeout: 2000, windowsHide: true, env };
  let result = spawnSync('git', args, { ...options, stdio: ['ignore', 'pipe', 'ignore'] });
  if (result.error?.code === 'EPERM') {
    // Windows restricted environments may forbid pipe creation, while permitting
    // the same real git process with regular file descriptors.
    fs.mkdirSync(stateDir, { recursive: true });
    const output = path.join(stateDir, `git-${process.pid}-${randomBytes(4).toString('hex')}.tmp`);
    const fd = fs.openSync(output, 'wx', 0o600);
    try {
      result = spawnSync('git', args, { ...options, stdio: ['ignore', fd, 'ignore'] });
      result.stdout = fs.readFileSync(output, 'utf8');
    } finally { fs.closeSync(fd); fs.unlinkSync(output); }
  }
  if (result.error) throw result.error;
  if (result.status !== 0) return null;
  return fs.realpathSync(result.stdout.trim());
}

function globMatches(file, pattern) {
  let glob = pattern.replaceAll('\\', '/').replace(/^\.\//, '');
  const rooted = glob.startsWith('/');
  glob = glob.replace(/^\//, '');
  const directory = glob.endsWith('/');
  if (directory) glob = glob.slice(0, -1);
  let regex = '';
  for (let i = 0; i < glob.length; i++) {
    const char = glob[i];
    if (char === '*' && glob[i + 1] === '*') {
      i++;
      if (glob[i + 1] === '/') { regex += '(?:.*/)?'; i++; }
      else regex += '.*';
    } else if (char === '*') regex += '[^/]*';
    else if (char === '?') regex += '[^/]';
    else regex += char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  const prefix = rooted || glob.includes('/') ? '^' : '(?:^|/)';
  return new RegExp(`${prefix}${regex}${directory ? '/.*$' : '$'}`, 'i').test(file);
}

function splitLines(text) {
  if (typeof text !== 'string') throw new Error('Expected content string');
  if (text === '') return [];
  const result = text.split(/\r\n|\n|\r/);
  if (result.at(-1) === '') result.pop();
  return result;
}

function changedLines(before, after) {
  const oldLines = splitLines(before);
  const newLines = splitLines(after);
  let start = 0;
  while (start < Math.min(oldLines.length, newLines.length) && oldLines[start] === newLines[start]) start++;
  let oldEnd = oldLines.length;
  let newEnd = newLines.length;
  while (oldEnd > start && newEnd > start && oldLines[oldEnd - 1] === newLines[newEnd - 1]) { oldEnd--; newEnd--; }
  const a = oldLines.slice(start, oldEnd);
  const b = newLines.slice(start, newEnd);
  if (!a.length || !b.length || (a.length + 1) * (b.length + 1) > DIFF_CELLS) return Math.max(a.length, b.length);
  const width = b.length + 1;
  const table = new Uint32Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i * width + j] = a[i] === b[j] ? 1 + table[(i + 1) * width + j + 1]
        : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
    }
  }
  let i = 0, j = 0, removed = 0, added = 0, changed = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      changed += Math.max(removed, added);
      removed = 0; added = 0; i++; j++;
    } else if (i < a.length && (j === b.length || table[(i + 1) * width + j] >= table[i * width + j + 1])) {
      removed++; i++;
    } else { added++; j++; }
  }
  return changed + Math.max(removed, added);
}

function countChange(tool, input, file) {
  if (tool === 'Write') {
    if (typeof input.content !== 'string') throw new Error('Invalid Write');
    try { return changedLines(fs.readFileSync(file, 'utf8'), input.content); }
    catch (error) { if (error.code === 'ENOENT') return splitLines(input.content).length; throw error; }
  }
  if (tool === 'Edit') return Math.max(1, splitLines(input.new_string).length);
  if (tool === 'MultiEdit') {
    if (!Array.isArray(input.edits) || !input.edits.every(object)) throw new Error('Invalid MultiEdit');
    return input.edits.reduce((sum, edit) => sum + Math.max(1, splitLines(edit.new_string).length), 0);
  }
  if (tool === 'NotebookEdit') return splitLines(input.new_source).length;
  throw new Error('Unknown tool');
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (object(value)) return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}

function appendLog(record) {
  withLock(path.join(logDir, '.log.lock'), () => {
    fs.appendFileSync(logFile, `${JSON.stringify(record)}\n`, { mode: 0o600 });
    if (fs.statSync(logFile).size > LOG_LIMIT) {
      fs.renameSync(logFile, path.join(logDir, `log.${Date.now()}.${randomBytes(4).toString('hex')}.jsonl`));
      fs.writeFileSync(logFile, '', { mode: 0o600 });
      for (const name of fs.readdirSync(logDir)) {
        const match = archivePattern.exec(name);
        if (match && Number(match[1]) < Date.now() - 7 * DAY) fs.unlinkSync(path.join(logDir, name));
      }
    }
  });
}

function recordFor(payload, repo, file, lines, decision, event = 'change') {
  return {
    time: new Date().toISOString(), session: payload.session_id,
    project: path.basename(repo || payload.cwd),
    file: file === null ? null : path.relative(repo, file).replaceAll('\\', '/'),
    lines, decision, event, tool: payload.tool_name,
  };
}

function observe(payload) {
  const { tool_name: tool, tool_input: input } = payload;
  // A reason may mention "codex exec" or companion task syntax. It is data,
  // not a dispatch. Recognize the CLI invocation before scanning its arguments.
  if (tool === 'Bash' && typeof input.command === 'string') {
    const invocation = /^\s*("[^"]+"|'[^']+'|[^\s]+)\s+("[^"]+"|'[^']+'|[^\s]+)\s+justify(?:\s|$)/i.exec(input.command);
    const basename = token => token.replace(/^["']|["']$/g, '').replaceAll('\\', '/').split('/').at(-1);
    if (invocation && /^node(?:\.exe)?$/i.test(basename(invocation[1])) && basename(invocation[2]) === 'guard.mjs') return;
  }
  const delegation = tool === 'Bash'
    ? typeof input.command === 'string' && (/\bcodex\s+exec\b/i.test(input.command)
      || (/codex-companion\.mjs/i.test(input.command) && /\s+task\b/.test(input.command)))
    : input.subagent_type === 'codex:codex-rescue';
  if (!delegation) return;
  const repo = gitRoot(payload.cwd);
  updateSession(payload.session_id, state => {
    state.turnLines = 0;
    state.delegations.total++;
    state.delegations[tool.toLowerCase()]++;
    appendLog({ ...recordFor(payload, repo, null, 0, 'allow', 'delegation'),
      turn: state.promptCount, delegatedLines: state.turnDeniedLines });
    state.turnDeniedLines = null;
  });
}

function guard(payload) {
  const input = payload.tool_input;
  const file = realTarget(resolveFile(payload.cwd, payload.tool_name === 'NotebookEdit' ? input.notebook_path : input.file_path));
  const repo = gitRoot(file);
  if (!repo) return;
  const relative = path.relative(repo, file).replaceAll('\\', '/');
  if (relative === '..' || relative.startsWith('../') || path.isAbsolute(relative)) return;
  const config = configFor(repo);
  if (!config.codeExtensions.some(ext => ext.toLowerCase() === path.extname(file).toLowerCase())
    || config.excludeGlobs.some(glob => globMatches(relative, glob))) return;
  const lines = countChange(payload.tool_name, input, file);
  const fingerprint = hash(JSON.stringify([payload.tool_name, file, canonical(input)]));
  const result = updateSession(payload.session_id, state => {
    const turnTotal = state.turnLines + lines;
    const over = lines > config.perCallLines || turnTotal > config.perTurnLines;
    let decision = 'allow';
    if (config.mode === 'off') decision = 'off';
    else if (state.paused || state.turnPaused) decision = 'paused';
    else if (over) {
      decision = config.mode === 'soft' && state.lastDeniedFingerprint === fingerprint
        && (!config.requireReason || state.justification !== null) ? 'override' : 'deny';
    }
    const needsReason = decision === 'deny' && config.mode === 'soft'
      && state.lastDeniedFingerprint === fingerprint && config.requireReason && state.justification === null;
    if (decision === 'deny') {
      state.lastDeniedFingerprint = fingerprint;
      state.turnDeniedLines = Math.max(state.turnDeniedLines ?? 0, lines);
    }
    else {
      state.turnLines = turnTotal;
      state.sessionLines += lines;
      // A resolved block cannot be used as evidence of later delegated work.
      // Drop the pending estimate conservatively; another denial can establish it.
      if (state.lastDeniedFingerprint === fingerprint) state.turnDeniedLines = null;
    }
    appendLog({ ...recordFor(payload, repo, file, lines, decision), large: over,
      ...(decision === 'override' ? { reason: state.justification?.reason ?? null } : {}) });
    return { decision, turnTotal, needsReason };
  });
  if (result.decision === 'deny') {
    const command = justifyCommand(payload.session_id);
    if (result.needsReason) {
      process.stderr.write(`Delegation guard: ${lines} lines; identical retry still needs a reason for this turn.\n${command}\nThen retry the identical change.\n`);
    } else {
      const retry = config.mode === 'strict'
        ? 'Strict mode blocks identical retries even with a reason; use pause only if the user authorizes direct editing.'
        : config.requireReason ? 'Then retry the identical change in this turn.'
          : 'requireReason:false permits an identical retry in this turn without a reason (v0.1 behavior).';
      process.stderr.write(`Delegation guard: ${lines} lines in this call; ${result.turnTotal} lines this turn (limits ${config.perCallLines}/call, ${config.perTurnLines}/turn).
1. Codex: a self-contained brief of about one page, without conversation history.
2. Codex: an objective acceptance check (tests, a probe, or a data comparison).
3. Codex: big or slow enough that brief + verification cost less, or it runs while the lead does something else.
4. Claude: costly context; judgement/trade-offs/user decision; a small edit; or verification costing about as much as doing it.
Choose (a) delegate: /codex:rescue --background or codex:codex-rescue, with a brief and a waiter.
Or (b) do it directly: first record a one-line reason:
${command}
${retry}\n`);
    }
    process.exitCode = 2;
  }
}

function submitPrompt(payload) {
  if (typeof payload.prompt !== 'string') throw new Error('Invalid prompt');
  const repo = gitRoot(payload.cwd);
  const config = configFor(repo);
  // Background/session notifications continue the current user turn. Return
  // before touching state so they cannot clear a reason or refill any budget.
  if (config.nonUserPromptMarkers.some(marker => payload.prompt.trimStart().startsWith(marker))) return;
  const prompt = payload.prompt.toLowerCase();
  const remind = updateSession(payload.session_id, state => {
    state.turnLines = 0;
    state.lastDeniedFingerprint = null;
    state.justification = null;
    state.turnDeniedLines = null;
    state.promptCount++;
    state.turnPaused = config.pausePhrases.some(phrase => prompt.includes(phrase.toLowerCase()));
    const coding = /修|改|实现|加|写|重构|\b(?:fix|implement|add|build|refactor|write|change|update|repair)\b/i.test(prompt)
      && /功能|接口|测试|代码|文件|函数|\b(?:bugs?|features?|interfaces?|tests?|code|files?|functions?|apis?|components?|scripts?)\b/i.test(prompt);
    if ((config.reminderRequiresGit && !repo) || config.planReminder === 'off' || state.paused || state.turnPaused
      || (config.planReminder === 'auto' && !coding)
      || (state.lastPlanReminderPrompt !== null && state.promptCount - state.lastPlanReminderPrompt < 3)) return false;
    state.lastPlanReminderPrompt = state.promptCount;
    return true;
  });
  if (remind) additionalContext('UserPromptSubmit', PLAN_REMINDER);
}

function freshMetrics() {
  return { delegations: 0, overrides: 0, allowedLarge: 0, overrideLines: [], delegatedTurns: new Map() };
}

function measure(metrics, row) {
  if (row.event === 'delegation') {
    metrics.delegations++;
    if (typeof row.session === 'string' && Number.isSafeInteger(row.turn) && row.turn >= 0
      && Number.isSafeInteger(row.delegatedLines) && row.delegatedLines >= 0) {
      const key = JSON.stringify([row.project, row.session, row.turn]);
      metrics.delegatedTurns.set(key, Math.max(metrics.delegatedTurns.get(key) ?? 0, row.delegatedLines));
    }
  } else if (row.decision === 'override') {
    metrics.overrides++;
    metrics.overrideLines.push(row.lines);
  } else if (row.large === true && ['allow', 'paused', 'off'].includes(row.decision)) metrics.allowedLarge++;
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function summarizeMetrics(metrics) {
  const { delegations, overrides, allowedLarge } = metrics;
  const denominator = delegations + overrides + allowedLarge;
  return { delegations, overrides, allowedLarge, delegationRate: denominator ? delegations / denominator : null,
    medianOverrideLines: median(metrics.overrideLines),
    medianDelegatedTurnLines: median([...metrics.delegatedTurns.values()]),
    measuredDelegatedTurns: metrics.delegatedTurns.size };
}

function stats() {
  const now = Date.now();
  const since = now - 7 * DAY;
  const projects = new Map();
  const metrics = new Map();
  const total = freshMetrics();
  const overrides = [];
  const files = fs.existsSync(logDir) ? fs.readdirSync(logDir).filter(name => name === 'log.jsonl' || archivePattern.test(name)) : [];
  for (const file of files) {
    for (const line of fs.readFileSync(path.join(logDir, file), 'utf8').split('\n')) {
      if (!line.trim()) continue;
      let row;
      try { row = JSON.parse(line); } catch { continue; }
      if (!object(row) || typeof row.project !== 'string') continue;
      const time = Date.parse(row.time);
      if (!Number.isFinite(time) || time < since || time > now) continue;
      if (row.event !== 'delegation' && !(row.event === 'change' && ['allow', 'deny', 'override', 'paused', 'off'].includes(row.decision)
        && Number.isSafeInteger(row.lines) && row.lines >= 0)) continue;
      if (!projects.has(row.project)) projects.set(row.project, { project: row.project, lines: 0, denials: 0, overrides: 0, delegations: 0 });
      if (!metrics.has(row.project)) metrics.set(row.project, freshMetrics());
      measure(total, row);
      measure(metrics.get(row.project), row);
      const project = projects.get(row.project);
      if (row.event === 'delegation') project.delegations++;
      else if (row.decision === 'deny') project.denials++;
      else {
        project.lines += row.lines;
        if (row.decision === 'override') {
          project.overrides++;
          overrides.push({ time, path: typeof row.file === 'string' ? row.file : null,
            reason: typeof row.reason === 'string' ? row.reason : null });
        }
      }
    }
  }
  return { days: 7, since: new Date(since).toISOString(),
    projects: [...projects.values()].sort((a, b) => a.project.localeCompare(b.project)),
    recentOverrides: overrides.sort((a, b) => b.time - a.time).slice(0, 10).map(({ path, reason }) => ({ path, reason })),
    metrics: { total: summarizeMetrics(total),
      projects: [...metrics].sort(([a], [b]) => a.localeCompare(b)).map(([project, value]) => ({ project, ...summarizeMetrics(value) })) } };
}

function command(action) {
  if (action === 'stats') return stats();
  const args = process.argv.slice(3);
  const option = name => {
    const index = args.indexOf(name);
    return index === -1 ? undefined : args[index + 1];
  };
  const session = option('--session-id') || process.env.CLAUDE_SESSION_ID;
  if (!session || session.includes('${')) {
    return { error: 'Current session ID is unavailable. Pass --session-id or set CLAUDE_SESSION_ID; no session was changed.' };
  }
  let reason;
  if (action === 'justify') {
    reason = option('--reason');
    if (typeof reason !== 'string' || !reason.trim()) return { error: 'A nonblank --reason is required; no session was changed.' };
    reason = Array.from(reason.trim().replace(/\s*[\r\n]+\s*/g, ' ')).slice(0, 200).join('');
  }
  const cwd = path.resolve(option('--cwd') || process.cwd());
  const repo = gitRoot(cwd);
  const config = configFor(repo);
  return updateSession(session, state => {
    if (action === 'justify') state.justification = { reason, at: new Date().toISOString() };
    if (action === 'pause') state.paused = true;
    if (action === 'resume') { state.paused = false; state.turnPaused = false; state.lastDeniedFingerprint = null; }
    return {
      session, project: path.basename(repo || cwd), mode: config.mode,
      perCallLines: config.perCallLines, perTurnLines: config.perTurnLines,
      planReminder: config.planReminder, requireReason: config.requireReason, justification: state.justification,
      reminderRequiresGit: config.reminderRequiresGit, nonUserPromptMarkers: config.nonUserPromptMarkers,
      paused: state.paused || state.turnPaused, sessionPaused: state.paused, turnPaused: state.turnPaused,
      turnLines: state.turnLines, sessionLines: state.sessionLines, delegations: { ...state.delegations },
    };
  });
}

try {
  const event = process.argv[2];
  if (['pause', 'resume', 'status', 'stats', 'justify'].includes(event)) {
    process.stdout.write(`${JSON.stringify(command(event), null, 2)}\n`);
  } else if (['PreToolUse', 'UserPromptSubmit', 'SessionStart'].includes(event)) {
    const input = fs.readFileSync(0, 'utf8');
    const payload = JSON.parse(input.replace(/^\uFEFF/, ''));
    if (!object(payload) || typeof payload.session_id !== 'string' || !payload.session_id
      || typeof payload.cwd !== 'string' || !payload.cwd) throw new Error('Invalid hook envelope');
    if (event === 'SessionStart') additionalContext('SessionStart', SESSION_POLICY);
    else if (event === 'UserPromptSubmit') submitPrompt(payload);
    else if (object(payload.tool_input)) {
      if (CHANGE_TOOLS.has(payload.tool_name)) guard(payload);
      else if (OBSERVE_TOOLS.has(payload.tool_name)) observe(payload);
    }
  }
} catch {
  // No stdout/stderr diagnostics in hooks: a broken guard must not break Claude.
  process.exitCode = 0;
}
