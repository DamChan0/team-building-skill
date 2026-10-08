import { spawnSync } from 'node:child_process';
import { chmod, mkdtemp, mkdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { agentCommand, cleanupWorker, configFor, isDockerPush, isGitPush, recordSession, shellQuote, writeShims } from '../src/harness.mjs';

test('gates docker push variants only', () => {
  assert.equal(isDockerPush(['push', 'registry/image']), true);
  assert.equal(isDockerPush(['image', 'push', 'registry/image']), true);
  assert.equal(isDockerPush(['image', 'ls']), false);
  assert.equal(isDockerPush(['--context', 'prod', 'image', 'push', 'image']), true);
});

test('recognizes git push after options', () => {
  assert.equal(isGitPush(['-C', '/repo', 'push', 'origin', 'main']), true);
  assert.equal(isGitPush(['status']), false);
});

test('POSIX quotes untrusted terminal arguments', () => {
  const value = "a b'$(x)`";
  const result = spawnSync('/bin/sh', ['-c', `printf '%s' ${shellQuote(value)}`], { encoding: 'utf8' });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, value);
});

test('passes the full worker contract to Codex', async () => {
  const args = await agentCommand('tb-1001-000000', { id: 'w1', harness: 'codex' });
  const config = args.find(arg => arg.startsWith('developer_instructions='));
  const instructions = JSON.parse(config.slice('developer_instructions='.length));

  assert.match(instructions, /Never run team-building init\/member\/assign\/approve\/clear/);
  assert.match(instructions, /For an unapproved gated command, do not retry it/);
  assert.match(instructions, /"status":"succeeded\|failed\|blocked"/);
});

test('adds Luna thinking only to routed OMP launches', async () => {
  const args = await agentCommand('tb-1001-000000', {
    id: 'w1',
    harness: 'omp',
    session_dir: join(tmpdir(), 'team-building-luna-session'),
    task_model: 'openai-codex/gpt-5.6-luna',
    task_thinking: 'max',
  });

  assert.deepEqual(args.slice(-4), ['--model', 'openai-codex/gpt-5.6-luna', '--thinking', 'max']);
});


test('shim blocks docker image push without blocking non-push commands', async () => {
  const home = await mkdtemp(join(tmpdir(), 'team-building-home-'));
  const team = 'tb-1001-000000';
  const teamDir = join(home, '.local', 'state', 'team-building', team);
  const fakeBin = join(home, 'bin');
  const previousHome = process.env.HOME;

  try {
    process.env.HOME = home;
    await mkdir(join(teamDir, 'approvals'), { recursive: true });
    await mkdir(fakeBin, { recursive: true });
    await writeFile(join(fakeBin, 'docker'), '#!/bin/sh\nexit 0\n');
    await chmod(join(fakeBin, 'docker'), 0o755);
    await writeFile(join(teamDir, 'team.json'), JSON.stringify({ workers: { w1: { task: 't001' } } }));
    await writeFile(
      join(teamDir, 'approvals', 't001.json'),
      JSON.stringify({ worker: 'w1', commands: [['docker', 'image', 'push', 'registry/approved']] }),
    );
    await writeShims(teamDir, {});

    const runShim = args => spawnSync(join(teamDir, 'shim', 'docker'), args, {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${fakeBin}:${process.env.PATH}`,
        TEAM_BUILDING_WORKER: `${team}/w1`,
      },
    });
    assert.equal(runShim(['image', 'push', 'registry/image']).status, 126);
    assert.equal(runShim(['image', 'push', 'registry/approved']).status, 0);
    assert.equal(runShim(['--version']).status, 0);
  } finally {
    process.env.HOME = previousHome;
    await rm(home, { recursive: true, force: true });
  }
});

test('rejects unsafe extra gated command names', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'team-building-shim-'));
  const previousExtra = process.env.TEAM_BUILDING_GATED_EXTRA;

  try {
    for (const extra of ['../outside', 'run.mjs']) {
      process.env.TEAM_BUILDING_GATED_EXTRA = extra;
      await assert.rejects(writeShims(dir, {}), /safe command names/);
    }
  } finally {
    if (previousExtra === undefined) delete process.env.TEAM_BUILDING_GATED_EXTRA;
    else process.env.TEAM_BUILDING_GATED_EXTRA = previousExtra;
    await rm(dir, { recursive: true, force: true });
  }
});
test('pins a unique Codex session and refuses ambiguous same-cwd sessions', async () => {
  const home = await mkdtemp(join(tmpdir(), 'team-building-home-'));
  const teamDir = join(home, 'team');
  const codexHome = join(home, 'custom-codex');
  const sessions = join(codexHome, 'sessions', '2026', '10', '01');
  const cwd = '/work/project';
  const since = Date.parse('2026-10-01T12:00:00Z');
  const worker = { id: 'w1', harness: 'codex', session_id: null, session_file: null };
  const previousCodexHome = process.env.CODEX_HOME;
  try {
    process.env.CODEX_HOME = codexHome;
    await mkdir(teamDir, { recursive: true });
    await mkdir(sessions, { recursive: true });
    await writeFile(join(teamDir, 'team.json'), JSON.stringify({ workers: { w1: worker } }));
    const session = async (name, id, path, modified) => {
      const file = join(sessions, name);
      await writeFile(file, `${JSON.stringify({ type: 'session_meta', payload: { id, cwd: path } })}\n`);
      await utimes(file, modified / 1000, modified / 1000);
      return file;
    };
    await session('rollout-old.jsonl', 'old', cwd, since - 1_000);
    await session('rollout-wrong.jsonl', 'wrong', '/other/project', since + 1_000);
    const first = await session('rollout-first.jsonl', 'first', cwd, since + 2_000);
    const newer = await session('rollout-newer.jsonl', 'newer', cwd, since + 3_000);
    await assert.rejects(recordSession(teamDir, worker, cwd, since), /ambiguous session/);
    assert.equal(worker.session_id, null);
    await rm(newer);
    await recordSession(teamDir, worker, cwd, since);
    assert.equal(worker.session_id, 'first');
    assert.equal(worker.session_file, first);
    await session('rollout-newer.jsonl', 'newer', cwd, since + 3_000);
    await recordSession(teamDir, worker, cwd, since);
    assert.equal(worker.session_id, 'first');
    assert.equal(JSON.parse(await readFile(join(teamDir, 'team.json'), 'utf8')).workers.w1.session_id, 'first');
    await cleanupWorker(worker);
    await assert.rejects(recordSession(teamDir, worker, cwd, since), /pinned session file is missing/);
  } finally {
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
    await rm(home, { recursive: true, force: true });
  }
});
