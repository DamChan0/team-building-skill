import { spawnSync } from 'node:child_process';
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chooseWorker, parseArgs, requiresBypass, resultFrom, routedAssignment, runAssignment, show } from '../src/main.mjs';

const router = {
  enabled: true,
  family: 'gpt',
  models: {
    simple: { model: 'openai-codex/gpt-5.6-luna', thinking: 'max' },
    moderate: { model: 'openai-codex/gpt-5.6-terra', thinking: null },
    complex: { model: 'openai-codex/gpt-5.6-sol', thinking: null },
    extreme: { model: 'openai-codex/gpt-6-astra', thinking: null },
  },
};

test('parses common options before the command and approval command after --', () => {
  const parsed = parseArgs([
    '--team', 'tb-1001-120000',
    '--timeout', '30',
    'approve',
    '--worker', 'w2',
    '--task', 't003',
    '--', 'git', 'push', 'origin', 'main',
  ]);

  assert.deepEqual(parsed, {
    team: 'tb-1001-120000',
    timeout: 30,
    max: 14400,
    cmd: 'approve',
    worker: 'w2',
    task: 't003',
    command: ['git', 'push', 'origin', 'main'],
  });
});

test('preserves a dash assignment prompt so assign reads stdin', () => {
  const parsed = parseArgs(['assign', '-']);

  assert.equal(parsed.prompt, '-');
});

test('parses supported routing tiers and routes saved maps with manual precedence', () => {
  const omp = { id: 'w1', harness: 'omp', state: 'idle', retiring: false };
  const mixed = {
    model: null,
    harness: 'omp',
    router,
    workers: {
      w1: omp,
      w2: { id: 'w2', harness: 'claude', state: 'idle', retiring: false },
    },
  };

  assert.equal(parseArgs(['assign', '--difficulty', 'complex', 'work']).difficulty, 'complex');
  assert.throws(() => parseArgs(['assign', '--difficulty', 'hard', 'work']), /__team_die__/);
  assert.deepEqual(routedAssignment({ ...mixed, model: 'fixed' }, { difficulty: 'simple', model: 'manual' }), { model: 'manual' });
  assert.deepEqual(
    routedAssignment(mixed, { worker: 'w1', difficulty: 'simple' }),
    { ...router.models.simple, difficulty: 'simple' },
  );
  assert.throws(
    () => routedAssignment({ ...mixed, model: 'fixed' }, { difficulty: 'simple' }),
    /__team_die__/,
  );
  assert.throws(
    () => routedAssignment(mixed, { worker: 'w2', difficulty: 'simple' }),
    /__team_die__/,
  );
  assert.deepEqual(
    chooseWorker({ ...mixed, queue: [{ task: 't003', worker: null, kind: 'task', difficulty: 'simple' }] }, 't003', 'task'),
    ['fail', '--difficulty requires an explicitly selected OMP worker or a team whose eligible workers are all OMP'],
  );
  assert.deepEqual(
    chooseWorker({ ...mixed, queue: [{ task: 't004', worker: 'w1', kind: 'task', difficulty: 'simple' }] }, 't004', 'task'),
    ['take', 'w1'],
  );
  process.exitCode = undefined;
});


test('guards shared and isolated worktree targets before terminal lifecycle changes', async () => {
  const home = await mkdtemp(join(tmpdir(), 'team-building-worktree-'));
  const team = 'tb-1001-120000';
  const teamDir = join(home, '.local', 'state', 'team-building', team);
  const log = join(home, 'orca.log');
  const fakeOrca = join(home, 'orca-ide');
  const run = () => spawnSync(process.execPath, [join(process.cwd(), 'src', 'main.mjs'), 'assign', '--team', team, '--worker', 'w1', '--difficulty', 'simple', 'work'], {
    cwd: teamDir,
    encoding: 'utf8',
    env: { ...process.env, HOME: home, ORCA_CLI_COMMAND: fakeOrca, FAKE_ORCA_LOG: log, FAKE_RESULTS: join(teamDir, 'results'), FAKE_ACTIVE: '/workspace' },
  });
  const events = async () => (await readFile(log, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
  const state = ({ cwd, worktree, isolate = false, workerWorktree = null, terminal = null }) => ({
    id: team, cwd, ...(worktree ? { worktree } : {}), isolate, model: null, harness: 'omp', router,
    next_task: 1, next_worker: 2, workers: {
      w1: {
        id: 'w1', model: null, resolved_model: null, state: 'idle', task: null, retiring: false,
        assignments: 0, session_dir: join(teamDir, 'sessions', 'w1'), log: join(teamDir, 'logs', 'w1.log'),
        harness: 'omp', session_id: null, session_file: null, cwd, worktree: workerWorktree,
        ...(terminal ? { terminal, terminal_model: 'old-model', terminal_thinking: null } : {}),
      },
    }, queue: [],
  });
  try {
    await Promise.all(['logs', 'results', 'approvals', 'sessions/w1'].map(name => mkdir(join(teamDir, name), { recursive: true })));
    await writeFile(fakeOrca, `#!/usr/bin/env node
import { appendFile, writeFile } from 'node:fs/promises';
const args = process.argv.slice(2, -1), log = process.env.FAKE_ORCA_LOG;
if (args[0] === 'worktree' && args[1] === 'current') {
  console.log(JSON.stringify({ ok: true, result: { worktree: { path: process.env.FAKE_ACTIVE } } }));
} else if (args[0] === 'terminal' && (args[1] === 'create' || args[1] === 'close')) {
  await appendFile(log, JSON.stringify({ type: args[1], args }) + '\\n');
  console.log(JSON.stringify({ ok: true, result: { terminal: { handle: 'h1' } } }));
} else if (args[0] === 'terminal' && args[1] === 'show') {
  console.log(JSON.stringify({ ok: true, result: { terminal: { connected: true, exited: false } } }));
} else if (args[0] === 'terminal' && args[1] === 'send') {
  const task = args[args.indexOf('--text') + 1].match(/Assignment (t\\d+)/)[1];
  await writeFile(process.env.FAKE_RESULTS + '/' + task + '.json', JSON.stringify({ status: 'succeeded', summary: 'done' }));
  console.log(JSON.stringify({ ok: true, result: {} }));
} else if (args[0] === 'status') {
  console.log(JSON.stringify({ ok: true, result: { app: { running: true }, runtime: { reachable: true } } }));
} else {
  console.log(JSON.stringify({ ok: true, result: {} }));
}`);
    await chmod(fakeOrca, 0o755);

    await writeFile(join(teamDir, 'team.json'), JSON.stringify(state({ cwd: '/workspace/project' })));
    assert.equal(run().status, 0);
    assert.equal(JSON.parse(await readFile(join(teamDir, 'team.json'), 'utf8')).worktree, '/workspace');
    assert.ok((await events()).some(event => event.type === 'create' && event.args.includes('path:/workspace')));
    assert.ok(!(await events()).some(event => event.type === 'create' && event.args.includes('path:/workspace/project')));
    await writeFile(log, '');
    await writeFile(join(teamDir, 'team.json'), JSON.stringify(state({ cwd: '/workspace/..project' })));
    const dotPrefixedCwd = run();
    assert.equal(dotPrefixedCwd.status, 0);
    assert.equal(JSON.parse(await readFile(join(teamDir, 'team.json'), 'utf8')).worktree, '/workspace');
    assert.ok((await events()).some(event => event.type === 'create' && event.args.includes('path:/workspace')));

    await writeFile(log, '');

    await writeFile(join(teamDir, 'team.json'), JSON.stringify(state({ cwd: '/elsewhere/project', terminal: 'h1' })));
    const outside = run();
    assert.equal(outside.status, 0);
    assert.match(outside.stdout, /worktree/i);
    assert.deepEqual(await events(), []);

    await writeFile(join(teamDir, 'team.json'), JSON.stringify(state({ cwd: '/workspace/project', worktree: '/other-worktree', terminal: 'h1' })));
    const mismatch = run();
    assert.equal(mismatch.status, 0);
    assert.match(mismatch.stdout, /initialized worktree|initialize a new team/i);
    assert.deepEqual(await events(), []);
    await writeFile(join(teamDir, 'team.json'), JSON.stringify(state({ cwd: '/elsewhere/project', worktree: '/workspace', terminal: 'h1' })));
    const cwdMismatch = run();
    assert.equal(cwdMismatch.status, 0);
    assert.match(cwdMismatch.stdout, /worker cwd .* outside current Orca worktree/i);
    assert.deepEqual(await events(), []);

    await writeFile(join(teamDir, 'team.json'), JSON.stringify(state({ cwd: '/workspace/project', worktree: '/workspace', isolate: true, terminal: 'h1' })));
    const isolated = run();
    assert.equal(isolated.status, 0);
    assert.match(isolated.stdout, /isolated worker w1.*worktree/i);
    assert.deepEqual(await events(), []);
    await writeFile(join(teamDir, 'team.json'), JSON.stringify(state({
      cwd: '/workspace/project', worktree: '/workspace', isolate: true, workerWorktree: '/isolated/w1',
    })));
    const isolatedTarget = run();
    assert.equal(isolatedTarget.status, 0);
    const isolatedEvents = await events();
    assert.ok(isolatedEvents.some(event => event.type === 'create' && event.args.includes('path:/isolated/w1')));
    assert.ok(!isolatedEvents.some(event => event.type === 'create' && event.args.includes('path:/workspace')));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('rejects shared init outside the active Orca worktree before creating a team', async () => {
  const home = await mkdtemp(join(tmpdir(), 'team-building-init-worktree-'));
  const manager = join(home, 'manager');
  const fakeOrca = join(home, 'orca-ide');
  try {
    await mkdir(manager);
    await writeFile(fakeOrca, `#!/usr/bin/env node
const args = process.argv.slice(2, -1);
console.log(JSON.stringify(args[0] === 'worktree' && args[1] === 'current'
  ? { ok: true, result: { worktree: { path: '/workspace' } } }
  : { ok: true, result: {} }));
`);
    await chmod(fakeOrca, 0o755);

    const run = spawnSync(process.execPath, [join(process.cwd(), 'src', 'main.mjs'), 'init', '--harness', 'claude', '--allow-bypass', '--member', '1'], {
      cwd: manager,
      encoding: 'utf8',
      env: { ...process.env, HOME: home, ORCA_CLI_COMMAND: fakeOrca },
    });

    assert.equal(run.status, 4);
    assert.match(run.stderr, /outside active Orca worktree/);
    assert.deepEqual(await readdir(join(home, '.local', 'state', 'team-building')), []);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('requires explicit bypass only for non-OMP worker harnesses', () => {
  assert.equal(requiresBypass('omp'), false);
  assert.equal(requiresBypass('claude'), true);
  assert.equal(requiresBypass('codex'), true);
});

test('parses a fenced nested result after unmatched worker prose', () => {
  const result = resultFrom('worker note: unfinished { detail\n```json\n{"status":"blocked","summary":"approval needed","approval_requests":[{"command":["git","push"],"reason":"publish"}]}\n```');

  assert.deepEqual(result.approval_requests, [{ command: ['git', 'push'], reason: 'publish' }]);
});

test('keeps an explicit queued worker ahead of unassigned work and rejects retired workers', () => {
  const data = {
    queue: [
      { task: 't001', worker: null, kind: 'task' },
      { task: 't002', worker: 'w2', kind: 'task' },
    ],
    workers: {
      w1: { id: 'w1', state: 'idle', retiring: false, assignments: 0 },
      w2: { id: 'w2', state: 'idle', retiring: false, assignments: 0 },
    },
  };

  assert.deepEqual(chooseWorker(data, 't002', 'task'), ['take', 'w2']);
  data.workers.w2.retiring = true;
  assert.deepEqual(chooseWorker(data, 't002', 'task'), ['fail', 'worker w2 is being retired']);
});

test('releases a failed queued assignment instead of leaving team state busy', async () => {
  const teamDir = await mkdtemp(join(tmpdir(), 'team-building-main-'));
  try {
    await Promise.all(['approvals', 'briefs', 'logs', 'results', 'sessions'].map(name => mkdir(join(teamDir, name))));
    await writeFile(join(teamDir, 'team.json'), JSON.stringify({
      id: 'tb-1001-120000',
      cwd: teamDir,
      worktree: teamDir,
      model: null,
      harness: 'omp',
      next_task: 1,
      next_worker: 1,
      workers: {},
      queue: [],
    }));

    const result = await runAssignment(teamDir, undefined, 'work', 1, 1);
    const data = JSON.parse(await readFile(join(teamDir, 'team.json'), 'utf8'));

    assert.equal(result.status, 'failed');
    assert.match(result.summary, /no active workers left/);
    assert.deepEqual(data.queue, []);
    assert.deepEqual(data.workers, {});
  } finally {
    await rm(teamDir, { recursive: true, force: true });
  }
});

test('status output includes queued assignments', async () => {
  const teamDir = await mkdtemp(join(tmpdir(), 'team-building-status-'));
  const output = [];
  const originalLog = console.log;
  try {
    await writeFile(join(teamDir, 'team.json'), JSON.stringify({
      id: 'tb-1001-120000',
      cwd: teamDir,
      model: null,
      router,
      workers: {
        w1: {
          id: 'w1', state: 'idle', retiring: false, model: null, assignments: 0, log: 'w1.log',
          task: 't004', task_prompt: 'route', task_difficulty: 'simple',
          task_model: 'openai-codex/gpt-5.6-luna', task_thinking: 'max',
        },
      },
      queue: [{ task: 't003', worker: 'w2', kind: 'task', prompt: 'review', pid: process.pid }],
    }));
    console.log = line => output.push(line);

    await show(teamDir);

    assert.ok(output.some(line => line.includes('difficulty=simple model=openai-codex/gpt-5.6-luna thinking=max')));
    assert.ok(output.some(line => line.includes('router=gpt')));
    assert.ok(output.some(line => line.includes('queued t003 worker=w2 kind=task')));
  } finally {
    console.log = originalLog;
    await rm(teamDir, { recursive: true, force: true });
  }
});
