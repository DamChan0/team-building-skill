import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { backendName } from '../src/state.mjs';
import { muxOf } from '../src/mux.mjs';

// Fake herdr: logs argv + the socket it was pointed at; tab w1:t2 is the only live tab.
const FAKE = `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
const args = process.argv.slice(2);
appendFileSync(process.env.HERDR_TEST_CALLS, JSON.stringify({ socket: process.env.HERDR_SOCKET_PATH, args }) + '\\n');
const ok = result => console.log(JSON.stringify({ id: 'x', result }));
const [group, action, target] = args;
if (group === 'tab' && action === 'create') ok({ tab: { tab_id: 'w1:t2' }, root_pane: { pane_id: 'w1:p9' } });
else if (group === 'tab' && action === 'list') ok({ tabs: [{ tab_id: 'w1:t2' }] });
else if (group === 'pane' && action === 'run') {} // herdr prints nothing on success
else if (group === 'tab' && target !== 'w1:t2') {
  console.error(JSON.stringify({ error: { code: 'tab_not_found', message: 'tab ' + target + ' not found' } }));
  process.exit(1);
} else ok({});
`;

test('herdr backend launches workers through a script and pins the recorded server', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'team-building-herdr-'));
  const calls = join(dir, 'calls.jsonl');
  const fake = join(dir, 'herdr');
  const saved = { cli: process.env.HERDR_CLI_COMMAND, calls: process.env.HERDR_TEST_CALLS, socket: process.env.HERDR_SOCKET_PATH };
  try {
    await writeFile(fake, FAKE);
    await chmod(fake, 0o755);
    Object.assign(process.env, { HERDR_CLI_COMMAND: fake, HERDR_TEST_CALLS: calls, HERDR_SOCKET_PATH: '/ambient/other.sock' });
    const data = { backend: 'herdr', socket: '/team/herdr.sock', workspace: 'w1', worktree: '/repo', isolate: false };
    const mux = muxOf(data);
    const script = join(dir, 'launch.sh');

    const handle = await mux.create(data, { worktree: '/repo', title: 'tb w1 session', launch: "cd '/repo' && exec omp", cwd: '/repo', script });
    assert.equal(handle, 'w1:t2');
    assert.equal(await readFile(script, 'utf8'), "cd '/repo' && exec omp\n");
    const logged = (await readFile(calls, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    assert.deepEqual(logged.map(call => call.args.slice(0, 2).join(' ')), ['tab create', 'pane run']);
    assert.ok(logged.every(call => call.socket === '/team/herdr.sock'), 'team server wins over the caller ambient server');
    assert.deepEqual(logged[1].args.slice(2), ['w1:p9', `exec sh '${script}'`]);

    assert.deepEqual(await mux.inspect(data, 'w1:t2'), { orphaned: false, title: null });
    assert.equal(await mux.inspect(data, 'w1:t1'), null);
    assert.equal(await mux.ownsToolTab(data, 'w1:t2', '/repo'), true);
    assert.deepEqual(await mux.listToolTabs(data, '/repo'), ['w1:t2']);
    assert.equal(await mux.ownsToolTab(data, 'w1:t1', '/repo'), false);
    assert.equal(await mux.close(data, 'w1:t1'), true, 'a vanished tab is already closed');
    assert.equal(await mux.close(data, 'w1:t2'), true);
  } finally {
    for (const [key, value] of Object.entries({ HERDR_CLI_COMMAND: saved.cli, HERDR_TEST_CALLS: saved.calls, HERDR_SOCKET_PATH: saved.socket })) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await rm(dir, { recursive: true, force: true });
  }
});

test('teams without a recorded backend are Orca teams', () => {
  assert.equal(muxOf({}).name, 'orca');
  assert.equal(muxOf({ backend: 'herdr' }).name, 'herdr');
  assert.equal(muxOf({ backend: 'hc' }).name, 'hc');
});

const HC_FAKE = `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
const args = process.argv.slice(2);
appendFileSync(process.env.HC_TEST_CALLS, JSON.stringify({ args, socket: process.env.HC_SOCKET, caller: process.env.HC_TERMINAL_ID, terminalSocket: process.env.HC_TERMINAL_SOCKET }) + '\\n');
const [flag, action, ...rest] = args;
const ok = value => console.log(JSON.stringify(value));
if (action === 'run') ok({ address: 't9' });
else if (action === 'get' && rest[0] === 'missing') {
  console.error(JSON.stringify({ error: { kind: 'not_found', message: 'terminal missing' } }));
  process.exit(1);
} else if (action === 'get') ok({ address: rest[0], state: rest[0] === 'finished' ? 'finished' : 'live' });
else if (action === 'ls') ok({ terminals: [{ address: 't1' }, { address: 'finished' }] });
else if (action === 'kill') ok({ address: rest[0], state: 'finished' });
else if (action === 'rm') ok({ removed: rest[0] });
else if (action === 'server' && rest[0] === 'status') ok({ core: { id: 'core' } });
else {
  console.error(JSON.stringify({ error: { kind: 'unsupported', message: 'unsupported fixture call' } }));
  process.exit(1);
}
`;

test('herdr-app backend launches labeled child terminals and pins the recorded core', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'team-building-hc-'));
  const calls = join(dir, 'calls.jsonl');
  const fake = join(dir, 'hc');
  const script = join(dir, 'launch.sh');
  const socket = '/team/herdr-core.sock';
  const keys = ['HC_CLI_COMMAND', 'HC_TEST_CALLS', 'HC_SOCKET', 'HC_TERMINAL_ID', 'HC_TERMINAL_SOCKET', 'HC_SCOPE'];
  const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  try {
    await writeFile(calls, '');
    await writeFile(fake, HC_FAKE);
    await chmod(fake, 0o755);
    Object.assign(process.env, {
      HC_CLI_COMMAND: fake,
      HC_TEST_CALLS: calls,
      HC_SOCKET: '/ambient/other.sock',
      HC_TERMINAL_ID: 't-manager',
      HC_TERMINAL_SOCKET: '/manager.sock',
      HC_SCOPE: 'manager-scope',
    });
    const data = { backend: 'hc', id: 'tb-0101-000001', socket, cwd: '/repo', worktree: '/repo', isolate: false };
    const mux = muxOf(data);

    await mux.require(data, (message, code) => { throw Object.assign(new Error(message), { code }); });
    assert.equal((await mux.current()).worktree, process.cwd());
    assert.equal(await mux.create(data, { title: `${data.id} w1 observer`, launch: 'exec viewer', cwd: '/repo', script, worker: 'w1' }), 't9');
    assert.equal(await readFile(script, 'utf8'), 'exec viewer\n');
    assert.deepEqual(await mux.inspect(data, 't1'), { orphaned: false, title: null });
    assert.equal(await mux.inspect(data, 'finished'), null);
    assert.equal(await mux.inspect(data, 'missing'), null);
    assert.deepEqual(await mux.listToolTabs(data), ['t1', 'finished']);
    assert.equal(await mux.ownsToolTab(data, 't1'), true);
    assert.equal(await mux.ownsToolTab(data, 'other'), false);
    assert.equal(await mux.close(data, 't1'), true);
    assert.equal(await mux.close(data, 'finished'), true);
    assert.equal(await mux.close(data, 'missing'), true);
    await assert.rejects(mux.addWorktree(data, 'branch', 'main'), /does not support --isolate/);

    const logged = (await readFile(calls, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    assert.ok(logged.every(call => call.socket === socket), 'team socket overrides ambient HC_SOCKET');
    assert.equal(logged[1].caller, 't-manager', 'hc run stays parented to the manager terminal');
    assert.equal(logged[1].terminalSocket, '/manager.sock');
    assert.deepEqual(logged[1].args.slice(0, 3), ['--json', 'run', '--bg']);
    assert.ok(logged[1].args.includes('team=tb-0101-000001'));
    assert.ok(logged[1].args.includes('worker=w1'));
    assert.ok(logged[1].args.includes(`where=${data.id} w1 observer`));
    assert.equal(logged[1].args.at(-2), 'sh');
    assert.equal(logged[1].args.at(-1), script);
    assert.deepEqual(
      logged.filter(call => call.args[1] === 'kill' || call.args[1] === 'rm').map(call => call.args[1]),
      ['kill', 'rm', 'rm'],
    );
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await rm(dir, { recursive: true, force: true });
  }
});

test('backend detection prefers explicit herdr markers, then herdr-app terminal markers', () => {
  const keys = ['HERDR_ENV', 'HC_TERMINAL_ID', 'HC_TERMINAL_SOCKET'];
  const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  try {
    process.env.HERDR_ENV = '';
    process.env.HC_TERMINAL_ID = 't2';
    process.env.HC_TERMINAL_SOCKET = '/run/user/1000/herdr-core/default.sock';
    assert.equal(backendName(), 'hc');
    process.env.HERDR_ENV = '1';
    assert.equal(backendName(), 'herdr');
    delete process.env.HERDR_ENV;
    delete process.env.HC_TERMINAL_ID;
    delete process.env.HC_TERMINAL_SOCKET;
    assert.equal(backendName(), 'orca');
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});
