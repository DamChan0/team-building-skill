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

  const approval = parseArgs(['approve', '--worker', 'w2', '--task', 't001', '--', 'git', 'push', 'origin', 'main']);
  assert.deepEqual(approval.command, ['git', 'push', 'origin', 'main']);
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

test('keeps one team per path and creates observers for new workers', async () => {
  const home = await mkdtemp(join(tmpdir(), 'team-building-paths-'));
  const root = join(home, 'worktree');
  const first = join(root, 'first');
  const second = join(root, 'second');
  const stateRoot = join(home, '.local', 'state', 'team-building');
  const calls = join(home, 'orca-calls.jsonl');
  const terminals = join(home, 'orca-terminals.json');
  const orca = join(home, 'orca-ide');
  const run = (cwd, ...args) => spawnSync(process.execPath, [main, ...args], {
    cwd,
    encoding: 'utf8',
    timeout: 10_000,
    env: { ...process.env, HERDR_ENV: '', HOME: home, ORCA_CLI_COMMAND: orca, ORCA_TEST_CALLS: calls, ORCA_TEST_TERMINALS: terminals },
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
    await mkdir(first, { recursive: true });
    await mkdir(second, { recursive: true });
    await mkdir(join(root, 'missing'));
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
  const terminal = { handle: 'observer-' + Date.now(), connected: true, orphaned: false };
  terminals.push(terminal);
  writeFileSync(state, JSON.stringify(terminals));
  result = { terminal };
} else result = { app: { running: true }, runtime: { reachable: true } };
console.log(JSON.stringify({ ok: true, result }));
`);
    await chmod(orca, 0o755);
    const teamIds = async () => (await readdir(stateRoot)).filter(team => /^tb-/.test(team));


    const created = run(first, 'init', '--harness', 'claude', '--allow-bypass', '--member', '1');
    assert.equal(created.status, 0, created.stderr);
    const [firstTeam] = await teamIds();
    assert.equal(JSON.parse(await readFile(join(stateRoot, firstTeam, 'team.json'), 'utf8')).cwd, first);

    const adopted = run(first, 'init', '--harness', 'claude', '--allow-bypass');
    assert.equal(adopted.status, 0, adopted.stderr);
    assert.deepEqual(await teamIds(), [firstTeam]);
    const firstPath = join(stateRoot, firstTeam, 'team.json');
    const originalWorker = JSON.parse(await readFile(firstPath, 'utf8')).workers.w1;
    const sameSize = run(first, 'member', '1', '--allow-bypass');
    assert.equal(sameSize.status, 0, sameSize.stderr);
    assert.equal(JSON.parse(await readFile(firstPath, 'utf8')).workers.w1.observer, originalWorker.observer);
    await writeFile(terminals, '[]');
    const reopened = run(first, 'member', '1', '--allow-bypass');
    assert.equal(reopened.status, 0, reopened.stderr);
    assert.match(reopened.stderr, /warning:.*w1.*observer.*recreat/i);
    const repairedWorker = JSON.parse(await readFile(firstPath, 'utf8')).workers.w1;
    assert.notEqual(repairedWorker.observer, originalWorker.observer);
    assert.deepEqual({ ...repairedWorker, observer: originalWorker.observer }, originalWorker);
    await writeFile(terminals, '[]');
    const readopted = run(first, 'init', '--harness', 'claude', '--allow-bypass');
    assert.equal(readopted.status, 0, readopted.stderr);
    assert.notEqual(JSON.parse(await readFile(firstPath, 'utf8')).workers.w1.observer, repairedWorker.observer);

    const refused = run(second, 'init', '--harness', 'claude', '--allow-bypass');
    assert.equal(refused.status, 3);
    assert.match(refused.stderr, new RegExp(`${firstTeam}.*${first}`));
    assert.match(refused.stderr, /--clear-previous.*--keep-previous/);
    assert.deepEqual(await teamIds(), [firstTeam]);

    const kept = run(second, 'init', '--harness', 'claude', '--allow-bypass', '--keep-previous', '--member', '1');
    assert.equal(kept.status, 0, kept.stderr);
    const teams = await teamIds();
    assert.equal(teams.length, 2);
    const secondTeam = teams.find(team => team !== firstTeam);
    assert.equal(JSON.parse(await readFile(join(stateRoot, secondTeam, 'team.json'), 'utf8')).cwd, second);

    const selected = run(second, 'member', '2', '--allow-bypass');
    assert.equal(selected.status, 0, selected.stderr);
    assert.equal(Object.keys(JSON.parse(await readFile(join(stateRoot, secondTeam, 'team.json'), 'utf8')).workers).length, 2);

    const missing = run(join(root, 'missing'), 'status');
    assert.equal(missing.status, 2);
    assert.match(missing.stderr, /run `team-building init` or pass --team <id>/);
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
