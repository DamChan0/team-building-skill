import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { chooseWorker, parseArgs, routedAssignment } from '../src/main.mjs';

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
        (await readFile(calls, 'utf8')).trim().split('\n').map(line => JSON.parse(line).slice(0, 2).join(' ')),
        ['status', 'worktree current'],
      );
      assert.equal(existsSync(join(stateRoot, 'supervisor')), false);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  }
});
