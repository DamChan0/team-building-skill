import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { chmod, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { checkIdleWorkers, chooseWorker, parseArgs, routedAssignment } from '../src/main.mjs';
import { Supervisor, supervisorBinary, supervisorPaths } from '../src/supervisor.mjs';

const main = fileURLToPath(new URL('../src/main.mjs', import.meta.url));
const router = { enabled: true, models: { simple: { model: 'openai-codex/gpt-5.6-luna', thinking: 'max' } } };
process.env.TEAM_BUILDING_DISABLE_IDLE_WATCHER = '1';

test('selects a compatible durable queue worker without requiring idle metadata', () => {
  const data = { model: null, harness: 'omp', router, queue: [{ task: 't001', worker: 'w1', kind: 'task', difficulty: 'simple' }], workers: { w1: { id: 'w1', harness: 'omp', state: 'busy', retiring: false, assignments: 2 } } };
  assert.deepEqual(chooseWorker(data, 't001', 'task'), ['take', 'w1']);
  assert.deepEqual(routedAssignment(data, { worker: 'w1', difficulty: 'simple' }), { ...router.models.simple, difficulty: 'simple' });
});

test('parses assignment sentinels and exact approval argv', () => {
  const requestId = '80000000-0000-4000-8000-000000000001';
  const assignment = parseArgs([
    'assign', '--team', 'tb-0101-000001', '--worker', 'w2',
    '--request-id', requestId, '--approval', 't001', '--difficulty', 'complex', '-',
  ]);
  assert.equal(assignment.prompt, '-');
  assert.equal(assignment.request_id, requestId);
  assert.equal(assignment.approval, 't001');
  assert.equal(assignment.difficulty, 'complex');
  assert.equal(parseArgs(['init', '--idle-stop', '15m']).idleStopMs, 15 * 60 * 1000);
  assert.equal(parseArgs(['init', '--idle-stop', '0']).idleStopMs, 0);

});

test('detached CLI work prints only its task id and wait consumes completed mappings', { skip: !existsSync(supervisorBinary) }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'team-building-detach-'));
  const stateRoot = join(home, '.local', 'state', 'team-building');
  const team = 'tb-0101-000003';
  const teamDir = join(stateRoot, team);
  const root = join(home, 'worktree');
  const bin = join(home, 'bin');
  const orca = join(bin, 'orca-ide');
  const omp = join(bin, 'omp');
  const tab = join(teamDir, 'tabs', 'w1');
  const terminalState = join(home, 'orca-terminals.json');
  const orcaCalls = join(home, 'orca-calls.jsonl');
  const paths = supervisorPaths(stateRoot);
  const client = new Supervisor(paths);
  let daemon;
  let worker;
  const environment = {
    ...process.env,
    HOME: home,
    ORCA_WORKTREE_ID: '',
    ORCA_TERMINAL_HANDLE: '',
    ORCA_CLI_COMMAND: orca,
    ORCA_TEST_CALLS: orcaCalls,
    ORCA_TEST_TERMINALS: terminalState,
    PATH: `${bin}:${process.env.PATH}`,
    XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR || '/tmp',
  };
  try {
    await writeFile(terminalState, JSON.stringify([
      { handle: 'fixture-tab', connected: true, orphaned: false },
      { handle: 'manager-tab', connected: true, orphaned: false },
    ]));
    await Promise.all([mkdir(root, { recursive: true }), mkdir(bin, { recursive: true }), mkdir(tab, { recursive: true }), mkdir(join(teamDir, 'results'), { recursive: true }), mkdir(paths.stateDir, { recursive: true })]);
    await writeFile(orca, `#!/usr/bin/env node
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
const args = process.argv.slice(2, -1);
appendFileSync(process.env.ORCA_TEST_CALLS, JSON.stringify(args) + '\\n');
let result = { app: { running: true }, runtime: { reachable: true } };
if (args[0] === 'worktree') result = { worktree: { path: ${JSON.stringify(root)} } };
if (args[0] === 'terminal' && args[1] === 'list') {
  result = { terminals: JSON.parse(readFileSync(process.env.ORCA_TEST_TERMINALS, 'utf8')) };
}
if (args[0] === 'terminal' && args[1] === 'close') {
  const handle = args[args.indexOf('--terminal') + 1];
  const terminals = JSON.parse(readFileSync(process.env.ORCA_TEST_TERMINALS, 'utf8'));
  writeFileSync(process.env.ORCA_TEST_TERMINALS, JSON.stringify(terminals.filter(item => item.handle !== handle)));
  result = { closed: true };
}
console.log(JSON.stringify({ ok: true, result }));
`);
    await writeFile(omp, '#!/bin/sh\necho medium\n');
    await chmod(orca, 0o755);
    await chmod(omp, 0o755);
    await writeFile(join(teamDir, 'team.json'), JSON.stringify({
      id: team, cwd: root, worktree: root, backend: 'orca', model: 'fixture-model', harness: 'omp',
      next_task: 1, next_worker: 2, queue: [], detached: {},
      workers: {
        w1: {
          id: 'w1', state: 'idle', retiring: false, assignments: 0, harness: 'omp',
          observer: 'fixture-tab', observer_kind: 'tab', session_id: null, session_file: null,
          session_dir: join(teamDir, 'sessions', 'w1'), cwd: root, worktree: null, log: join(teamDir, 'logs', 'w1.log'),
        },
      },
    }));
    await writeFile(join(home, 'tab.mjs'), `import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
const dir = ${JSON.stringify(tab)};
const release = ${JSON.stringify(join(home, 'release-t002'))};
mkdirSync(dir, { recursive: true });
writeFileSync(${JSON.stringify(join(home, 'fixture.session'))}, JSON.stringify({ type: 'session', id: 'fixture-session', cwd: ${JSON.stringify(root)} }) + '\\n');
writeFileSync(dir + '/ready.json', JSON.stringify({ pid: process.pid, session_id: 'fixture-session', session_file: ${JSON.stringify(join(home, 'fixture.session'))} }));
let count = 0;
let pendingTask = null;
function complete(task, status, summary, toolTab = null) {
  const toolSessions = (Array.isArray(toolTab) ? toolTab : toolTab ? [toolTab] : []).map(id => ({ kind: 'tab', id }));
  const result = { status, summary, files_changed: [], files_deleted: [], verification: 'fixture', blockers: [], approval_requests: [], tool_sessions: toolSessions, branch: '', commit: '' };
  const outcome = { request_id: task.request_id, text: JSON.stringify(result) };
  writeFileSync(dir + '/outcome.json.tmp', JSON.stringify(outcome));
  renameSync(dir + '/outcome.json.tmp', dir + '/outcome.json');
}
function addToolTab(id) {
  const terminals = JSON.parse(readFileSync(process.env.ORCA_TEST_TERMINALS, 'utf8'));
  terminals.push({ handle: id, connected: true, orphaned: false });
  writeFileSync(process.env.ORCA_TEST_TERMINALS, JSON.stringify(terminals));
}
setInterval(() => {
  writeFileSync(dir + '/beat', String(Date.now()));
  if (pendingTask && existsSync(release)) {
    complete(pendingTask, 'failed', 'fixture failure');
    pendingTask = null;
  }
  let task; try { task = JSON.parse(readFileSync(dir + '/task.json', 'utf8')); } catch { return; }
  rmSync(dir + '/task.json');
  const current = ++count;
  if (current === 1) {
    addToolTab('tool-tab-1');
    complete(task, 'succeeded', 'fixture complete', 'tool-tab-1');
  } else if (current === 3) {
    addToolTab('tool-tab-2');
    complete(task, 'succeeded', 'blocking complete', ['tool-tab-2', 'fixture-tab', 'manager-tab']);
  } else pendingTask = task;
}, 20);
`);
    worker = spawn(process.execPath, [join(home, 'tab.mjs')], { stdio: 'ignore', env: environment });
    await delay(100);
    daemon = spawn(supervisorBinary, ['serve', '--state-dir', paths.stateDir, '--socket', paths.socket], { stdio: ['ignore', 'pipe', 'inherit'] });
    const readiness = createInterface({ input: daemon.stdout });
    const [line] = await once(readiness, 'line', { signal: AbortSignal.timeout(5_000) });
    readiness.close();
    daemon.stdout.destroy();
    assert.equal(JSON.parse(line).payload?.ready, true);

    const detached = spawnSync(process.execPath, [main, 'assign', '--detach', '--team', team, '--worker', 'w1', 'first slice'], {
      cwd: root, encoding: 'utf8', timeout: 10_000, env: environment,
    });
    assert.equal(detached.status, 0, detached.stderr);
    assert.equal(detached.stdout, 't001\n');

    const waited = spawnSync(process.execPath, [main, 'wait', '--any', '--team', team, '--timeout', '5'], {
      cwd: root, encoding: 'utf8', timeout: 10_000, env: environment,
    });
    assert.equal(waited.status, 0, waited.stderr);
    assert.equal(waited.stdout.trim().split('\n').length, 1);
    assert.equal(JSON.parse(waited.stdout).status, 'succeeded');
    const waitedOutput = JSON.parse(waited.stdout);
    assert.equal(waitedOutput.tool_sessions_cleaned, 1);
    assert.deepEqual(waitedOutput.tool_session_cleanup_errors, []);
    assert.deepEqual(JSON.parse(await readFile(terminalState, 'utf8')).map(item => item.handle), ['fixture-tab', 'manager-tab']);
    assert.deepEqual(JSON.parse(await readFile(join(teamDir, 'team.json'), 'utf8')).detached, {});

    const pending = spawnSync(process.execPath, [main, 'assign', '--detach', '--team', team, '--worker', 'w1', 'second slice'], {
      cwd: root, encoding: 'utf8', timeout: 10_000, env: environment,
    });
    assert.equal(pending.status, 0, pending.stderr);
    assert.equal(pending.stdout, 't002\n');
    const timedOut = spawnSync(process.execPath, [main, 'wait', '--all', '--task', 't002', '--team', team, '--timeout', '1'], {
      cwd: root, encoding: 'utf8', timeout: 10_000, env: environment,
    });
    assert.equal(timedOut.status, 1);
    assert.equal(JSON.parse(await readFile(join(teamDir, 'team.json'), 'utf8')).detached.t002.worker, 'w1');
    await writeFile(join(home, 'release-t002'), '');
    const failed = spawnSync(process.execPath, [main, 'wait', '--task', 't002', '--team', team, '--timeout', '5'], {
      cwd: root, encoding: 'utf8', timeout: 10_000, env: environment,
    });
    assert.equal(failed.status, 1, failed.stderr);
    assert.equal(JSON.parse(failed.stdout).status, 'failed');
    assert.deepEqual(JSON.parse(await readFile(join(teamDir, 'team.json'), 'utf8')).detached, {});
    const blocking = spawnSync(process.execPath, [main, 'assign', '--team', team, '--worker', 'w1', 'blocking slice'], {
      cwd: root, encoding: 'utf8', timeout: 10_000, env: environment,
    });
    assert.equal(blocking.status, 1, blocking.stderr);
    const blockingOutput = JSON.parse(blocking.stdout.slice(blocking.stdout.indexOf('\n') + 1));
    assert.equal(blockingOutput.status, 'succeeded');
    assert.equal(blockingOutput.tool_sessions_cleaned, 1);
    assert.deepEqual(blockingOutput.tool_session_cleanup_errors, [
      'refused to close a team worker tab',
      'refused to close a tab that existed before this assignment',
    ]);
    assert.deepEqual(JSON.parse(await readFile(terminalState, 'utf8')).map(item => item.handle), ['fixture-tab', 'manager-tab']);
    const closed = (await readFile(orcaCalls, 'utf8')).trim().split('\n')
      .map(line => JSON.parse(line))
      .filter(args => args[0] === 'terminal' && args[1] === 'close')
      .map(args => args[args.indexOf('--terminal') + 1]);
    assert.deepEqual(closed, ['tool-tab-1', 'tool-tab-2']);
  } finally {
    if (worker?.pid && worker.exitCode === null && worker.signalCode === null) {
      const exited = once(worker, 'exit');
      worker.kill('SIGKILL');
      await exited;
    }
    if (daemon?.pid && daemon.exitCode === null) {
      const exited = once(daemon, 'exit');
      await client.request('shutdown', {}, undefined, 1_000).catch(() => daemon.kill('SIGTERM'));
      await exited;
    }
    await rm(home, { recursive: true, force: true });
  }
});
test('idle OMP workers stay stopped on adoption and resume their exact session on assign', { skip: !existsSync(supervisorBinary) }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'team-building-idle-'));
  const root = join(home, 'worktree');
  const bin = join(home, 'bin');
  const stateRoot = join(home, '.local', 'state', 'team-building');
  const team = 'tb-0101-000004';
  const teamDir = join(stateRoot, team);
  const paths = supervisorPaths(stateRoot);
  const client = new Supervisor(paths);
  const orca = join(bin, 'orca-ide');
  const omp = join(bin, 'omp');
  const workerScript = join(home, 'worker.mjs');
  const sessionFile = join(home, 'saved-session.jsonl');
  const terminalState = join(home, 'terminals.json');
  const orcaCalls = join(home, 'orca-calls.jsonl');
  const ompCalls = join(home, 'omp-calls.txt');
  const terminalPids = join(home, 'terminal-pids.txt');
  const environment = {
    ...process.env,
    HOME: home,
    ORCA_WORKTREE_ID: '',
    ORCA_TERMINAL_HANDLE: '',
    ORCA_CLI_COMMAND: orca,
    ORCA_TEST_CALLS: orcaCalls,
    ORCA_TEST_TERMINALS: terminalState,
    ORCA_TEST_PIDS: terminalPids,
    OMP_TEST_CALLS: ompCalls,
    OMP_TEST_WORKER: workerScript,
    OMP_TEST_SESSION_FILE: sessionFile,
    TEAM_BUILDING_DISABLE_IDLE_WATCHER: '',
    PATH: `${bin}:${process.env.PATH}`,
    XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR || '/tmp',
  };
  let daemon;
  const workerData = async () => JSON.parse(await readFile(join(teamDir, 'team.json'), 'utf8'));
  const waitForStopped = async () => {
    const deadline = Date.now() + 5_000;
    for (;;) {
      const data = await workerData();
      if (data.workers.w1.run_state === 'stopped') return data;
      if (Date.now() >= deadline) assert.fail('idle watcher did not stop the worker');
      await delay(20);
    }
  };
  const waitForProcessExit = async pid => {
    const deadline = Date.now() + 3_000;
    for (;;) {
      try {
        process.kill(pid, 0);
        if (Date.now() >= deadline) assert.fail('idle OMP worker process did not stop');
        await delay(20);
      } catch (error) {
        if (error.code === 'ESRCH') return;
        throw error;
      }
    }
  };
  try {
    await Promise.all([
      mkdir(root, { recursive: true }),
      mkdir(bin, { recursive: true }),
      mkdir(join(teamDir, 'sessions', 'w1'), { recursive: true }),
      mkdir(join(teamDir, 'results'), { recursive: true }),
      mkdir(paths.stateDir, { recursive: true }),
    ]);
    await writeFile(terminalState, '[]');
    await writeFile(sessionFile, JSON.stringify({ type: 'session', id: 'saved-session', cwd: root }) + '\n');
    await writeFile(join(teamDir, 'team.json'), JSON.stringify({
      id: team,
      cwd: root,
      worktree: root,
      backend: 'orca',
      model: 'fixture-model',
      harness: 'omp',
      approval_mode: 'yolo',
      allow_bypass: false,
      next_task: 1,
      next_worker: 2,
      closing: false,
      idle_stop_ms: 1,
      workers: {
        w1: {
          id: 'w1',
          model: 'fixture-model',
          state: 'idle',
          run_state: 'stopped',
          idle_since_ms: Date.now() - 60_000,
          task: null,
          task_prompt: null,
          retiring: false,
          assignments: 0,
          harness: 'omp',
          observer: null,
          observer_kind: null,
          session_id: 'saved-session',
          session_file: sessionFile,
          session_dir: join(teamDir, 'sessions', 'w1'),
          cwd: root,
          worktree: null,
          log: join(teamDir, 'logs', 'w1.log'),
        },
      },
      queue: [],
      detached: {},
      isolate: false,
    }));
    await writeFile(orca, `#!/usr/bin/env node
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
const args = process.argv.slice(2, -1);
appendFileSync(process.env.ORCA_TEST_CALLS, JSON.stringify(args) + '\\n');
const statePath = process.env.ORCA_TEST_TERMINALS;
let terminals = JSON.parse(readFileSync(statePath, 'utf8'));
let result = { app: { running: true }, runtime: { reachable: true } };
if (args[0] === 'worktree') result = { worktree: { path: ${JSON.stringify(root)} } };
if (args[0] === 'terminal' && args[1] === 'list') result = { terminals };
if (args[0] === 'terminal' && args[1] === 'create') {
  const handle = 'worker-tab-' + (terminals.length + 1);
  const launch = args[args.indexOf('--command') + 1];
  const child = spawn('/bin/sh', ['-c', launch], { cwd: ${JSON.stringify(root)}, detached: true, stdio: 'ignore', env: process.env });
  appendFileSync(process.env.ORCA_TEST_PIDS, String(child.pid) + '\\n');
  child.unref();
  terminals.push({ handle, pid: child.pid, connected: true, orphaned: false });
  writeFileSync(statePath, JSON.stringify(terminals));
  result = { terminal: { handle, connected: true } };
}
if (args[0] === 'terminal' && args[1] === 'close') {
  const handle = args[args.indexOf('--terminal') + 1];
  const terminal = terminals.find(item => item.handle === handle);
  if (terminal?.pid) { try { process.kill(-terminal.pid, 'SIGTERM'); } catch {} }
  terminals = terminals.filter(item => item.handle !== handle);
  writeFileSync(statePath, JSON.stringify(terminals));
  result = { closed: true };
}
console.log(JSON.stringify({ ok: true, result }));
`);
    await writeFile(omp, `#!/bin/sh
if [ "$1" = "config" ]; then printf 'yolo\\n'; exit 0; fi
printf '%s\\n' "$@" >> "$OMP_TEST_CALLS"
exec node "$OMP_TEST_WORKER"
`);
    await writeFile(workerScript, `import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
const dir = process.env.TEAM_BUILDING_TAB_DIR;
mkdirSync(dir, { recursive: true });
writeFileSync(dir + '/ready.json', JSON.stringify({
  pid: process.pid,
  session_id: 'saved-session',
  session_file: process.env.OMP_TEST_SESSION_FILE,
}));
setInterval(() => {
  writeFileSync(dir + '/beat', String(Date.now()));
  let task;
  try { task = JSON.parse(readFileSync(dir + '/task.json', 'utf8')); } catch { return; }
  rmSync(dir + '/task.json');
  const result = { status: 'succeeded', summary: 'resumed saved session', files_changed: [], files_deleted: [], verification: 'fixture', blockers: [], approval_requests: [], tool_sessions: [], branch: '', commit: '' };
  const outcome = { request_id: task.request_id, text: JSON.stringify(result) };
  writeFileSync(dir + '/outcome.json.tmp', JSON.stringify(outcome));
  renameSync(dir + '/outcome.json.tmp', dir + '/outcome.json');
}, 20);
`);
    await Promise.all([chmod(orca, 0o755), chmod(omp, 0o755)]);
    daemon = spawn(supervisorBinary, ['serve', '--state-dir', paths.stateDir, '--socket', paths.socket], { stdio: ['ignore', 'pipe', 'inherit'] });
    const readiness = createInterface({ input: daemon.stdout });
    const [line] = await once(readiness, 'line', { signal: AbortSignal.timeout(5_000) });
    readiness.close();
    daemon.stdout.destroy();
    assert.equal(JSON.parse(line).payload?.ready, true);

    const adopted = spawnSync(process.execPath, [main, 'init', '--team', team], {
      cwd: root, encoding: 'utf8', timeout: 10_000, env: environment,
    });
    assert.equal(adopted.status, 0, adopted.stderr);
    assert.match(adopted.stdout, /w1\s+stopped idle=/);
    assert.deepEqual(JSON.parse(await readFile(terminalState, 'utf8')), []);
    assert.equal((await readFile(orcaCalls, 'utf8')).includes('terminal","create'), false);

    const assigned = spawnSync(process.execPath, [main, 'assign', '--team', team, '--worker', 'w1', 'resume saved session'], {
      cwd: root, encoding: 'utf8', timeout: 15_000, env: environment,
    });
    assert.equal(assigned.status, 0, assigned.stderr);
    const ompArgs = (await readFile(ompCalls, 'utf8')).trim().split('\n');
    const resumeIndex = ompArgs.indexOf('--resume');
    assert.notEqual(resumeIndex, -1);
    assert.equal(ompArgs[resumeIndex + 1], sessionFile);
    let data = await waitForStopped();
    assert.equal(data.workers.w1.state, 'idle');
    assert.equal(data.workers.w1.observer, null);
    assert.equal(data.workers.w1.session_id, 'saved-session');
    assert.equal(data.workers.w1.session_file, sessionFile);
    assert.deepEqual(JSON.parse(await readFile(terminalState, 'utf8')), []);
    const workerPids = (await readFile(terminalPids, 'utf8')).trim().split('\n').map(Number);
    assert.equal(workerPids.length, 1);
    await waitForProcessExit(workerPids[0]);
    const status = spawnSync(process.execPath, [main, 'status', '--team', team], {
      cwd: root, encoding: 'utf8', timeout: 10_000, env: environment,
    });
    assert.equal(status.status, 0, status.stderr);
    assert.match(status.stdout, /w1\s+stopped idle=/);
    assert.equal(JSON.parse(await readFile(join(teamDir, 'team.json'), 'utf8')).workers.w1.run_state, 'stopped');

    const eager = spawnSync(process.execPath, [main, 'member', '1', '--team', team], {
      cwd: root, encoding: 'utf8', timeout: 10_000, env: environment,
    });
    assert.equal(eager.status, 0, eager.stderr);
    const resumeDeadline = Date.now() + 3_000;
    let allArgs = [];
    for (;;) {
      allArgs = (await readFile(ompCalls, 'utf8')).trim().split('\n');
      if (allArgs.filter(argument => argument === '--resume').length === 2) break;
      if (Date.now() >= resumeDeadline) assert.fail('member did not resume the saved OMP session');
      await delay(20);
    }
    data = await waitForStopped();
    assert.equal(data.workers.w1.state, 'idle');
    assert.equal(data.workers.w1.observer, null);
    assert.equal(data.workers.w1.session_id, 'saved-session');
    assert.equal(data.workers.w1.session_file, sessionFile);
    assert.deepEqual(JSON.parse(await readFile(terminalState, 'utf8')), []);
    const allPids = (await readFile(terminalPids, 'utf8')).trim().split('\n').map(Number);
    assert.equal(allPids.length, 2);
    await waitForProcessExit(allPids[1]);
  } finally {
    const terminals = JSON.parse(await readFile(terminalState, 'utf8').catch(() => '[]'));
    for (const terminal of terminals) {
      if (terminal.pid) { try { process.kill(-terminal.pid, 'SIGKILL'); } catch {} }
    }
    if (daemon?.pid && daemon.exitCode === null) {
      const exited = once(daemon, 'exit');
      await client.request('shutdown', {}, undefined, 1_000).catch(() => daemon.kill('SIGTERM'));
      await exited;
    }
    await rm(home, { recursive: true, force: true });
  }
});
test('idle OMP timeout closes herdr-app terminals through the HC backend', async () => {
  const home = await mkdtemp(join(tmpdir(), 'team-building-idle-hc-'));
  const stateRoot = join(home, '.local', 'state', 'team-building');
  const team = 'tb-0101-000005';
  const teamDir = join(stateRoot, team);
  const bin = join(home, 'bin');
  const hc = join(bin, 'hc');
  const calls = join(home, 'hc-calls.jsonl');
  const previous = {
    HC_CLI_COMMAND: process.env.HC_CLI_COMMAND,
    HC_TEST_CALLS: process.env.HC_TEST_CALLS,
  };
  let taskState = 'running';
  const client = {
    async status() {
      return {
        workers: [{ worker: 'w1', request_id: 'request-1', state: taskState, assignments: 1 }],
        queued: 0,
        has_more: false,
      };
    },
    async get() {
      return {
        task: {
          spec: { task: 't001', prompt: 'done', model: 'fixture-model' },
          session_id: 'saved-session',
          session_file: '/saved/session.jsonl',
          model: 'fixture-model',
          updated_ms: Date.now() - 60_000,
        },
      };
    },
  };
  try {
    await mkdir(teamDir, { recursive: true });
    await mkdir(bin, { recursive: true });
    await writeFile(join(teamDir, 'team.json'), JSON.stringify({
      id: team,
      backend: 'hc',
      socket: '/run/herdr-core/test.sock',
      cwd: '/workspace',
      closing: false,
      idle_stop_ms: 50,
      harness: 'omp',
      workers: {
        w1: {
          id: 'w1',
          harness: 'omp',
          state: 'idle',
          run_state: 'running',
          idle_since_ms: Date.now() - 60_000,
          observer: 't-worker',
          observer_kind: 'tab',
          session_id: 'saved-session',
          session_file: '/saved/session.jsonl',
          assignments: 0,
        },
      },
    }));
    await writeFile(hc, `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
const args = process.argv.slice(2);
appendFileSync(process.env.HC_TEST_CALLS, JSON.stringify({ args, socket: process.env.HC_SOCKET }) + '\\n');
const result = args[1] === 'get' ? { address: args[2], state: 'live' } : {};
console.log(JSON.stringify(result));
`);
    await chmod(hc, 0o755);
    process.env.HC_CLI_COMMAND = hc;
    process.env.HC_TEST_CALLS = calls;
    assert.equal(await checkIdleWorkers(stateRoot, client), true);
    assert.equal(existsSync(calls), false);
    taskState = 'succeeded';
    assert.equal(await checkIdleWorkers(stateRoot, client), false);
    const data = JSON.parse(await readFile(join(teamDir, 'team.json'), 'utf8'));
    assert.equal(data.workers.w1.run_state, 'stopped');
    assert.equal(data.workers.w1.observer, null);
    assert.equal(data.workers.w1.session_id, 'saved-session');
    assert.equal(data.workers.w1.session_file, '/saved/session.jsonl');
    const operations = (await readFile(calls, 'utf8')).trim().split('\n').map(JSON.parse);
    assert.deepEqual(operations.map(call => [call.args[1], call.args[2], call.socket]), [
      ['get', 't-worker', '/run/herdr-core/test.sock'],
      ['kill', 't-worker', '/run/herdr-core/test.sock'],
      ['rm', 't-worker', '/run/herdr-core/test.sock'],
    ]);
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await rm(home, { recursive: true, force: true });
  }
});
test('rejects assignments outside persisted Orca worktrees before supervisor startup', async () => {
  const scenarios = [
    { worktree: '/other-worktree', workerCwd: '/workspace/project', isolate: false, match: /team initialized worktree/ },
    { worktree: '/workspace', workerCwd: '/elsewhere/project', isolate: false, match: /worker cwd .* outside current Orca worktree/ },
    { worktree: '/workspace', workerCwd: '/workspace/project', isolate: true, workerWorktree: null, match: /isolated worker w1.*recorded worktree/ },
  ];
  for (const scenario of scenarios) {
    const home = await mkdtemp(join(tmpdir(), 'team-building-worktree-'));
    const team = 'tb-0101-000001';
    const stateRoot = join(home, '.local', 'state', 'team-building');
    const teamDir = join(stateRoot, team);
    const calls = join(home, 'orca-calls.jsonl');
    const orca = join(home, 'orca-ide');
    try {
      await mkdir(teamDir, { recursive: true });
      await writeFile(orca, `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
const args = process.argv.slice(2, -1);
appendFileSync(process.env.ORCA_TEST_CALLS, JSON.stringify(args) + '\\n');
const result = args[0] === 'status'
  ? { app: { running: true }, runtime: { reachable: true } }
  : { worktree: { path: '/workspace' } };
console.log(JSON.stringify({ ok: true, result }));
`);
      await chmod(orca, 0o755);
      await writeFile(join(teamDir, 'team.json'), JSON.stringify({
        id: team,
        cwd: scenario.workerCwd,
        worktree: scenario.worktree,
        isolate: scenario.isolate,
        model: 'openai-codex/gpt-6-sol',
        harness: 'omp',
        next_task: 1,
        next_worker: 2,
        queue: [],
        workers: {
          w1: {
            id: 'w1',
            state: 'idle',
            retiring: false,
            assignments: 0,
            harness: 'omp',
            session_id: null,
            session_file: null,
            cwd: scenario.workerCwd,
            worktree: scenario.workerWorktree,
            log: join(teamDir, 'w1.log'),
          },
        },
      }));
      const result = spawnSync(process.execPath, [main, 'assign', '--team', team, '--worker', 'w1', 'work'], {
        cwd: home,
        encoding: 'utf8',
        timeout: 10_000,
        env: {
          ...process.env,
          HOME: home,
          ORCA_CLI_COMMAND: orca,
          ORCA_TERMINAL_HANDLE: '',
          ORCA_WORKTREE_ID: '',
          ORCA_TEST_CALLS: calls,
        },
      });
      assert.equal(result.status, 4, `${result.error?.message || ''}${result.stderr}`);
      assert.match(result.stderr, scenario.match);
      assert.deepEqual(
        (await readFile(calls, 'utf8')).trim().split('\n').map(line => JSON.parse(line).slice(0, 2).join(' ')).sort(),
        ['status', 'worktree current'],
      );
      assert.equal(existsSync(join(stateRoot, 'supervisor')), false);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  }
});
test('init refuses an Orca ancestor when manager terminal has a different worktree', async () => {
  const home = await mkdtemp(join(tmpdir(), 'team-building-orca-manager-worktree-'));
  const managerWorktree = join(home, 'RGBD');
  const cwd = join(home, 'RGBD-pcd');
  const calls = join(home, 'orca-calls.jsonl');
  const orca = join(home, 'orca-ide');
  const stateRoot = join(home, '.local', 'state', 'team-building');
  try {
    await Promise.all([mkdir(managerWorktree), mkdir(cwd)]);
    await writeFile(calls, '');
    await writeFile(orca, `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
const args = process.argv.slice(2, -1);
appendFileSync(process.env.ORCA_TEST_CALLS, JSON.stringify(args) + '\\n');
const result = args[0] === 'worktree'
  ? { worktree: { path: ${JSON.stringify(home)} } }
  : args[0] === 'terminal' && args[1] === 'create'
    ? { terminal: { handle: 'unexpected-parent-tab', connected: true } }
    : { app: { running: true }, runtime: { reachable: true } };
console.log(JSON.stringify({ ok: true, result }));
`);
    await chmod(orca, 0o755);

    const result = spawnSync(process.execPath, [main, 'init', '--harness', 'claude', '--allow-bypass', '--member', '1'], {
      cwd,
      encoding: 'utf8',
      timeout: 10_000,
      env: {
        ...process.env,
        HOME: home,
        HERDR_ENV: '',
        ORCA_CLI_COMMAND: orca,
        ORCA_TERMINAL_HANDLE: 'manager-terminal',
        ORCA_TEST_CALLS: calls,
        ORCA_WORKTREE_ID: `manager-id::${managerWorktree}`,
      },
    });

    assert.equal(result.status, 4, result.stderr);
    assert.ok(result.stderr.includes(cwd), result.stderr);
    assert.ok(result.stderr.includes(managerWorktree));
    const invoked = (await readFile(calls, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
    assert.deepEqual(invoked, []);
    assert.deepEqual(await readdir(stateRoot), []);
    const missingId = spawnSync(process.execPath, [main, 'init', '--harness', 'claude', '--allow-bypass', '--member', '1'], {
      cwd,
      encoding: 'utf8',
      timeout: 10_000,
      env: {
        ...process.env,
        HOME: home,
        HERDR_ENV: '',
        ORCA_CLI_COMMAND: orca,
        ORCA_TERMINAL_HANDLE: 'manager-terminal',
        ORCA_TEST_CALLS: calls,
        ORCA_WORKTREE_ID: '',
      },
    });
    assert.equal(missingId.status, 4, missingId.stderr);
    assert.match(missingId.stderr, /no ORCA_WORKTREE_ID/);
    assert.equal((await readFile(calls, 'utf8')).trim(), '');
    assert.deepEqual(await readdir(stateRoot), []);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('init rejects an Orca folder context above the cwd git root', async () => {
  const home = await mkdtemp(join(tmpdir(), 'team-building-orca-git-root-'));
  const cwd = join(home, 'repo');
  const calls = join(home, 'orca-calls.jsonl');
  const orca = join(home, 'orca-ide');
  const stateRoot = join(home, '.local', 'state', 'team-building');
  try {
    await mkdir(cwd);
    assert.equal(spawnSync('git', ['init', '--quiet', cwd]).status, 0);
    await writeFile(calls, '');
    await writeFile(orca, `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
const args = process.argv.slice(2, -1);
appendFileSync(process.env.ORCA_TEST_CALLS, JSON.stringify(args) + '\\n');
const result = args[0] === 'worktree'
  ? { worktree: { path: ${JSON.stringify(home)} } }
  : { app: { running: true }, runtime: { reachable: true } };
console.log(JSON.stringify({ ok: true, result }));
`);
    await chmod(orca, 0o755);

    const result = spawnSync(process.execPath, [main, 'init', '--harness', 'claude', '--allow-bypass', '--member', '1'], {
      cwd,
      encoding: 'utf8',
      timeout: 10_000,
      env: {
        ...process.env,
        HOME: home,
        HERDR_ENV: '',
        ORCA_CLI_COMMAND: orca,
        ORCA_TERMINAL_HANDLE: 'manager-terminal',
        ORCA_TEST_CALLS: calls,
        ORCA_WORKTREE_ID: `manager-id::${home}`,
      },
    });

    assert.equal(result.status, 4, result.stderr);
    assert.ok(result.stderr.includes(cwd), result.stderr);
    assert.ok(result.stderr.includes(home), result.stderr);
    assert.match(result.stderr, /git top-level/);
    const invoked = (await readFile(calls, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
    assert.deepEqual(invoked, []);
    assert.deepEqual(await readdir(stateRoot), []);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('supports named teams at the same path and creates observers for new workers', async () => {
  const home = await mkdtemp(join(tmpdir(), 'team-building-paths-'));
  const root = join(home, 'worktree');
  const first = join(root, 'first');
  const bin = join(home, 'bin');
  const second = join(root, 'second');
  const stateRoot = join(home, '.local', 'state', 'team-building');
  const calls = join(home, 'orca-calls.jsonl');
  const terminals = join(home, 'orca-terminals.json');
  const orca = join(home, 'orca-ide');
  const run = (cwd, ...args) => spawnSync(process.execPath, [main, ...args], {
    cwd,
    encoding: 'utf8',
    timeout: 10_000,
    env: {
      ...process.env,
      HERDR_ENV: '',
      HOME: home,
      OMP_SESSION_ID: '',
      PI_SESSION_ID: 'pi-session-fixture',
      ORCA_CLI_COMMAND: orca,
      ORCA_TERMINAL_HANDLE: '',
      ORCA_WORKTREE_ID: '',
      ORCA_TEST_CALLS: calls,
      ORCA_TEST_TERMINALS: terminals,
      PATH: `${bin}:${process.env.PATH || ''}`,
    },
  });
  const paths = supervisorPaths(stateRoot);
  const client = new Supervisor(paths);
  let daemon;
  try {
    await mkdir(paths.stateDir, { recursive: true });
    if (!existsSync(supervisorBinary)) {
      const build = spawnSync('cargo', ['build', '--release', '--locked'], { cwd: fileURLToPath(new URL('../supervisor', import.meta.url)), encoding: 'utf8' });
      assert.equal(build.status, 0, build.stderr);
    }
    // Own this temporary daemon so cleanup can reap it before deleting its state.
    daemon = spawn(supervisorBinary, ['serve', '--state-dir', paths.stateDir, '--socket', paths.socket], { stdio: ['ignore', 'pipe', 'inherit'] });
    const readiness = createInterface({ input: daemon.stdout });
    daemon.once('error', error => readiness.emit('error', error));
    try {
      const [line] = await once(readiness, 'line', { signal: AbortSignal.timeout(5_000) });
      assert.equal(JSON.parse(line).payload?.ready, true);
    } finally {
      readiness.close();
      daemon.stdout.destroy();
    }
    await Promise.all([mkdir(bin, { recursive: true }), mkdir(first, { recursive: true }), mkdir(second, { recursive: true }), mkdir(join(root, 'missing'), { recursive: true })]);
    await writeFile(orca, `#!/usr/bin/env node
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
const args = process.argv.slice(2, -1);
appendFileSync(process.env.ORCA_TEST_CALLS, JSON.stringify(args) + '\\n');
const state = process.env.ORCA_TEST_TERMINALS;
const terminals = existsSync(state) ? JSON.parse(readFileSync(state, 'utf8')) : [];
let result;
if (args[0] === 'worktree') result = { worktree: { path: ${JSON.stringify(root)} } };
else if (args[0] === 'terminal' && args[1] === 'list') result = { terminals };
else if (args[0] === 'terminal' && args[1] === 'create') {
  const terminal = { handle: 'observer-' + process.pid + '-' + Date.now(), connected: true, orphaned: false };
  terminals.push(terminal);
  writeFileSync(state, JSON.stringify(terminals));
  result = { terminal };
} else result = { app: { running: true }, runtime: { reachable: true } };
console.log(JSON.stringify({ ok: true, result }));
`);
    const claude = join(bin, 'claude');
    await writeFile(claude, `#!/usr/bin/env node
import { createInterface } from 'node:readline';
const input = createInterface({ input: process.stdin });
input.once('line', line => {
  const request = JSON.parse(line);
  console.log(JSON.stringify({ type: 'user', uuid: request.uuid }));
  console.log(JSON.stringify({
    type: 'result',
    subtype: 'success',
    session_id: 'fixture-session',
    structured_output: {
      status: 'succeeded',
      summary: process.env.TEAM_BUILDING_WORKER,
      verification: 'fixture',
      tool_sessions: [],
    },
  }));
});
`);
    await Promise.all([chmod(orca, 0o755), chmod(claude, 0o755)]);
    const teamIds = async () => (await readdir(stateRoot)).filter(team => /^tb-/.test(team)).sort();
    const created = run(first, 'init', '--name', 'team1', '--harness', 'claude', '--allow-bypass', '--member', '1');
    assert.equal(created.status, 0, created.stderr);
    const [firstTeam] = await teamIds();
    const firstData = JSON.parse(await readFile(join(stateRoot, firstTeam, 'team.json'), 'utf8'));
    assert.equal(firstData.cwd, first);
    assert.equal(firstData.name, 'team1');
    assert.equal(firstData.manager_session, 'pi-session-fixture');
    for (const name of ['Team 1', 'tb-0101-000000']) {
      const invalidName = run(first, 'init', '--name', name, '--harness', 'claude', '--allow-bypass');
      assert.equal(invalidName.status, 2);
      assert.match(invalidName.stderr, /--name must/);
    }
    assert.deepEqual(await teamIds(), [firstTeam]);

    const adopted = run(first, 'init', '--name', 'team1', '--harness', 'claude', '--allow-bypass');
    assert.equal(adopted.status, 0, adopted.stderr);
    assert.deepEqual(await teamIds(), [firstTeam]);
    const firstPath = join(stateRoot, firstTeam, 'team.json');
    const originalWorker = JSON.parse(await readFile(firstPath, 'utf8')).workers.w1;
    const sameSize = run(first, 'member', '1', '--allow-bypass', '--team', 'team1');
    assert.equal(sameSize.status, 0, sameSize.stderr);
    assert.equal(JSON.parse(await readFile(firstPath, 'utf8')).workers.w1.observer, originalWorker.observer);
    await writeFile(terminals, '[]');
    const reopened = run(first, 'member', '1', '--allow-bypass', '--team', 'team1');
    assert.equal(reopened.status, 0, reopened.stderr);
    assert.match(reopened.stderr, /warning:.*w1.*observer.*recreat/i);
    const repairedWorker = JSON.parse(await readFile(firstPath, 'utf8')).workers.w1;
    assert.notEqual(repairedWorker.observer, originalWorker.observer);
    const originalWithoutIdle = { ...originalWorker };
    const repairedWithoutIdle = { ...repairedWorker, observer: originalWorker.observer };
    delete originalWithoutIdle.idle_since_ms;
    delete repairedWithoutIdle.idle_since_ms;
    assert.deepEqual(repairedWithoutIdle, originalWithoutIdle);
    assert.ok(repairedWorker.idle_since_ms >= originalWorker.idle_since_ms);
    await writeFile(terminals, '[]');
    const readopted = run(first, 'init', '--team', 'team1', '--harness', 'claude', '--allow-bypass');
    assert.equal(readopted.status, 0, readopted.stderr);
    assert.notEqual(JSON.parse(await readFile(firstPath, 'utf8')).workers.w1.observer, repairedWorker.observer);

    const createdSecond = run(first, 'init', '--name', 'team2', '--harness', 'claude', '--allow-bypass', '--member', '1');
    assert.equal(createdSecond.status, 0, createdSecond.stderr);
    const samePathTeams = await teamIds();
    assert.equal(samePathTeams.length, 2);
    const secondTeam = samePathTeams.find(team => team !== firstTeam);
    const secondData = JSON.parse(await readFile(join(stateRoot, secondTeam, 'team.json'), 'utf8'));
    assert.equal(secondData.name, 'team2');
    assert.equal(secondData.cwd, first);
    const adoptedSecond = run(first, 'init', '--name', 'team2', '--harness', 'claude', '--allow-bypass');
    assert.equal(adoptedSecond.status, 0, adoptedSecond.stderr);
    assert.deepEqual(await teamIds(), samePathTeams);

    const selectedStatus = run(first, 'status', '--team', 'team2');
    assert.equal(selectedStatus.status, 0, selectedStatus.stderr);
    assert.ok(selectedStatus.stdout.includes(`team team2 (${secondTeam})`));
    const ambiguous = run(first, 'status');
    assert.equal(ambiguous.status, 2);
    assert.match(ambiguous.stderr, /multiple teams.*--team <id\|name>.*team1.*team2/);
    const resized = run(first, 'member', '2', '--allow-bypass', '--team', 'team2');
    assert.equal(resized.status, 0, resized.stderr);
    assert.equal(Object.keys(JSON.parse(await readFile(join(stateRoot, secondTeam, 'team.json'), 'utf8')).workers).length, 2);

    for (const [name, id] of [['team1', firstTeam], ['team2', secondTeam]]) {
      const assigned = run(first, 'assign', '--team', name, '--worker', 'w1', `verify ${name} selection`);
      assert.equal(assigned.status, 0, assigned.stderr);
      const result = JSON.parse(assigned.stdout.slice(assigned.stdout.indexOf('\n') + 1));
      assert.equal(result.team, id);
      assert.equal(result.summary, `${id}/w1`);
    }

    const refused = run(second, 'init', '--harness', 'claude', '--allow-bypass');
    assert.equal(refused.status, 3);
    assert.match(refused.stderr, new RegExp(`${firstTeam}.*${first}`));
    assert.match(refused.stderr, /--clear-previous.*--keep-previous/);
    const duplicateName = run(second, 'init', '--name', 'team1', '--harness', 'claude', '--allow-bypass');
    assert.equal(duplicateName.status, 2);
    assert.match(duplicateName.stderr, /team name "team1" is already used/);
    assert.equal((await teamIds()).length, 2);

    const kept = run(second, 'init', '--harness', 'claude', '--allow-bypass', '--keep-previous', '--member', '1');
    assert.equal(kept.status, 0, kept.stderr);
    const teams = await teamIds();
    assert.equal(teams.length, 3);
    const secondPathTeam = teams.find(team => team !== firstTeam && team !== secondTeam);
    assert.ok(secondPathTeam);
    assert.equal(JSON.parse(await readFile(join(stateRoot, secondPathTeam, 'team.json'), 'utf8')).cwd, second);

    const selected = run(second, 'member', '2', '--allow-bypass');
    assert.equal(selected.status, 0, selected.stderr);
    assert.equal(Object.keys(JSON.parse(await readFile(join(stateRoot, secondPathTeam, 'team.json'), 'utf8')).workers).length, 2);

    const missing = run(join(root, 'missing'), 'status');
    assert.equal(missing.status, 2);
    assert.match(missing.stderr, /run `team-building init` or pass --team <id\|name>/);
    assert.match(await readFile(calls, 'utf8'), /"terminal","create"/);
  } finally {
    try {
      if (daemon?.pid && daemon.exitCode === null && daemon.signalCode === null) {
        const exited = once(daemon, 'exit');
        await client.request('shutdown', {}, undefined, 1_000).catch(() => daemon.kill('SIGTERM'));
        try {
          await Promise.race([
            exited,
            delay(5_000, null, { ref: false }).then(() => { throw new Error('temporary supervisor did not exit'); }),
          ]);
        } catch (error) {
          daemon.kill('SIGKILL');
          await exited;
          throw error;
        }
      }
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  }
});

test('assign on an orca-created team dies with a backend mismatch when run from a herdr pane', async () => {
  const home = await mkdtemp(join(tmpdir(), 'team-building-herdr-'));
  const team = 'tb-0101-000002';
  const stateRoot = join(home, '.local', 'state', 'team-building');
  const teamDir = join(stateRoot, team);
  const herdrBin = join(home, 'herdr');
  try {
    await mkdir(teamDir, { recursive: true });
    await writeFile(herdrBin, `#!/usr/bin/env node
console.log(JSON.stringify({ id: '1', result: { pane: { pane_id: 'p1', tab_id: 't1', workspace_id: 'ws1', cwd: '/workspace' } } }));
`);
    await chmod(herdrBin, 0o755);
    await writeFile(join(teamDir, 'team.json'), JSON.stringify({
      id: team,
      cwd: '/workspace/project',
      worktree: '/workspace',
      isolate: false,
      model: 'openai-codex/gpt-6-sol',
      harness: 'omp',
      next_task: 1,
      next_worker: 2,
      queue: [],
      workers: {
        w1: {
          id: 'w1',
          state: 'idle',
          retiring: false,
          assignments: 0,
          harness: 'omp',
          session_id: null,
          session_file: null,
          cwd: '/workspace/project',
          worktree: null,
          log: join(teamDir, 'w1.log'),
        },
      },
    }));
    const result = spawnSync(process.execPath, [main, 'assign', '--team', team, '--worker', 'w1', 'work'], {
      cwd: home,
      encoding: 'utf8',
      timeout: 10_000,
      env: { ...process.env, HOME: home, HERDR_ENV: '1', HERDR_CLI_COMMAND: herdrBin, HERDR_WORKSPACE_ID: 'ws1' },
    });
    assert.equal(result.status, 4, `${result.error?.message || ''}${result.stderr}`);
    assert.match(result.stderr, /created under orca.*run it from Orca/);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('init and member route herdr-app workers to hc child terminals', async () => {
  const home = await mkdtemp(join(tmpdir(), 'team-building-herdr-app-'));
  const cwd = join(home, 'project');
  const calls = join(home, 'hc-calls.jsonl');
  const hc = join(home, 'hc');
  const stateRoot = join(home, '.local', 'state', 'team-building');
  const socket = '/run/user/1000/herdr-core/default.sock';
  const env = {
    ...process.env,
    HOME: home,
    HERDR_ENV: '',
    HC_TERMINAL_ID: 't-manager',
    HC_TERMINAL_SOCKET: socket,
    HC_SCOPE: 'manager-scope',
    HC_SOCKET: '/ambient/other.sock',
    HC_CLI_COMMAND: hc,
    HC_TEST_CALLS: calls,
  };
  const run = (...args) => spawnSync(process.execPath, [main, ...args], {
    cwd,
    encoding: 'utf8',
    timeout: 10_000,
    env,
  });
  try {
    await mkdir(cwd, { recursive: true });
    await writeFile(calls, '');
    await writeFile(hc, `#!/usr/bin/env node
import { appendFileSync, readFileSync } from 'node:fs';
const args = process.argv.slice(2);
const log = process.env.HC_TEST_CALLS;
const history = readFileSync(log, 'utf8').trim().split('\\n').filter(Boolean).map(JSON.parse);
appendFileSync(log, JSON.stringify({ args, socket: process.env.HC_SOCKET, caller: process.env.HC_TERMINAL_ID, terminalSocket: process.env.HC_TERMINAL_SOCKET }) + '\\n');
if (args[1] === 'run') {
  const count = history.filter(call => call.args[1] === 'run').length;
  console.log(JSON.stringify({ address: 't' + (count + 1) }));
} else if (args[1] === 'get') {
  console.log(JSON.stringify({ address: args[2], state: 'live' }));
} else if (args[1] === 'server' && args[2] === 'status') {
  console.log(JSON.stringify({ core: { id: 'fixture' } }));
} else {
  console.error(JSON.stringify({ error: { kind: 'unsupported', message: 'unsupported fixture call' } }));
  process.exit(1);
}
`);
    await chmod(hc, 0o755);

    const init = run('init', '--harness', 'claude', '--allow-bypass', '--member', '1');
    assert.equal(init.status, 0, `${init.stderr}${init.stdout}`);
    const team = (await readdir(stateRoot)).find(name => name.startsWith('tb-'));
    const teamDir = join(stateRoot, team);
    let data = JSON.parse(await readFile(join(teamDir, 'team.json'), 'utf8'));
    assert.equal(data.backend, 'hc');
    assert.equal(data.socket, socket);
    assert.equal(data.workers.w1.observer, 't1');

    const member = run('member', '2', '--allow-bypass');
    assert.equal(member.status, 0, `${member.stderr}${member.stdout}`);
    data = JSON.parse(await readFile(join(teamDir, 'team.json'), 'utf8'));
    assert.equal(data.workers.w2.observer, 't2');

    const logged = (await readFile(calls, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    const created = logged.filter(call => call.args[1] === 'run');
    assert.equal(created.length, 2);
    for (const [index, call] of created.entries()) {
      assert.equal(call.socket, socket);
      assert.equal(call.caller, 't-manager');
      assert.equal(call.terminalSocket, socket);
      assert.deepEqual(call.args.slice(0, 3), ['--json', 'run', '--bg']);
      assert.equal(call.args[call.args.indexOf('--cwd') + 1], cwd);
      assert.ok(call.args.includes(`team=${team}`));
      assert.ok(call.args.includes(`worker=w${index + 1}`));
      assert.equal(call.args.at(-2), 'sh');
    }

    const isolatedCwd = join(home, 'isolated');
    await mkdir(isolatedCwd);
    const isolated = spawnSync(process.execPath, [main, 'init', '--harness', 'claude', '--allow-bypass', '--member', '1', '--isolate'], {
      cwd: isolatedCwd,
      encoding: 'utf8',
      timeout: 10_000,
      env,
    });
    assert.equal(isolated.status, 2, isolated.stderr);
    assert.match(isolated.stderr, /herdr-app \(hc\) does not support --isolate/);
    assert.equal((await readdir(stateRoot)).filter(name => name.startsWith('tb-')).length, 1);

    const wrongBackend = spawnSync(process.execPath, [main, 'assign', '--team', team, '--worker', 'w1', 'work'], {
      cwd,
      encoding: 'utf8',
      timeout: 10_000,
      env: { ...env, HC_TERMINAL_ID: '', HC_TERMINAL_SOCKET: '', HC_SCOPE: '', HC_SOCKET: '' },
    });
    assert.equal(wrongBackend.status, 4, wrongBackend.stderr);
    assert.match(wrongBackend.stderr, /created under hc; run it from a herdr-app terminal/);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
