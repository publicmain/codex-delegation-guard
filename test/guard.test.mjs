import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const script = path.join(root, 'scripts', 'guard.mjs');
const scratch = path.join(root, '.test-tmp');
fs.mkdirSync(scratch, { recursive: true });
const suiteDir = fs.mkdtempSync(path.join(scratch, 'suite-'));
after(() => fs.rmSync(suiteDir, { recursive: true, force: true }));

function fixture(t, config) {
  const dir = fs.mkdtempSync(path.join(suiteDir, 'case-'));
  const home = path.join(dir, 'home');
  const repo = path.join(dir, 'project');
  const stateDir = path.join(dir, 'state');
  for (const folder of [home, repo, stateDir]) fs.mkdirSync(folder, { recursive: true });
  const init = spawnSync('git', ['init', '--quiet', repo], { stdio: 'ignore', windowsHide: true });
  assert.equal(init.status, 0, init.stderr);
  const env = {
    ...process.env, HOME: home, USERPROFILE: home,
    TMP: dir, TEMP: dir, TMPDIR: dir,
    CODEX_DELEGATION_GUARD_STATE_DIR: stateDir,
    CLAUDE_SESSION_ID: 'test-session',
    GIT_CEILING_DIRECTORIES: suiteDir,
  };
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR']) delete env[key];
  const write = (file, content) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  };
  const setConfig = (value, global = false) => write(
    path.join(global ? home : repo, '.claude', 'delegation-guard.json'), JSON.stringify(value),
  );
  if (config !== undefined) setConfig(config);
  // File descriptors also work in Windows sandboxes that prohibit anonymous pipes.
  const run = (event, payload, args = []) => {
    const inputFile = path.join(dir, 'stdin');
    const outputFile = path.join(dir, 'stdout');
    const errorFile = path.join(dir, 'stderr');
    fs.writeFileSync(inputFile, payload === undefined ? '' : typeof payload === 'string' ? payload : JSON.stringify(payload));
    const handles = [fs.openSync(inputFile, 'r'), fs.openSync(outputFile, 'w'), fs.openSync(errorFile, 'w')];
    let result;
    try {
      result = spawnSync(process.execPath, [script, event, ...args], {
        cwd: repo, env, stdio: handles, windowsHide: true, timeout: 15_000,
      });
    } finally {
      handles.forEach(fd => fs.closeSync(fd));
    }
    return { ...result, stdout: fs.readFileSync(outputFile, 'utf8'), stderr: fs.readFileSync(errorFile, 'utf8') };
  };
  const payload = (tool_name, tool_input, extra = {}) => ({
    session_id: 'test-session', cwd: repo, tool_name, tool_input,
    transcript_path: path.join(dir, 'never-read-transcript.jsonl'), ...extra,
  });
  const hook = (tool, input, extra) => run('PreToolUse', payload(tool, input, extra));
  const edit = (new_string, file_path = 'src/main.ts', extra = {}) => hook('Edit', {
    file_path, old_string: 'old', new_string, ...extra,
  });
  const prompt = (text = 'Continue') => run('UserPromptSubmit', {
    session_id: 'test-session', cwd: repo, prompt: text,
  });
  const cli = (command, args = []) => run(command, undefined, args);
  const state = () => JSON.parse(fs.readFileSync(path.join(stateDir, 'test-session.json'), 'utf8'));
  const logDir = path.join(home, '.claude', 'delegation-guard');
  const records = () => fs.existsSync(logDir) ? fs.readdirSync(logDir)
    .filter(name => name.endsWith('.jsonl'))
    .flatMap(name => fs.readFileSync(path.join(logDir, name), 'utf8').split('\n'))
    .filter(Boolean).map(line => JSON.parse(line)) : [];
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { dir, home, repo, stateDir, env, logDir, write, setConfig, run, hook, edit, prompt, cli, state, records };
}

function silent(result) {
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, '');
}
function denied(result) {
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 2, result.stderr);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /\d+.*lines/i);
  assert.match(result.stderr, /\/codex:rescue --background/);
  assert.match(result.stderr, /codex:codex-rescue/);
}
const lines = count => Array.from({ length: count }, (_, i) => `const item${i} = ${i};`).join('\n');
const criteria = `A piece of work suits Codex when ALL of these hold:
1. It can be written as a self-contained brief of about one page, without the conversation history.
2. It has an objective acceptance check, such as tests, a probe, or a data comparison.
3. It is big or slow enough that the brief plus the verification cost less than doing it, or it can run while the lead does something else.

It stays with Claude when ANY of these holds:
- it depends on context that is costly to transfer;
- it needs judgement, trade-offs or the user's decision;
- it is a small edit;
- verifying it would cost about as much as doing it.

Claude always keeps these jobs: splitting the work, writing briefs, verifying on the real path, integrating and committing.`;

function context(result, event) {
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  const output = JSON.parse(result.stdout);
  assert.deepEqual(Object.keys(output), ['hookSpecificOutput']);
  assert.deepEqual(Object.keys(output.hookSpecificOutput).sort(), ['additionalContext', 'hookEventName']);
  assert.equal(output.hookSpecificOutput.hookEventName, event);
  return output.hookSpecificOutput.additionalContext;
}

test('below and exactly at the default per-call threshold allow silently', t => {
  const f = fixture(t);
  silent(f.edit(lines(20)));
  silent(f.edit(lines(60)));
  assert.equal(f.state().turnLines, 80);
  assert.equal(f.state().sessionLines, 80);
});

test('soft mode denies, permits a justified identical retry, and denies a different change', t => {
  const f = fixture(t);
  const content = lines(61);
  const first = f.edit(content);
  denied(first);
  assert.match(first.stderr, /identical/i);
  assert.equal(f.state().sessionLines, 0);
  assert.match(f.state().lastDeniedFingerprint, /^[a-f0-9]{64}$/);
  assert.equal(f.cli('justify', ['--reason', 'Context is costly to transfer']).status, 0);
  silent(f.edit(content));
  denied(f.edit(`${content}\nconst different = true;`));
  assert.deepEqual(f.records().map(row => row.decision), ['deny', 'override', 'deny']);
  assert.equal(f.state().sessionLines, 61);
});

test('the old target string is part of an identical-change fingerprint', t => {
  const f = fixture(t);
  denied(f.edit(lines(61), 'src/a.ts', { old_string: 'first' }));
  denied(f.edit(lines(61), 'src/a.ts', { old_string: 'different' }));
});

test('strict mode never permits an identical retry', t => {
  const f = fixture(t, { mode: 'strict' });
  denied(f.edit(lines(61)));
  denied(f.edit(lines(61)));
  assert.equal(f.state().sessionLines, 0);
  assert.deepEqual(f.records().map(row => row.decision), ['deny', 'deny']);
});

test('off mode still counts and logs eligible code', t => {
  const f = fixture(t, { mode: 'off' });
  silent(f.edit(lines(200)));
  assert.equal(f.state().sessionLines, 200);
  assert.equal(f.records()[0].decision, 'off');
});

test('per-turn accumulation denies only above the boundary and a prompt resets it', t => {
  const f = fixture(t, { perCallLines: 100, perTurnLines: 12 });
  silent(f.edit(lines(4)));
  silent(f.edit(lines(4)));
  silent(f.edit(lines(4)));
  denied(f.edit(lines(1)));
  assert.equal(f.state().turnLines, 12);
  silent(f.prompt());
  assert.equal(f.state().lastDeniedFingerprint, null);
  silent(f.edit(lines(4)));
  assert.equal(f.state().turnLines, 4);
  assert.equal(f.state().sessionLines, 16);
});

test('a new prompt clears a soft override even when the content is identical', t => {
  const f = fixture(t);
  denied(f.edit(lines(61)));
  silent(f.prompt());
  denied(f.edit(lines(61)));
});

test('default Chinese and English pause phrases last for one turn only', t => {
  const f = fixture(t, { mode: 'strict' });
  for (const phrase of ['这次你自己写', '你自己写', '自己改', 'WRITE IT YOURSELF', 'no codex']) {
    silent(f.prompt(`Please: ${phrase}`));
    silent(f.edit(lines(200)));
    assert.equal(f.records().at(-1).decision, 'paused');
    silent(f.prompt('Continue normally'));
    denied(f.edit(lines(61)));
  }
});

test('slash-command-looking prompt text does not switch mode or pause', t => {
  const f = fixture(t, { mode: 'strict' });
  silent(f.prompt('/delegation-guard:off /codex-delegation-guard:pause'));
  denied(f.edit(lines(61)));
});

test('pause persists across prompts, resume restores enforcement and status reports it', t => {
  const f = fixture(t, { mode: 'strict' });
  assert.equal(f.cli('pause').status, 0);
  silent(f.prompt('New turn'));
  silent(f.edit(lines(200)));
  const status = JSON.parse(f.cli('status').stdout);
  assert.equal(status.mode, 'strict');
  assert.equal(status.perCallLines, 60);
  assert.equal(status.perTurnLines, 150);
  assert.equal(status.paused, true);
  assert.equal(status.sessionLines, 200);
  assert.equal(status.delegations.total, 0);
  assert.equal(f.cli('resume').status, 0);
  denied(f.edit(lines(61)));
});

test('commands accept an explicit session ID without touching a different session', t => {
  const f = fixture(t, { mode: 'strict' });
  assert.equal(f.cli('pause', ['--session-id', 'other-session']).status, 0);
  denied(f.edit(lines(61)));
  silent(f.hook('Edit', { file_path: 'a.ts', new_string: lines(61) }, { session_id: 'other-session' }));
});

test('resume also clears a prompt-only pause', t => {
  const f = fixture(t, { mode: 'strict' });
  silent(f.prompt('no codex'));
  f.cli('resume');
  denied(f.edit(lines(61)));
});

test('Bash, Agent and Task delegations reset the turn and count by source', t => {
  const f = fixture(t, { perCallLines: 100, perTurnLines: 10 });
  const calls = [
    ['Bash', { command: 'node "/plugin/codex-companion.mjs" task --brief brief.md --background' }],
    ['Bash', { command: 'codex exec "implement the brief"' }],
    ['Agent', { subagent_type: 'codex:codex-rescue', prompt: 'private brief' }],
    ['Task', { subagent_type: 'codex:codex-rescue', prompt: 'private brief' }],
  ];
  for (const [tool, input] of calls) {
    silent(f.edit(lines(10)));
    silent(f.hook(tool, input));
    assert.equal(f.state().turnLines, 0);
  }
  assert.deepEqual(f.state().delegations, { total: 4, bash: 2, agent: 1, task: 1 });
  assert.equal(f.state().sessionLines, 40);
  assert.equal(f.records().filter(row => row.event === 'delegation').length, 4);
});

test('ordinary Bash and unrelated subagents never reset the turn', t => {
  const f = fixture(t, { perCallLines: 100, perTurnLines: 10 });
  silent(f.edit(lines(10)));
  for (const [tool, input] of [
    ['Bash', { command: 'codex --help' }],
    ['Bash', { command: 'node codex-companion.mjs status --wait job-1' }],
    ['Agent', { subagent_type: 'Explore' }],
    ['Task', { subagent_type: 'general-purpose' }],
  ]) silent(f.hook(tool, input));
  denied(f.edit(lines(1)));
  assert.equal(f.state().delegations.total, 0);
});

test('default excluded paths and non-code extensions pass without state or log writes', t => {
  const f = fixture(t);
  for (const file of [
    'package-lock.json', 'yarn.lock', 'go.sum', 'app.min.js', 'src/lib.min.ts',
    'dist/a.ts', 'build/a.ts', 'node_modules/a.ts', 'vendor/a.ts',
    'src/generated/a.ts', 'src/__generated__/a.ts', 'src/.generated/a.ts',
    'notes.md', 'notes.txt', 'data.json', 'config.yaml', 'config.yml', 'config.toml',
    'data.csv', 'logo.svg', 'picture.png', 'nested/dist/a.ts',
  ]) silent(f.edit(lines(100), file));
  assert.deepEqual(f.records(), []);
  assert.equal(fs.existsSync(path.join(f.stateDir, 'test-session.json')), false);
});

test('custom extension and glob lists replace defaults and support **, * and ?', t => {
  const f = fixture(t, { codeExtensions: ['.custom', '.md'], excludeGlobs: ['**/skip-?.custom', 'cache/', 'src/**/auto.*'] });
  for (const file of ['skip-a.custom', 'nested/skip-b.custom', 'nested/cache/a.custom', 'src/auto.custom', 'src/a/auto.custom', 'ordinary.ts']) {
    silent(f.edit(lines(100), file));
  }
  denied(f.edit(lines(61), 'notes.md'));
  denied(f.edit(lines(61), 'nested/manual.custom'));
});

test('files outside any git work tree pass, including when cwd is a repository', t => {
  const f = fixture(t);
  silent(f.edit(lines(100), path.join(f.dir, 'outside.ts')));
  silent(f.run('PreToolUse', { session_id: 'test-session', cwd: f.dir, tool_name: 'Write', tool_input: { file_path: 'outside.ts', content: lines(100) } }));
  assert.deepEqual(f.records(), []);
});

test('nested cwd and new nested folders resolve to the repository root config', t => {
  const f = fixture(t, { perCallLines: 2 });
  const cwd = path.join(f.repo, 'packages', 'nested');
  fs.mkdirSync(cwd, { recursive: true });
  denied(f.hook('Write', { file_path: 'new/deeper/file.ts', content: lines(3) }, { cwd }));
  assert.equal(f.records()[0].file, 'packages/nested/new/deeper/file.ts');
  assert.equal(f.records()[0].project, 'project');
});

test('malformed stdin, unknown tools and incomplete payloads fail open silently', t => {
  const f = fixture(t);
  for (const input of ['{', '', 'null', '[]', '{"tool_name":"Write"}']) silent(f.run('PreToolUse', input));
  silent(f.hook('UnknownTool', { file_path: 'a.ts', content: lines(100) }));
  silent(f.hook('Write', { file_path: 'a.ts', content: 17 }));
  silent(f.hook('Edit', { file_path: 'a.ts' }));
  silent(f.hook('MultiEdit', { file_path: 'a.ts', edits: [null] }));
  silent(f.run('UnknownEvent', '{}'));
  assert.deepEqual(f.records(), []);
});

test('state or log filesystem errors fail open silently', t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.stateDir, 'test-session.json'), '{broken');
  silent(f.edit(lines(100)));
  fs.unlinkSync(path.join(f.stateDir, 'test-session.json'));
  fs.mkdirSync(path.join(f.home, '.claude'), { recursive: true });
  fs.writeFileSync(f.logDir, 'not a directory');
  silent(f.edit(lines(100)));
});

test('backslash paths and native Windows drive letters are handled', t => {
  const f = fixture(t);
  denied(f.edit(lines(61), 'src\\nested\\file.ts'));
  assert.equal(f.records()[0].file, 'src/nested/file.ts');
  if (process.platform === 'win32') {
    assert.match(f.repo, /^[A-Za-z]:\\/);
    denied(f.edit(lines(61), path.join(f.repo, 'absolute', 'file.ts')));
    assert.equal(f.records()[1].file, 'absolute/file.ts');
    silent(f.edit(lines(100), path.join(f.dir, 'outside-drive.ts')));
  }
});

test('Write new files counts lines without treating a final newline as an extra line', t => {
  const f = fixture(t);
  silent(f.hook('Write', { file_path: 'a.ts', content: 'first\r\nsecond\r\n' }));
  silent(f.hook('Write', { file_path: 'empty.ts', content: '' }));
  assert.deepEqual(f.records().map(row => row.lines), [2, 0]);
});

test('Write existing files counts replacements, additions and deletions rather than all lines', t => {
  const f = fixture(t, { mode: 'strict' });
  const original = Array.from({ length: 300 }, (_, i) => `line ${i}`);
  f.write(path.join(f.repo, 'existing.ts'), `${original.join('\r\n')}\r\n`);
  const changed = [...original];
  changed[150] = 'one replacement';
  silent(f.hook('Write', { file_path: 'existing.ts', content: `${changed.join('\n')}\n` }));
  silent(f.hook('Write', { file_path: 'existing.ts', content: `${original.join('\n')}\n` }));
  const insertion = [...original];
  insertion.splice(150, 0, 'new line');
  silent(f.hook('Write', { file_path: 'existing.ts', content: insertion.join('\n') }));
  const deletion = [...original];
  deletion.splice(150, 1);
  silent(f.hook('Write', { file_path: 'existing.ts', content: deletion.join('\n') }));
  assert.deepEqual(f.records().map(row => row.lines), [1, 0, 1, 1]);
});

test('large Write diffs are bounded and conservatively counted', t => {
  const f = fixture(t, { mode: 'strict' });
  f.write(path.join(f.repo, 'large.ts'), lines(3000));
  denied(f.hook('Write', { file_path: 'large.ts', content: lines(3000).replaceAll('const', 'let') }));
  assert.equal(f.records()[0].lines, 3000);
});

test('Edit deletion has a minimum of one line and MultiEdit sums all edits', t => {
  const f = fixture(t, { perCallLines: 3 });
  silent(f.edit(''));
  denied(f.hook('MultiEdit', { file_path: 'a.ts', edits: [
    { old_string: 'a', new_string: lines(3) }, { old_string: 'b', new_string: '' },
  ] }));
  assert.deepEqual(f.records().map(row => row.lines), [1, 4]);
});

test('NotebookEdit counts new_source in ipynb files', t => {
  const f = fixture(t);
  denied(f.hook('NotebookEdit', { notebook_path: 'notebooks/demo.ipynb', new_source: lines(61), edit_mode: 'replace', cell_id: 'one' }));
  assert.equal(f.records()[0].lines, 61);
});

test('no file content, old content, prompt, command or transcript enters the log', t => {
  const f = fixture(t);
  const secret = 'PRIVATE_STUDENT_CONTENT_SENTINEL';
  silent(f.edit(secret, 'src/secret.ts', { old_string: `old ${secret}` }));
  silent(f.prompt(`${secret} no codex`));
  silent(f.hook('Agent', { subagent_type: 'codex:codex-rescue', prompt: secret }));
  silent(f.hook('Bash', { command: `codex exec "${secret}"` }));
  const text = fs.readFileSync(path.join(f.logDir, 'log.jsonl'), 'utf8');
  assert.doesNotMatch(text, /PRIVATE_STUDENT_CONTENT_SENTINEL|never-read-transcript/);
  assert.doesNotMatch(fs.readFileSync(path.join(f.stateDir, 'test-session.json'), 'utf8'), /PRIVATE_STUDENT_CONTENT_SENTINEL/);
  for (const row of f.records()) {
    assert.equal(row.session, 'test-session');
    assert.equal(row.project, 'project');
    assert.ok(Number.isFinite(Date.parse(row.time)));
    assert.equal(typeof row.lines, 'number');
  }
});

test('configuration merges user then repository keys and validates each value', t => {
  const f = fixture(t);
  f.setConfig({ mode: 'strict', perCallLines: 3, perTurnLines: 100 }, true);
  f.setConfig({ perCallLines: 4 });
  silent(f.edit(lines(4)));
  denied(f.edit(lines(5)));
  const status = JSON.parse(f.cli('status').stdout);
  assert.equal(status.mode, 'strict');
  assert.equal(status.perCallLines, 4);
  assert.equal(status.perTurnLines, 100);
});

test('invalid config values fall back to built-in defaults', t => {
  const f = fixture(t, {
    mode: 'invalid', perCallLines: '1', perTurnLines: -1,
    codeExtensions: [2], excludeGlobs: [null], pausePhrases: 7,
  });
  silent(f.edit(lines(60)));
  denied(f.edit(lines(61)));
  silent(f.edit(lines(100), 'dist/excluded.ts'));
  silent(f.prompt('你自己写'));
  silent(f.edit(lines(100)));
  const status = JSON.parse(f.cli('status').stdout);
  assert.equal(status.mode, 'soft');
  assert.equal(status.perCallLines, 60);
  assert.equal(status.perTurnLines, 150);
});

test('malformed config and invalid numeric thresholds use defaults', t => {
  const f = fixture(t);
  f.write(path.join(f.repo, '.claude', 'delegation-guard.json'), '{');
  denied(f.edit(lines(61)));
  for (const value of [null, [], { perCallLines: 0, perTurnLines: 1.5 }]) {
    f.setConfig(value);
    const status = JSON.parse(f.cli('status').stdout);
    assert.equal(status.perCallLines, 60);
    assert.equal(status.perTurnLines, 150);
  }
});

test('custom pause phrases replace defaults', t => {
  const f = fixture(t, { mode: 'strict', pausePhrases: ['only this phrase'] });
  silent(f.prompt('no codex'));
  denied(f.edit(lines(61)));
  silent(f.prompt('ONLY THIS PHRASE'));
  silent(f.edit(lines(61)));
});

test('stats aggregate seven days by folder and ignore denied lines and malformed rows', t => {
  const f = fixture(t);
  fs.mkdirSync(f.logDir, { recursive: true });
  const now = new Date().toISOString();
  const row = (project, decision, count, event = 'change', time = now) => ({ time, session: 's', project, file: 'a.ts', lines: count, decision, event });
  const old = new Date(Date.now() - 8 * 86_400_000).toISOString();
  const log = [
    row('alpha', 'allow', 5), row('alpha', 'deny', 90), row('alpha', 'override', 90),
    row('alpha', 'allow', 0, 'delegation'), row('beta', 'paused', 7), row('beta', 'off', 8),
    row('beta', 'allow', 999, 'change', old), '{bad json',
  ];
  f.write(path.join(f.logDir, 'log.jsonl'), log.map(value => typeof value === 'string' ? value : JSON.stringify(value)).join('\n') + '\n');
  const result = f.cli('stats');
  assert.equal(result.status, 0);
  const stats = JSON.parse(result.stdout);
  assert.equal(stats.days, 7);
  assert.deepEqual(stats.projects, [
    { project: 'alpha', lines: 95, denials: 1, overrides: 1, delegations: 1 },
    { project: 'beta', lines: 15, denials: 0, overrides: 0, delegations: 0 },
  ]);
});

test('log rotation above 5 MiB preserves recent events for stats', t => {
  const f = fixture(t);
  fs.mkdirSync(f.logDir, { recursive: true });
  f.write(path.join(f.logDir, 'log.jsonl'), Buffer.alloc(5 * 1024 * 1024, '\n'));
  silent(f.edit(lines(2)));
  const archives = fs.readdirSync(f.logDir).filter(name => /^log\.\d+\.[a-f0-9]+\.jsonl$/.test(name));
  assert.equal(archives.length, 1);
  assert.equal(fs.statSync(path.join(f.logDir, 'log.jsonl')).size, 0);
  const stats = JSON.parse(f.cli('stats').stdout);
  assert.equal(stats.projects[0].lines, 2);
});

test('session IDs cannot traverse outside the state directory', t => {
  const f = fixture(t);
  silent(f.hook('Edit', { file_path: 'a.ts', new_string: 'one line' }, { session_id: '../escaped' }));
  assert.equal(fs.existsSync(path.join(f.dir, 'escaped.json')), false);
  assert.equal(fs.readdirSync(f.stateDir).filter(name => /^[a-f0-9]{64}\.json$/.test(name)).length, 1);
});

test('default state location uses the OS temp directory', t => {
  const f = fixture(t);
  delete f.env.CODEX_DELEGATION_GUARD_STATE_DIR;
  silent(f.edit('one line'));
  assert.ok(fs.existsSync(path.join(f.dir, 'codex-delegation-guard', 'test-session.json')));
});

test('parallel real hook processes preserve every permitted edit in state and log', async t => {
  const f = fixture(t, { perTurnLines: 1000 });
  const runParallel = index => new Promise((resolve, reject) => {
    const prefix = path.join(f.dir, `parallel-${index}`);
    fs.writeFileSync(`${prefix}.in`, JSON.stringify({ session_id: 'test-session', cwd: f.repo,
      tool_name: 'Edit', tool_input: { file_path: `src/${index}.ts`, new_string: lines(10) } }));
    const handles = [fs.openSync(`${prefix}.in`, 'r'), fs.openSync(`${prefix}.out`, 'w'), fs.openSync(`${prefix}.err`, 'w')];
    const child = spawn(process.execPath, [script, 'PreToolUse'], { cwd: f.repo, env: f.env, stdio: handles, windowsHide: true, timeout: 15_000 });
    child.once('error', reject);
    child.once('close', code => {
      handles.forEach(fd => fs.closeSync(fd));
      resolve({ status: code, stdout: fs.readFileSync(`${prefix}.out`, 'utf8'), stderr: fs.readFileSync(`${prefix}.err`, 'utf8') });
    });
  });
  const results = await Promise.all(Array.from({ length: 6 }, (_, i) => runParallel(i)));
  results.forEach(silent);
  assert.equal(f.state().turnLines, 60);
  assert.equal(f.state().sessionLines, 60);
  assert.equal(f.records().length, 6);
});

test('a real gitfile with separate metadata is recognized as a git work tree', t => {
  const f = fixture(t);
  const result = spawnSync('git', ['init', '--quiet', '--separate-git-dir', path.join(f.dir, 'metadata'), f.repo], { stdio: 'ignore', windowsHide: true });
  assert.equal(result.status, 0);
  assert.ok(fs.statSync(path.join(f.repo, '.git')).isFile());
  denied(f.edit(lines(61)));
});

test('a directory junction pointing outside the work tree is not counted', t => {
  const f = fixture(t);
  const external = path.join(f.dir, 'external');
  fs.mkdirSync(external);
  fs.symlinkSync(external, path.join(f.repo, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  silent(f.edit(lines(100), 'linked/new.ts'));
  assert.deepEqual(f.records(), []);
});

test('default data/text exclusions still apply when their extensions are configured as code', t => {
  const f = fixture(t, { codeExtensions: ['.md', '.txt', '.json', '.yaml', '.yml', '.toml', '.lock', '.csv', '.svg'] });
  for (const file of ['a.md', 'a.txt', 'a.json', 'a.yaml', 'a.yml', 'a.toml', 'a.lock', 'a.csv', 'a.svg']) silent(f.edit(lines(100), file));
  assert.deepEqual(f.records(), []);
});

test('invalid project keys reset to built-in defaults while unrelated user keys survive', t => {
  const f = fixture(t);
  f.setConfig({ mode: 'strict', perCallLines: 2, perTurnLines: 99 }, true);
  f.setConfig({ mode: false, perCallLines: null });
  const status = JSON.parse(f.cli('status').stdout);
  assert.equal(status.mode, 'soft');
  assert.equal(status.perCallLines, 60);
  assert.equal(status.perTurnLines, 99);
});

test('Write diff counts separate replacement, deletion and insertion hunks', t => {
  const f = fixture(t);
  f.write(path.join(f.repo, 'hunks.ts'), 'A\nB\nC\nD\nE\nF\nG\nH\n');
  silent(f.hook('Write', { file_path: 'hunks.ts', content: 'A\nX\nC\nD\nF\nG\nY\nZ\nH\n' }));
  assert.equal(f.records()[0].lines, 4);
});

for (const source of ['startup', 'resume', 'compact']) {
  test(`v0.2 SessionStart ${source} emits the exact context envelope and policy`, t => {
    const f = fixture(t);
    const policy = context(f.run('SessionStart', { session_id: 'test-session', cwd: f.repo, source }), 'SessionStart');
    assert.ok(policy.includes(criteria.replaceAll('\n\n', '\n')));
    assert.ok(policy.split('\n').length >= 8 && policy.split('\n').length <= 12);
    assert.match(policy, /\/codex:rescue --background/);
    assert.match(policy, /codex:codex-rescue/);
    assert.match(policy, /brief.*waiter/);
    assert.match(policy, /before.*first edit/);
    assert.match(policy, /Split: Codex does/);
    // A Windows checkout may turn LF into CRLF; compare the wording, not the line endings.
    const skill = fs.readFileSync(path.join(root, 'skills/delegation-guard/SKILL.md'), 'utf8').replace(/\r\n/g, '\n');
    assert.ok(skill.includes(criteria));
  });
}

test('v0.2 hook manifest installs SessionStart for startup, resume and compact', () => {
  const hooks = JSON.parse(fs.readFileSync(path.join(root, 'hooks/hooks.json'), 'utf8')).hooks;
  assert.equal(hooks.SessionStart[0].matcher, 'startup|resume|compact');
  assert.match(hooks.SessionStart[0].hooks[0].command, /guard\.mjs" SessionStart$/);
});

test('v0.2 auto reminders detect English and Chinese coding tasks inside git', t => {
  const f = fixture(t);
  for (const prompt of ['Please fix the API bug', '请实现这个功能并加测试', 'refactor this function', 'write a test file']) {
    const reminder = context(f.prompt(prompt), 'UserPromptSubmit');
    assert.match(reminder, /Before editing: state the split per the delegation criteria\./);
    assert.ok(reminder.split('\n').length >= 2 && reminder.split('\n').length <= 3);
    silent(f.prompt('Continue'));
    silent(f.prompt('Continue'));
  }
});

test('v0.2 auto reminders skip chit-chat and prompts lacking either verbs or code nouns', t => {
  const f = fixture(t);
  for (const prompt of ['Hello, how are you?', 'add some salt', 'API function test', '今天聊聊电影']) silent(f.prompt(prompt));
});

test('v0.2 reminders skip non-git cwd even in always mode', t => {
  const f = fixture(t);
  f.setConfig({ planReminder: 'always' }, true);
  silent(f.run('UserPromptSubmit', { session_id: 'test-session', cwd: f.dir, prompt: 'fix the API bug' }));
});

test('v0.2 reminders are at most once per three prompts across real hook processes', t => {
  const f = fixture(t);
  context(f.prompt('fix the bug'), 'UserPromptSubmit');
  silent(f.prompt('fix the code'));
  silent(f.prompt('fix the file'));
  context(f.prompt('fix the test'), 'UserPromptSubmit');
  silent(f.prompt('fix the API'));
  silent(f.prompt('fix the function'));
  context(f.prompt('fix the bug'), 'UserPromptSubmit');
});

test('v0.2 reminder off and always modes retain reset and rate limiting', t => {
  const f = fixture(t, { planReminder: 'off' });
  silent(f.edit(lines(10)));
  silent(f.prompt('fix this bug'));
  assert.equal(f.state().turnLines, 0);
  f.setConfig({ planReminder: 'always' });
  context(f.prompt('Hello'), 'UserPromptSubmit');
  silent(f.prompt('Hello again'));
  silent(f.prompt('Hello again'));
  context(f.prompt('Hello again'), 'UserPromptSubmit');
});

test('v0.2 pause phrases and session pause suppress reminders without consuming a reminder slot', t => {
  const f = fixture(t, { planReminder: 'always' });
  silent(f.prompt('fix the bug, no codex'));
  context(f.prompt('fix the bug'), 'UserPromptSubmit');
  f.cli('pause');
  for (let i = 0; i < 3; i++) silent(f.prompt('fix the bug'));
  f.cli('resume');
  context(f.prompt('fix the bug'), 'UserPromptSubmit');
});

test('v0.2 deny message gives four criteria lines and an executable session-specific justify command', t => {
  const f = fixture(t);
  const result = f.edit(lines(61));
  denied(result);
  for (const criterion of [/one.page/i, /objective.*acceptance/i, /big.*slow/i, /context.*judgement.*small.*verif/i]) {
    assert.ok(result.stderr.split('\n').some(line => criterion.test(line)), result.stderr);
  }
  assert.ok(result.stderr.includes(`node "${script.replaceAll('\\', '/')}" justify --session-id test-session --reason "<why this stays with Claude>"`));
  assert.match(result.stderr, /\(a\).*delegate/i);
  assert.match(result.stderr, /\(b\).*direct/i);
});

test('v0.2 identical retry without justify is denied with a shorter command reminder', t => {
  const f = fixture(t);
  const first = f.edit(lines(61));
  const retry = f.edit(lines(61));
  assert.equal(first.status, 2);
  assert.equal(retry.status, 2);
  assert.ok(retry.stderr.length < first.stderr.length);
  assert.match(retry.stderr, /justify --session-id test-session --reason/);
  assert.deepEqual(f.records().map(row => row.decision), ['deny', 'deny']);
  assert.equal(f.state().turnLines, 0);
});

test('v0.2 justify trims a reason and an identical retry logs it', t => {
  const f = fixture(t);
  denied(f.edit(lines(61)));
  const result = f.cli('justify', ['--session-id', 'test-session', '--reason', '  context is costly to transfer  ']);
  assert.equal(result.status, 0);
  assert.deepEqual(f.state().justification, { reason: 'context is costly to transfer', at: f.state().justification.at });
  assert.ok(Number.isFinite(Date.parse(f.state().justification.at)));
  silent(f.edit(lines(61)));
  assert.equal(f.records().at(-1).decision, 'override');
  assert.equal(f.records().at(-1).reason, 'context is costly to transfer');
  assert.equal(f.state().sessionLines, 61);
});

test('v0.2 justification is turn-scoped and does not skip the first denial of a new change', t => {
  const f = fixture(t);
  f.cli('justify', ['--reason', 'costly context']);
  denied(f.edit(lines(61)));
  silent(f.edit(lines(61)));
  denied(f.edit(lines(62)));
  silent(f.prompt());
  assert.equal(f.state().justification, null);
  denied(f.edit(lines(61)));
  assert.equal(f.edit(lines(61)).status, 2);
});

test('v0.2 requireReason false restores the v0.1 identical retry behavior', t => {
  const f = fixture(t, { requireReason: false });
  denied(f.edit(lines(61)));
  silent(f.edit(lines(61)));
  assert.equal(f.records().at(-1).decision, 'override');
});

test('v0.2 strict and off modes are unchanged by justify', t => {
  const f = fixture(t, { mode: 'strict' });
  denied(f.edit(lines(61)));
  f.cli('justify', ['--reason', 'costly context']);
  denied(f.edit(lines(61)));
  f.setConfig({ mode: 'off' });
  silent(f.edit(lines(61)));
  assert.equal(f.records().at(-1).decision, 'off');
});

test('v0.2 justify Bash calls are not delegations even when the reason contains dispatch words', t => {
  const f = fixture(t);
  silent(f.edit(lines(10)));
  silent(f.hook('Bash', { command: `node "${script}" justify --session-id test-session --reason "codex exec or codex-companion.mjs task would cost more"` }));
  assert.equal(f.state().delegations.total, 0);
  assert.equal(f.state().turnLines, 10);
  assert.equal(f.records().filter(row => row.event === 'delegation').length, 0);
});

test('v0.2 reasons are capped at 200 characters after trimming and blank reasons are rejected', t => {
  const f = fixture(t);
  const blank = JSON.parse(f.cli('justify', ['--reason', '  ']).stdout);
  assert.match(blank.error, /reason/i);
  f.cli('justify', ['--reason', `  ${'x'.repeat(220)}  `]);
  assert.equal(f.state().justification.reason, 'x'.repeat(200));
  denied(f.edit(lines(61)));
  silent(f.edit(lines(61)));
  assert.equal(f.records().at(-1).reason.length, 200);
});

test('v0.2 stats report reasons, delegation rate and measurable size medians', t => {
  const f = fixture(t);
  denied(f.edit(lines(61)));
  f.cli('justify', ['--reason', 'context is costly']);
  silent(f.edit(lines(61)));
  silent(f.prompt());
  denied(f.edit(lines(80)));
  silent(f.hook('Agent', { subagent_type: 'codex:codex-rescue' }));
  silent(f.hook('Task', { subagent_type: 'codex:codex-rescue' }));
  silent(f.prompt());
  denied(f.edit(lines(100)));
  silent(f.hook('Bash', { command: 'codex exec "brief"' }));
  silent(f.prompt('no codex'));
  silent(f.edit(lines(70)));
  silent(f.edit(lines(1)));
  const stats = JSON.parse(f.cli('stats').stdout);
  assert.deepEqual(stats.recentOverrides, [{ path: 'src/main.ts', reason: 'context is costly' }]);
  assert.equal(stats.metrics.total.delegations, 3);
  assert.equal(stats.metrics.total.overrides, 1);
  assert.equal(stats.metrics.total.allowedLarge, 1);
  assert.equal(stats.metrics.total.delegationRate, 3 / 5);
  assert.equal(stats.metrics.total.medianOverrideLines, 61);
  assert.equal(stats.metrics.total.medianDelegatedTurnLines, 90);
  assert.equal(stats.metrics.total.measuredDelegatedTurns, 2);
  assert.equal(stats.metrics.projects[0].project, 'project');
  assert.equal(stats.metrics.projects[0].delegationRate, 3 / 5);
});

test('v0.2 stats sort the ten most recent overrides across archives and tolerate legacy logs', t => {
  const f = fixture(t);
  const now = Date.now();
  const rows = Array.from({ length: 12 }, (_, i) => ({
    time: new Date(now - i * 1000).toISOString(), session: 's', project: 'project',
    file: `${i}.ts`, lines: 61 + i, decision: 'override', event: 'change', reason: `why ${i}`,
  }));
  const legacy = { ...rows[0], time: new Date(now - 20_000).toISOString(), file: 'old.ts' };
  delete legacy.reason;
  f.write(path.join(f.logDir, 'log.jsonl'), rows.slice(6).concat(legacy).map(JSON.stringify).join('\n'));
  f.write(path.join(f.logDir, `log.${now}.12345678.jsonl`), rows.slice(0, 6).map(JSON.stringify).join('\n'));
  const stats = JSON.parse(f.cli('stats').stdout);
  assert.deepEqual(stats.recentOverrides, rows.slice(0, 10).map(row => ({ path: row.file, reason: row.reason })));
  assert.equal(stats.metrics.total.delegationRate, 0);
  assert.equal(stats.metrics.total.medianOverrideLines, 66);
  assert.equal(stats.metrics.total.medianDelegatedTurnLines, null);
});

test('v0.2 an empty stats denominator has a null rate and no invented sizes', t => {
  const f = fixture(t);
  silent(f.edit(lines(5)));
  const total = JSON.parse(f.cli('stats').stdout).metrics.total;
  assert.equal(total.delegationRate, null);
  assert.equal(total.medianOverrideLines, null);
  assert.equal(total.medianDelegatedTurnLines, null);
});

test('v0.2 v0.1 session states migrate while preserving counters and pauses', t => {
  const f = fixture(t);
  f.write(path.join(f.stateDir, 'test-session.json'), JSON.stringify({
    turnLines: 12, sessionLines: 25, lastDeniedFingerprint: null,
    paused: true, turnPaused: false, delegations: { total: 2, bash: 2, agent: 0, task: 0 },
  }));
  silent(f.prompt('fix the code'));
  assert.equal(f.state().sessionLines, 25);
  assert.equal(f.state().delegations.total, 2);
  assert.equal(f.state().paused, true);
  assert.equal(f.state().justification, null);
});

test('v0.2 new config keys merge and invalid project values restore defaults', t => {
  const f = fixture(t);
  f.setConfig({ planReminder: 'always', requireReason: false }, true);
  f.setConfig({ planReminder: 'off' });
  let status = JSON.parse(f.cli('status').stdout);
  assert.equal(status.planReminder, 'off');
  assert.equal(status.requireReason, false);
  f.setConfig({ planReminder: false, requireReason: 'false' });
  status = JSON.parse(f.cli('status').stdout);
  assert.equal(status.planReminder, 'auto');
  assert.equal(status.requireReason, true);
});

test('v0.2 malformed SessionStart and prompt inputs fail open silently', t => {
  const f = fixture(t);
  for (const event of ['SessionStart', 'UserPromptSubmit']) {
    for (const input of ['{', 'null', '{}']) silent(f.run(event, input));
  }
  silent(f.run('UserPromptSubmit', { session_id: 'test-session', cwd: f.repo, prompt: 42 }));
});

test('v0.2 review a real dispatch mentioning justify in its brief is still counted', t => {
  const f = fixture(t);
  silent(f.hook('Bash', { command: 'codex exec "implement guard.mjs justify --reason support"' }));
  assert.equal(f.state().delegations.total, 1);
});

test('v0.2 review an already overridden proposal does not size a later delegation', t => {
  const f = fixture(t);
  denied(f.edit(lines(61)));
  f.cli('justify', ['--reason', 'costly context']);
  silent(f.edit(lines(61)));
  silent(f.hook('Agent', { subagent_type: 'codex:codex-rescue' }));
  const stats = JSON.parse(f.cli('stats').stdout);
  assert.equal(stats.metrics.total.medianDelegatedTurnLines, null);
  assert.equal(stats.metrics.total.measuredDelegatedTurns, 0);
});

test('v0.2 review deny uses the hook session ID and justify cannot authorize another session', t => {
  const f = fixture(t);
  const result = f.hook('Edit', { file_path: 'a.ts', new_string: lines(61) }, { session_id: 'from-hook-42' });
  denied(result);
  assert.match(result.stderr, /justify --session-id from-hook-42 --reason/);
  assert.doesNotMatch(result.stderr, /--session-id test-session/);
  f.cli('justify', ['--session-id', 'other-session', '--reason', 'costly context']);
  assert.equal(f.hook('Edit', { file_path: 'a.ts', new_string: lines(61) }, { session_id: 'from-hook-42' }).status, 2);
});

test('v0.2 review Unicode reasons stay within 200 characters and normalize to one line', t => {
  const f = fixture(t);
  f.cli('justify', ['--reason', `  context\r\n transfer ${'🧪'.repeat(210)}  `]);
  const reason = f.state().justification.reason;
  assert.equal(Array.from(reason).length, 200);
  assert.match(reason, /^context transfer /);
  assert.doesNotMatch(reason, /[\r\n]/);
});

test('v0.2 review compact reinjects policy without resetting turn state or reminder cadence', t => {
  const f = fixture(t);
  context(f.prompt('fix the bug'), 'UserPromptSubmit');
  denied(f.edit(lines(61)));
  f.cli('justify', ['--reason', 'costly context']);
  const before = f.state();
  context(f.run('SessionStart', { session_id: 'test-session', cwd: f.repo, source: 'compact' }), 'SessionStart');
  assert.deepEqual(f.state(), before);
  silent(f.prompt('fix the file'));
});

const nonUserPromptMarkers = [
  '<task-notification', '<system-reminder', '[SYSTEM NOTIFICATION',
  '<cross-session-message', '<side-sessions-event', '<ci-monitor-event',
];

for (const marker of nonUserPromptMarkers) {
  for (const whitespace of ['', ' \t\r\n\u2003']) {
    test(`v0.2.1 ${JSON.stringify(whitespace + marker)} preserves a justified retry and turn state`, t => {
      const f = fixture(t);
      const reason = 'Context is costly to transfer';
      context(f.prompt('fix the code'), 'UserPromptSubmit');
      silent(f.edit(lines(20)));
      denied(f.edit(lines(61)));
      assert.equal(f.cli('justify', ['--reason', reason]).status, 0);
      const before = f.state();
      silent(f.prompt(`${whitespace}${marker}> fix the code: background task finished`));
      const after = f.state();
      silent(f.edit(lines(61)));
      assert.deepEqual(after, before);
      assert.deepEqual(f.records().map(row => row.decision), ['allow', 'deny', 'override']);
      assert.equal(f.records().at(-1).reason, reason);
      assert.equal(f.state().turnLines, 81);
      assert.equal(f.state().delegations.total, 0);
      assert.deepEqual(JSON.parse(f.cli('stats').stdout).recentOverrides, [{ path: 'src/main.ts', reason }]);
    });
  }
}

test('v0.2.1 a notification cannot refill the default 150-line turn budget', t => {
  const f = fixture(t);
  silent(f.edit(lines(50)));
  silent(f.edit(lines(50)));
  silent(f.prompt('  <task-notification>finished'));
  const result = f.edit(lines(60));
  denied(result);
  assert.match(result.stderr, /160 lines this turn \(limits 60\/call, 150\/turn\)/);
  assert.equal(f.state().turnLines, 100);
  assert.equal(f.state().sessionLines, 100);
  assert.deepEqual(f.records().map(row => row.decision), ['allow', 'allow', 'deny']);
});

test('v0.2.1 notifications preserve a turn pause and suppress an otherwise due reminder', t => {
  const f = fixture(t, { planReminder: 'always' });
  silent(f.prompt('no codex'));
  silent(f.edit(lines(100)));
  const before = f.state();
  assert.equal(before.turnPaused, true);
  assert.equal(before.lastPlanReminderPrompt, null);
  for (const marker of nonUserPromptMarkers) {
    silent(f.prompt(`\n${marker}> fix the code`));
    assert.deepEqual(f.state(), before);
  }
  silent(f.edit(lines(60)));
  assert.equal(f.state().turnLines, 160);
  assert.equal(f.records().at(-1).decision, 'paused');
});

test('v0.2.1 notifications do not advance the three-real-prompt reminder cadence', t => {
  const f = fixture(t);
  context(f.prompt('fix the code'), 'UserPromptSubmit');
  silent(f.prompt('fix the code'));
  const before = f.state();
  for (const marker of nonUserPromptMarkers) {
    silent(f.prompt(`${marker}> fix the code, no codex`));
    assert.deepEqual(f.state(), before);
  }
  silent(f.prompt('fix the code'));
  context(f.prompt('fix the code'), 'UserPromptSubmit');
  assert.equal(f.state().promptCount, 4);
  assert.equal(f.state().lastPlanReminderPrompt, 4);
});

test('v0.2.1 a real prompt after a notification still resets the turn and expires the reason', t => {
  const f = fixture(t);
  context(f.prompt('fix the code'), 'UserPromptSubmit');
  silent(f.edit(lines(20)));
  denied(f.edit(lines(61)));
  assert.equal(f.cli('justify', ['--reason', 'costly context']).status, 0);
  const before = f.state();
  silent(f.prompt('<cross-session-message>finished'));
  assert.deepEqual(f.state(), before);
  // A marker mentioned later in real user text is not a notification prefix.
  silent(f.prompt('Continue; the message mentioned <task-notification'));
  assert.equal(f.state().turnLines, 0);
  assert.equal(f.state().lastDeniedFingerprint, null);
  assert.equal(f.state().justification, null);
  assert.equal(f.state().turnDeniedLines, null);
  assert.equal(f.state().turnPaused, false);
  assert.equal(f.state().sessionLines, 20);
  assert.equal(f.state().promptCount, before.promptCount + 1);
  assert.equal(f.state().lastPlanReminderPrompt, before.lastPlanReminderPrompt);
  denied(f.edit(lines(61)));
  silent(f.prompt('no codex'));
  assert.equal(f.state().turnPaused, true);
  context(f.prompt('fix the code'), 'UserPromptSubmit');
  assert.equal(f.state().turnPaused, false);
});

test('v0.2.1 reminderRequiresGit false enables non-git coding reminders while true remains the default', t => {
  const f = fixture(t);
  const prompt = text => f.run('UserPromptSubmit', { session_id: 'test-session', cwd: f.dir, prompt: text });
  silent(prompt('fix the code'));
  f.setConfig({ reminderRequiresGit: false }, true);
  context(prompt('fix the code'), 'UserPromptSubmit');
  silent(prompt('fix the code'));
  silent(prompt('fix the code'));
  context(prompt('fix the code'), 'UserPromptSubmit');
  assert.equal(f.state().lastPlanReminderPrompt, 5);
  f.setConfig({ reminderRequiresGit: true }, true);
  for (let i = 0; i < 3; i++) silent(prompt('fix the code'));
  // Enforcement still scopes changes to Git work trees.
  silent(f.edit(lines(100), path.join(f.dir, 'outside.ts')));
  assert.deepEqual(f.records(), []);
});

test('v0.2.1 non-git reminders retain auto, always, off and pause behavior', t => {
  const f = fixture(t);
  const prompt = text => f.run('UserPromptSubmit', { session_id: 'test-session', cwd: f.dir, prompt: text });
  f.setConfig({ reminderRequiresGit: false }, true);
  silent(prompt('Hello'));
  context(prompt('fix the code'), 'UserPromptSubmit');
  f.setConfig({ reminderRequiresGit: false, planReminder: 'always' }, true);
  silent(prompt('Hello'));
  silent(prompt('Hello'));
  context(prompt('Hello'), 'UserPromptSubmit');
  f.setConfig({ reminderRequiresGit: false, planReminder: 'off' }, true);
  for (let i = 0; i < 3; i++) silent(prompt('fix the code'));
  f.setConfig({ reminderRequiresGit: false, planReminder: 'always' }, true);
  silent(prompt('no codex'));
  context(prompt('Hello'), 'UserPromptSubmit');
  assert.equal(f.cli('pause').status, 0);
  for (let i = 0; i < 3; i++) silent(prompt('fix the code'));
  assert.equal(f.cli('resume').status, 0);
  context(prompt('Hello'), 'UserPromptSubmit');
});

for (const value of [null, false, 42, '<custom-event', {}, [''], [' \t '], ['<custom-event', null]]) {
  test(`v0.2.1 invalid nonUserPromptMarkers ${JSON.stringify(value)} restores all default markers`, t => {
    const f = fixture(t, { nonUserPromptMarkers: value });
    f.setConfig({ nonUserPromptMarkers: ['<custom-event'] }, true);
    silent(f.edit(lines(10)));
    denied(f.edit(lines(61)));
    assert.equal(f.cli('justify', ['--reason', 'costly context']).status, 0);
    const before = f.state();
    for (const marker of nonUserPromptMarkers) {
      silent(f.prompt(` \t${marker}>finished`));
      assert.deepEqual(f.state(), before);
    }
    silent(f.edit(lines(61)));
    assert.equal(f.records().at(-1).reason, 'costly context');
  });
}

test('v0.2.1 custom nonUserPromptMarkers replace defaults and an empty list disables filtering', t => {
  const f = fixture(t, { nonUserPromptMarkers: ['<custom-event', '[LOCAL NOTICE'] });
  silent(f.edit(lines(10)));
  denied(f.edit(lines(61)));
  assert.equal(f.cli('justify', ['--reason', 'costly context']).status, 0);
  const before = f.state();
  for (const marker of ['<custom-event', '[LOCAL NOTICE']) {
    silent(f.prompt(`  ${marker}>finished`));
    assert.deepEqual(f.state(), before);
  }
  silent(f.edit(lines(61)));
  assert.equal(f.records().at(-1).decision, 'override');
  silent(f.prompt('<task-notification>now an ordinary prompt'));
  assert.equal(f.state().turnLines, 0);
  assert.equal(f.state().justification, null);
  silent(f.edit(lines(10)));
  f.setConfig({ nonUserPromptMarkers: [] });
  silent(f.prompt('<custom-event>now an ordinary prompt'));
  assert.equal(f.state().turnLines, 0);
  assert.equal(f.state().promptCount, 2);
});

test('v0.2.1 reminderRequiresGit validates booleans and repository values override global values', t => {
  const f = fixture(t);
  f.setConfig({ reminderRequiresGit: false }, true);
  const nonGitPrompt = session_id => f.run('UserPromptSubmit', {
    session_id, cwd: f.dir, prompt: 'fix the code',
  });
  context(nonGitPrompt('global-false'), 'UserPromptSubmit');
  assert.equal(JSON.parse(f.cli('status').stdout).reminderRequiresGit, false);
  f.setConfig({ reminderRequiresGit: true });
  assert.equal(JSON.parse(f.cli('status').stdout).reminderRequiresGit, true);
  for (const [index, value] of [null, 'false', 0, [], {}].entries()) {
    f.setConfig({ reminderRequiresGit: value });
    assert.equal(JSON.parse(f.cli('status').stdout).reminderRequiresGit, true);
    f.setConfig({ reminderRequiresGit: value }, true);
    silent(nonGitPrompt(`invalid-${index}`));
  }
});
