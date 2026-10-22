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
import { chooseWorker, parseArgs, routedAssignment } from '../src/main.mjs';
import { Supervisor, supervisorBinary, supervisorPaths } from '../src/supervisor.mjs';

const main = fileURLToPath(new URL('../src/main.mjs', import.meta.url));
const router = { enabled: true, models: { simple: { model: 'openai-codex/gpt-5.6-luna', thinking: 'max' } } };

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
        env: { ...process.env, HOME: home, ORCA_CLI_COMMAND: orca, ORCA_TEST_CALLS: calls },
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
    env: { ...process.env, HERDR_ENV: '', HOME: home, OMP_SESSION_ID: '', PI_SESSION_ID: 'pi-session-fixture', ORCA_CLI_COMMAND: orca, ORCA_TEST_CALLS: calls, ORCA_TEST_TERMINALS: terminals, PATH: `${bin}:${process.env.PATH || ''}` },
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
    assert.deepEqual({ ...repairedWorker, observer: originalWorker.observer }, originalWorker);
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
