import { spawnSync } from 'node:child_process';
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const helper = fileURLToPath(new URL('../src/main.mjs', import.meta.url));
const sessionId = '01a0e39c-ee2d-7000-b25e-87255b8fee49';

async function fixture(fn) {
  const home = await mkdtemp(join(tmpdir(), 'team-session-gate-'));
  const team = 'tb-1008-120000';
  const dir = join(home, '.local/state/team-building', team);
  const bin = join(home, 'bin');
  const log = join(home, 'events.jsonl');
  const session = join(dir, 'sessions/w1', `${sessionId}.jsonl`);
  try {
    await Promise.all(['logs', 'results', 'sessions/w1'].map(path => mkdir(join(dir, path), { recursive: true })));
    await mkdir(bin);
    await writeFile(log, '');
    await writeFile(session, JSON.stringify({ type: 'session', version: 3, id: sessionId, cwd: dir }) + '\n');
    const worker = { id: 'w1', harness: 'omp', model: null, state: 'idle', retiring: false,
      assignments: 1, session_dir: join(dir, 'sessions/w1'), log: join(dir, 'logs/w1.log'), cwd: dir,
      terminal: 'old-handle', terminal_pty_id: 'worker-pty', terminal_tab_id: 'worker-tab', terminal_leaf_id: 'worker-leaf',
      terminal_started: true, terminal_incarnation_id: 'worker-life', session_id: sessionId, session_file: session, terminal_model: null, terminal_thinking: null };
    const saveWorker = async changes => writeFile(join(dir, 'team.json'), JSON.stringify({ id: team, cwd: dir, worktree: dir,
      harness: 'omp', model: null, next_task: 1, next_worker: 2, workers: { w1: { ...worker, ...changes } }, queue: [] }));
    await saveWorker({});
    await writeFile(join(bin, 'orca-ide'), `#!/usr/bin/env node
import { appendFile, readFile, writeFile } from 'node:fs/promises';
const a = process.argv.slice(2, -1), mode = process.env.SCENARIO;
const terminal = { handle: mode === 'stale' ? 'replacement-handle' : 'old-handle', ptyId: 'worker-pty', incarnationId: mode === 'impostor' ? 'different-life' : 'worker-life', tabId: 'worker-tab', leafId: 'worker-leaf', worktreePath: process.env.TEAM_DIR, connected: !['disconnected', 'exited'].includes(mode), writable: mode !== 'disconnected', exited: mode === 'exited', exitCode: mode === 'exited' ? 0 : null };
if (mode === 'mid-exit' && (await readFile(process.env.EVENT_LOG, 'utf8')).includes('"type":"send"')) { terminal.exited = true; terminal.exitCode = 0; }
let result = {};
if (a[0] === 'status') result = { app: { running: true }, runtime: { reachable: true } };
if (a[0] === 'worktree') result = { worktree: { path: process.env.TEAM_DIR } };
if (a[0] === 'terminal' && a[1] === 'show') {
  if (mode === 'stale' && a.includes('old-handle')) { console.log(JSON.stringify({ ok: false, error: { code: 'terminal_handle_stale' } })); process.exit(1); }
  if (mode === 'missing' || mode === 'create-lost') { console.log(JSON.stringify({ ok: false })); process.exit(1); }
  result = { terminal };
}
if (a[0] === 'terminal' && a[1] === 'list') result = { terminals: ['missing', 'create-lost', 'exited'].includes(mode) ? [] : [terminal], truncated: false };
if (a[0] === 'terminal' && ['create', 'close', 'send'].includes(a[1])) {
  await appendFile(process.env.EVENT_LOG, JSON.stringify({ type: a[1], args: a }) + '\\n');
  if (a[1] === 'create') {
    await writeFile(process.env.SESSION_FILE, JSON.stringify({ type: 'session', id: ${JSON.stringify(sessionId)}, cwd: process.env.TEAM_DIR }) + '\\n');
    if (mode === 'create-lost') { console.log(JSON.stringify({ ok: false })); process.exit(1); }
    result = { terminal: { ...terminal, handle: 'new-handle' } };
  }
  if (a[1] === 'close' && mode === 'close-failed') { console.log(JSON.stringify({ ok: false })); process.exit(1); }
  if (a[1] === 'send') {
    const task = a[a.indexOf('--text') + 1].match(/Assignment (t\\d+)/)[1];
    if (mode !== 'mid-exit' && mode !== 'no-result') await writeFile(process.env.TEAM_DIR + '/results/' + task + '.json', JSON.stringify({ status: 'succeeded', summary: 'reconnected task completed' }));
  }
}
console.log(JSON.stringify({ ok: true, result }));
`);
    await writeFile(join(bin, 'omp'), `#!/usr/bin/env node
import { appendFile, writeFile } from 'node:fs/promises';
const a = process.argv.slice(2);
await appendFile(process.env.EVENT_LOG, JSON.stringify({ type: 'resume', args: a }) + '\\n');
if (!a.includes('-p') || a[a.indexOf('--resume') + 1] !== process.env.SESSION_FILE) process.exit(7);
if (process.env.SCENARIO === 'resume-timeout') { setInterval(() => {}, 1000); await new Promise(() => {}); }
const brief = a.at(-1).match(/read (.+?) and do it/)[1];
const task = brief.match(/(t\\d+)\\.md$/)[1];
await writeFile(process.env.TEAM_DIR + '/results/' + task + '.json', JSON.stringify({ status: 'succeeded', summary: 'same session resumed' }));
if (process.env.SCENARIO === 'resume-failed') process.exit(7);
`);
    await Promise.all(['orca-ide', 'omp'].map(name => chmod(join(bin, name), 0o755)));
    const run = (scenario, extra = []) => spawnSync(process.execPath, [helper, 'assign', '--team', team, '--worker', 'w1', '--timeout', '5', '--max', '10', ...extra, 'work'], {
      cwd: dir, encoding: 'utf8', timeout: 40000,
      env: { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}`, ORCA_CLI_COMMAND: join(bin, 'orca-ide'),
        SCENARIO: scenario, TEAM_DIR: dir, EVENT_LOG: log, SESSION_FILE: session },
    });
    const events = async () => (await readFile(log, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
    await fn({ dir, session, worker, saveWorker, run, events });
  } finally { await rm(home, { recursive: true, force: true }); }
}

test('reacquires a stale runtime handle using pinned PTY without creating another tab', async () => fixture(async ({ run, events, dir }) => {
  const result = run('stale');
  assert.equal(result.status, 0, result.stderr);
  const calls = await events();
  assert.deepEqual(calls.map(call => call.type), ['send']);
  assert.ok(calls[0].args.includes('replacement-handle'));
  assert.equal(JSON.parse(await readFile(join(dir, 'team.json'), 'utf8')).workers.w1.terminal, 'replacement-handle');
}));

test('does not confuse a disconnected PTY with an exited process', async () => fixture(async ({ run, events }) => {
  const result = run('disconnected');
  assert.match(result.stdout, /failed/);
  assert.deepEqual(await events(), []);
}));

test('confirmed exit resumes exactly the pinned session without creating a tab', async () => fixture(async ({ run, events, session, dir }) => {
  const result = run('exited');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /same session resumed/);
  const calls = await events();
  assert.deepEqual(calls.map(call => call.type), ['resume']);
  assert.equal(calls[0].args[calls[0].args.indexOf('--resume') + 1], session);
  assert.equal(JSON.parse(await readFile(join(dir, 'team.json'), 'utf8')).workers.w1.session_id, sessionId);
}));

test('a lost pinned session never falls back to a fresh session', async () => fixture(async ({ run, events, session }) => {
  await rm(session);
  const result = run('exited');
  assert.match(result.stdout, /failed/);
  assert.deepEqual(await events(), []);
}));

test('model routing resumes pinned conversation instead of reopening a tab', async () => fixture(async ({ run, events }) => {
  const result = run('live', ['--difficulty', 'simple']);
  assert.match(result.stdout, /same session resumed/);
  const calls = await events();
  assert.deepEqual(calls.map(call => call.type), ['close', 'resume']);
  assert.ok(calls[1].args.includes('openai-codex/gpt-5.6-luna'));
}));

test('first launch records its session and PTY before later assignments reuse them', async () => fixture(async ({ run, events, session, saveWorker, dir }) => {
  await rm(session);
  await saveWorker({ terminal: null, terminal_started: false, session_id: null, session_file: null });
  assert.match(run('first').stdout, /succeeded/);
  const stored = JSON.parse(await readFile(join(dir, 'team.json'), 'utf8')).workers.w1;
  assert.equal(stored.session_id, sessionId);
  assert.equal(stored.session_file, session);
  assert.equal(stored.terminal_pty_id, 'worker-pty');
  assert.match(run('live').stdout, /succeeded/);
  assert.deepEqual((await events()).map(call => call.type), ['create', 'send', 'send']);
}));

test('uncertain creation response cannot cause a second terminal create', async () => fixture(async ({ run, events, session, saveWorker }) => {
  await rm(session);
  await saveWorker({ terminal: null, terminal_started: false, session_id: null, session_file: null });
  assert.match(run('create-lost').stdout, /failed/);
  assert.match(run('create-lost').stdout, /failed/);
  assert.deepEqual((await events()).map(call => call.type), ['create']);
}));

test('missing or replaced PTY cannot adopt a different session', async () => {
  for (const scenario of ['missing', 'impostor']) await fixture(async ({ run, events }) => {
    assert.match(run(scenario).stdout, /failed/);
    assert.deepEqual(await events(), []);
  });
});

test('failed stop cannot launch a concurrent resume', async () => fixture(async ({ run, events }) => {
  assert.match(run('close-failed', ['--difficulty', 'simple']).stdout, /failed to close worker terminal/);
  assert.deepEqual((await events()).map(call => call.type), ['close']);
}));

test('an uncertain or live headless owner prevents another session writer', async () => {
  for (const fields of [{ headless_pending: true }, { child: process.pid }]) await fixture(async ({ run, events, saveWorker }) => {
    await saveWorker(fields);
    assert.match(run('exited').stdout, /refusing a concurrent session/);
    assert.deepEqual(await events(), []);
  });
});

test('exit during an assignment resumes that same task instead of sending a second task', async () => fixture(async ({ run, events }) => {
  const result = run('mid-exit', ['--timeout', '25', '--max', '30']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /same session resumed/);
  const calls = await events();
  assert.deepEqual(calls.map(call => call.type), ['send', 'resume']);
  assert.match(calls[1].args.at(-1), /Assignment t001:/);
}));

test('timeout records a confirmed stop so the next assignment resumes without a tab', async () => fixture(async ({ run, events, dir }) => {
  assert.match(run('no-result', ['--timeout', '1', '--max', '2']).stdout, /timeout/);
  assert.equal(JSON.parse(await readFile(join(dir, 'team.json'), 'utf8')).workers.w1.terminal_stopped, true);
  assert.match(run('live').stdout, /same session resumed/);
  assert.deepEqual((await events()).map(call => call.type), ['send', 'close', 'resume']);
}));

test('headless timeout stops the child before releasing the worker', async () => fixture(async ({ run, events, dir, saveWorker }) => {
  await saveWorker({ terminal_stopped: true });
  assert.match(run('resume-timeout', ['--timeout', '1', '--max', '2']).stdout, /timeout/);
  const worker = JSON.parse(await readFile(join(dir, 'team.json'), 'utf8')).workers.w1;
  assert.equal(worker.state, 'idle');
  assert.equal(worker.child, null);
  assert.equal(worker.headless_pending, false);
  assert.deepEqual((await events()).map(call => call.type), ['resume']);
}));

test('a result file cannot hide a failing native resume process', async () => fixture(async ({ run, events, saveWorker }) => {
  await saveWorker({ terminal_stopped: true });
  assert.match(run('resume-failed').stdout, /session resume failed: 7/);
  assert.deepEqual((await events()).map(call => call.type), ['resume']);
}));

test('installed skill symlink executes the helper rather than silently returning', async () => {
  const home = await mkdtemp(join(tmpdir(), 'team-entrypoint-'));
  try {
    const installed = join(home, 'team-building');
    await symlink(fileURLToPath(new URL('../', import.meta.url)), installed, 'dir');
    const result = spawnSync(process.execPath, [join(installed, 'src/main.mjs'), '--help'], { encoding: 'utf8', cwd: home });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /usage: node src\/main\.mjs/);
  } finally { await rm(home, { recursive: true, force: true }); }
});
