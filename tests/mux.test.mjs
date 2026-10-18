import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { muxOf } from '../src/mux.mjs';

// Fake herdr: logs argv + the socket it was pointed at; tab w1:t2 is the only live tab.
const FAKE = `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
const args = process.argv.slice(2);
appendFileSync(process.env.HERDR_TEST_CALLS, JSON.stringify({ socket: process.env.HERDR_SOCKET_PATH, args }) + '\\n');
const ok = result => console.log(JSON.stringify({ id: 'x', result }));
const [group, action, target] = args;
if (group === 'tab' && action === 'create') ok({ tab: { tab_id: 'w1:t2' }, root_pane: { pane_id: 'w1:p9' } });
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
});
