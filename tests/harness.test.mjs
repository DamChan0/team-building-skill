import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { isDockerPush, isGitPush, nativeTask, ompTabCommand, writeShims } from '../src/harness.mjs';

test('gates publish commands only', () => {
  assert.equal(isGitPush(['push', 'origin', 'main']), true);
  assert.equal(isGitPush(['status']), false);
  assert.equal(isDockerPush(['image', 'push', 'registry/image']), true);
  assert.equal(isDockerPush(['build', '.']), false);
});

test('OMP workers launch as interactive tabs; native launches pin only exact Claude session IDs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'team-building-native-'));
  const previousPath = process.env.PATH;
  try {
    const bin = join(root, 'bin');
    await mkdir(bin);
    await writeFile(join(bin, 'omp'), '#!/bin/sh\nprintf "low\\n"\n');
    await chmod(join(bin, 'omp'), 0o755);
    process.env.PATH = `${bin}:${previousPath || ''}`;
    const worker = { id: 'w1', harness: 'omp', session_dir: join(root, "sessions 'w1'"), session_file: join(root, 'w1.jsonl'), model: 'openai-codex/gpt-6-luna' };
    const omp = await nativeTask('team', { ...worker, session_file: null }, { prompt: 'smoke', teamDir: root, cwd: root });
    // The tab session is the worker: no headless argv, only the thinking level the broker records.
    assert.deepEqual(omp.argv, []);
    assert.equal(omp.thinking, 'low');

    const launch = ompTabCommand('team', worker, { teamDir: root, cwd: root });
    const printed = spawnSync('/bin/sh', ['-c', launch.replace(/exec [\s\S]*$/, 'printf "%s|%s|%s" "$PWD" "$TEAM_BUILDING_WORKER" "$TEAM_BUILDING_TAB_DIR"')], { encoding: 'utf8' });
    assert.equal(printed.stdout, `${root}|team/w1|${join(root, 'tabs', 'w1')}`);
    const exec = launch.slice(launch.indexOf('exec '));
    assert.ok(!exec.includes("'--mode'") && !exec.includes("'--no-ui'"), 'the tab must run the interactive TUI');
    assert.ok(exec.includes(`'--resume' '${join(root, 'w1.jsonl')}'`) && exec.includes(`'--model' 'openai-codex/gpt-6-luna'`));
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    await rm(root, { recursive: true, force: true });
  }

  const pinned = '123e4567-e89b-42d3-a456-426614174000';
  const claude = worker => nativeTask('team', {
    id: 'w1', harness: 'claude', allow_bypass: false,
    task_model: 'anthropic/claude-sonnet-5-5', task_thinking: 'high',
    ...worker,
  }, { prompt: 'smoke', teamDir: '/tmp', cwd: '/tmp' });
  const fresh = await claude({ session_id: null });
  const freshIndex = fresh.argv.indexOf('--session-id');
  assert.notEqual(freshIndex, -1);
  assert.match(fresh.argv[freshIndex + 1], /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  assert.equal(fresh.argv.includes('--resume'), false);
  const resumed = await claude({ session_id: pinned });
  const resumeIndex = resumed.argv.indexOf('--resume');
  assert.deepEqual(resumed.argv.slice(resumeIndex, resumeIndex + 2), ['--resume', pinned]);
});


test('a worker can run a gated command only through its bound approval', async () => {
  const home = await mkdtemp(join(tmpdir(), 'team-building-approval-'));
  const team = 'approval-team';
  const root = join(home, '.local', 'state', 'team-building', team);
  const bin = join(home, 'bin');
  const marker = join(home, 'ran');
  try {
    await mkdir(join(root, 'approvals'), { recursive: true });
    await mkdir(bin);
    await writeFile(join(bin, 'git'), '#!/bin/sh\necho ran >> \"$MARKER\"\n');
    await chmod(join(bin, 'git'), 0o755);
    await writeFile(join(root, 'team.json'), JSON.stringify({ workers: { w1: { task: 't001' } } }));
    await writeShims(root, {});
    const env = { ...process.env, HOME: home, MARKER: marker, TEAM_BUILDING_WORKER: `${team}/w1`, TEAM_BUILDING_APPROVAL_TASK: '', PATH: `${join(root, 'shim')}:${bin}:${process.env.PATH}` };
    assert.equal(spawnSync(join(root, 'shim', 'git'), ['push'], { env }).status, 126);
    await writeFile(join(root, 'approvals', 't001.json'), JSON.stringify({ worker: 'w1', task: 't001', commands: [['git', 'push']] }));
    env.TEAM_BUILDING_APPROVAL_TASK = 't001';
    assert.equal(spawnSync(join(root, 'shim', 'git'), ['push'], { env }).status, 0);
    assert.equal(await readFile(marker, 'utf8'), 'ran\n');
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
