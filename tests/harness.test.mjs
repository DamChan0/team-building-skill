import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { isDockerPush, isGitPush, nativeTask, ompTabCommand, writeShims } from '../src/harness.mjs';

function runBounded(program, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, { env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { process.kill(-child.pid, 'SIGKILL'); } catch {}
    }, 1_000);
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', (status, signal) => {
      clearTimeout(timer);
      resolve({ status, signal, stdout, stderr, timedOut });
    });
  });
}

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
    await writeFile(join(bin, 'omp'), `#!/bin/sh
if [ "$1" = config ]; then printf "low\\n"; exit; fi
exec node -e 'console.log(JSON.stringify(process.argv.slice(1)))' -- "$PWD" "$TEAM_BUILDING_WORKER" "$TEAM_BUILDING_ROLE" "$TEAM_BUILDING_TAB_DIR" "$TEAM_BUILDING_APPROVAL_TASK" "$@"
`);
    await chmod(join(bin, 'omp'), 0o755);
    process.env.PATH = `${bin}:${previousPath || ''}`;
    const worker = { id: 'w1', harness: 'omp', session_dir: join(root, "sessions 'w1'"), session_file: join(root, 'w1.jsonl'), model: 'openai-codex/gpt-6-luna' };
    const omp = await nativeTask('team', { ...worker, session_file: null }, { prompt: 'smoke', teamDir: root, cwd: root });
    // The tab session is the worker: no headless argv, only the thinking level the broker records.
    assert.deepEqual(omp.argv, []);
    assert.equal(omp.thinking, 'low');

    const launch = props => {
      const result = spawnSync('/bin/sh', ['-c', ompTabCommand('team', { ...worker, ...props }, { teamDir: root, cwd: root })], {
        encoding: 'utf8',
        env: { ...process.env, TEAM_BUILDING_WORKER: 'outer/w9', TEAM_BUILDING_ROLE: 'sub-manager', TEAM_BUILDING_APPROVAL_TASK: 't001' },
      });
      assert.equal(result.status, 0, result.stderr);
      return JSON.parse(result.stdout);
    };
    const [cwd, identity, role, tab, approval, ...argv] = launch({});
    assert.deepEqual([cwd, identity, role, tab, approval], [root, 'team/w1', 'worker', join(root, 'tabs', 'w1'), '']);
    assert.ok(!argv.includes('--mode') && !argv.includes('--no-ui'), 'the tab must run the interactive TUI');
    assert.deepEqual(argv.slice(-4), ['--resume', join(root, 'w1.jsonl'), '--model', 'openai-codex/gpt-6-luna']);
    const prompt = '--append-system-prompt';
    assert.match(argv[argv.indexOf(prompt) + 1], /never run team-building commands, manage teams, or create workers/);

    const [childCwd, parentIdentity, subRole, subTab, subApproval, ...subArgv] = launch({ role: 'sub-manager' });
    assert.deepEqual([childCwd, parentIdentity, subRole, subTab, subApproval], [root, 'team/w1', 'sub-manager', tab, '']);
    assertSubManagerContract(subArgv[subArgv.indexOf(prompt) + 1]);
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
  const schemaIndex = fresh.argv.indexOf('--json-schema');
  const schema = JSON.parse(fresh.argv[schemaIndex + 1]);
  assert.ok(schema.required.includes('tool_sessions'));
  assert.deepEqual(schema.properties.tool_sessions.items.required, ['kind', 'id']);
  const sub = await claude({ role: 'sub-manager', session_id: pinned });
  assertSubManagerContract(sub.argv[sub.argv.indexOf('--append-system-prompt') + 1]);
  const codex = await nativeTask('team', { id: 'w1', role: 'sub-manager', harness: 'codex' }, { prompt: 'smoke', teamDir: '/tmp', cwd: '/tmp' });
  const developerInstructions = codex.argv.find(arg => arg.startsWith('developer_instructions='));
  assertSubManagerContract(JSON.parse(developerInstructions.slice('developer_instructions='.length)));
});

function assertSubManagerContract(prompt) {
  assert.match(prompt, /sub-manager w1 of parent team team/);
  assert.match(prompt, /do not implement the code yourself/);
  for (const instruction of ['one owned child team', 'init --mode single-team', 'member', 'assign --detach', 'wait', 'status', 'clear', 'Never use host task', 'report the aggregate outcome', 'approval_requests', 'tool_sessions']) {
    assert.ok(prompt.toLowerCase().includes(instruction.toLowerCase()), `missing ${instruction}`);
  }
  assert.doesNotMatch(prompt, /never run team-building commands/);
}

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

test('shim resolves real command without worker identity and rejects recursion', { skip: process.platform === 'win32' }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'team-building-shim-'));
  const team = 'shim-team';
  const root = join(home, '.local', 'state', 'team-building', team);
  const bin = join(home, 'bin');
  const marker = join(home, 'ran');
  try {
    await mkdir(bin, { recursive: true });
    await writeFile(join(bin, 'git'), '#!/bin/sh\nprintf "%s\\n" "$*" > "$MARKER"\nprintf "fake git\\n"\n');
    await chmod(join(bin, 'git'), 0o755);
    await writeShims(root, {});
    const env = { ...process.env, HOME: home, MARKER: marker, PATH: `${join(root, 'shim')}/:${bin}:${process.env.PATH || ''}` };
    delete env.TEAM_BUILDING_WORKER;
    delete env.TEAM_BUILDING_SHIM_ACTIVE;
    delete env.TEAM_BUILDING_COMMAND;

    const result = await runBounded(join(root, 'shim', 'git'), ['--version'], env);
    assert.equal(result.timedOut, false);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, 'fake git\n');
    assert.equal(await readFile(marker, 'utf8'), '--version\n');

    const guarded = await runBounded(join(root, 'shim', 'git'), ['--version'], { ...env, TEAM_BUILDING_SHIM_ACTIVE: '1' });
    assert.equal(guarded.timedOut, false);
    assert.equal(guarded.status, 127);
    assert.equal(guarded.stderr, 'team-building shim: recursion detected, aborting\n');
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
