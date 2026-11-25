import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { supervisorCompatibility, supervisorPaths } from '../src/supervisor.mjs';

const exec = promisify(execFile);
const cli = fileURLToPath(new URL('../src/main.mjs', import.meta.url));

async function fixture(t) {
  const home = await mkdtemp(join(tmpdir(), 'tb-hierarchy-'));
  const stateRoot = join(home, '.local/state/team-building');
  const cwd = join(home, 'work');
  const nested = join(cwd, 'nested');
  const terminals = join(home, 'terminals');
  const denyClose = join(home, 'deny-close');
  const paths = supervisorPaths(stateRoot);
  const mux = join(home, 'orca.mjs');
  const calls = { stops: [], submissions: [], durable: new Map(), denyStop: null, subManagers: true };
  const server = createServer(socket => {
    socket.setEncoding('utf8');
    let input = '';
    socket.on('data', chunk => {
      input += chunk;
      if (!input.includes('\n')) return;
      const { id, type, payload } = JSON.parse(input);
      let reply = { ok: true };
      switch (type) {
        case 'health':
          reply.compatibility = supervisorCompatibility;
          if (calls.subManagers) reply.sub_managers = true;
          break;
        case 'status': Object.assign(reply, { workers: [], queued: 0, has_more: false }); break;
        case 'get': reply.task = calls.durable.get(payload.request_id) ?? null; break;
        case 'submit':
          calls.submissions.push(payload);
          calls.durable.set(id, { request_id: id, spec: payload, state: 'queued' });
          reply.request_id = id;
          break;
        case 'stop': {
          const worker = `${payload.team}/${payload.worker}`;
          calls.stops.push(worker);
          reply.stopped = worker !== calls.denyStop;
          break;
        }
        default: assert.fail(`unexpected RPC: ${type}`);
      }
      socket.end(`${JSON.stringify({ version: 1, id, type: 'response', payload: reply })}\n`);
    });
  });
  t.after(async () => {
    if (server.listening) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await rm(home, { recursive: true, force: true });
  });
  await Promise.all([nested, terminals, paths.stateDir].map(dir => mkdir(dir, { recursive: true })));
  server.listen(paths.socket);
  await once(server, 'listening');
  await writeFile(join(home, 'omp'), '#!/bin/sh\ncase "$3" in\n tools.approvalMode) echo yolo;;\n defaultThinkingLevel) echo medium;;\n *) exit 1;;\nesac\n', { mode: 0o755 });
  await writeFile(mux, `#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const dir = process.env.FIXTURE_TERMINALS;
const args = process.argv.slice(2, -1);
const option = flag => args[args.indexOf(flag) + 1];
if (args.includes('--worktree') && option('--worktree') !== ${JSON.stringify(`path:${cwd}`)}) {
  console.error('unexpected worktree ' + option('--worktree'));
  process.exit(1);
}
let result;
if (args[0] === 'status') result = { app: { running: true }, runtime: { reachable: true } };
else if (args[1] === 'create') {
  const handle = option('--title').replaceAll(' ', '-');
  writeFileSync(join(dir, handle), '');
  result = { terminal: { handle } };
} else if (args[1] === 'list') {
  result = { terminals: readdirSync(dir).map(handle => ({ handle, connected: true })) };
} else if (args[1] === 'close') {
  const handle = option('--terminal');
  const denied = process.env.FIXTURE_DENY_CLOSE;
  if (existsSync(denied) && readFileSync(denied, 'utf8') === handle) process.exit(1);
  rmSync(join(dir, handle), { force: true });
  result = { closed: true };
} else process.exit(1);
console.log(JSON.stringify({ ok: true, result }));
`, { mode: 0o755 });
  const env = {
    ...process.env,
    HOME: home,
    ORCA_WORKTREE_ID: `fixture::${cwd}`,
    ORCA_CLI_COMMAND: mux,
    FIXTURE_TERMINALS: terminals,
    FIXTURE_DENY_CLOSE: denyClose,
    PATH: `${home}:${process.env.PATH}`,
    TEAM_BUILDING_DISABLE_IDLE_WATCHER: '1',
  };
  for (const key of ['TEAM_BUILDING_WORKER', 'TEAM_BUILDING_ROLE', 'HERDR_ENV', 'HC_TERMINAL_ID', 'HC_TERMINAL_SOCKET']) delete env[key];
  const invoke = async (worker, ...args) => {
    const workerEnv = worker === null ? {} : { TEAM_BUILDING_WORKER: worker, TEAM_BUILDING_ROLE: 'sub-manager' };
    return exec(process.execPath, [cli, ...args], { cwd: worker === null ? cwd : nested, env: { ...env, ...workerEnv } })
      .then(response => ({ ...response, code: 0 }), error => error);
  };
  const ok = async (...args) => {
    const result = await invoke(...args);
    assert.equal(result.code, 0, result.stderr);
    return result.stdout;
  };
  const rejects = async (pattern, ...args) => {
    const result = await invoke(...args);
    assert.equal(result.code, 2, result.stderr);
    assert.match(result.stderr, pattern);
  };
  const teams = async () => Promise.all((await readdir(stateRoot)).filter(name => /^tb-/.test(name)).map(async id =>
    JSON.parse(await readFile(join(stateRoot, id, 'team.json'), 'utf8'))));
  return { cwd, env, stateRoot, terminals, denyClose, calls, invoke, ok, rejects, teams };
}

test('hierarchical init and selection enforce recorded ownership without changing legacy mode', async t => {
  const { cwd, stateRoot, calls, ok, rejects, teams } = await fixture(t);
  await rejects(/requires OMP/, null, 'init', '--mode', 'multi-team', '--harness', 'codex', '--allow-bypass');
  await ok(null, 'init', '--mode', 'multi-team', '--name', 'portfolio', '--model', 'fixture', '--member', '2');
  const [parent] = await teams();
  assert.equal(parent.mode, 'multi-team');
  assert.equal(parent.workers.w1.role, 'sub-manager');
  const lead = `${parent.id}/w1`;
  const sibling = `${parent.id}/w2`;
  await rejects(/cannot change team mode/, null, 'init', '--team', parent.id, '--mode', 'single-team');
  await ok(null, 'init', '--team', parent.id);
  await rejects(/no recursion/, lead, 'init', '--mode', 'multi-team');
  await rejects(/cannot use --clear-previous/, lead, 'init', '--clear-previous');
  await rejects(/not owned/, lead, 'init', '--team', 'portfolio');
  await rejects(/invalid TEAM_BUILDING_WORKER/, `${lead}/extra`, 'status');
  await rejects(/invalid TEAM_BUILDING_WORKER/, `${parent.id}/w01`, 'status');
  await rejects(/invalid TEAM_BUILDING_WORKER/, `${parent.id}\n/w1`, 'status');
  await rejects(/invalid TEAM_BUILDING_WORKER/, `${lead}\n`, 'status');
  const create = [lead, 'init', '--name', 'build', '--model', 'fixture', '--member', '1'];
  await Promise.all([ok(...create), ok(...create), ok(sibling, 'init', '--name', 'design', '--model', 'fixture', '--member', '1')]);
  const stored = await teams();
  assert.equal(stored.length, 3);
  const build = stored.find(team => team.name === 'build');
  const design = stored.find(team => team.name === 'design');
  assert.deepEqual(build.parent, { team: parent.id, worker: 'w1' });
  assert.equal(build.cwd, cwd);
  assert.equal(build.mode, 'single-team');
  assert.equal(build.workers.w1.role, 'worker');
  await ok(lead, 'init');
  await ok(lead, 'init', '--team', build.id);
  await rejects(/already owns child team/, lead, 'init', '--name', 'another');
  await rejects(/no recursion/, `${build.id}/w1`, 'status');
  await rejects(/cannot approve/, lead, 'approve', '--worker', 'w1', '--task', 't001', '--', 'git', 'push');
  for (const command of [['status'], ['assign', 'brief'], ['member', '2'], ['dismiss', '--worker', 'w1'], ['wait'], ['stop', '--worker', 'w1'], ['clear', '--fast']]) {
    await rejects(/not owned/, lead, ...command, '--team', 'design');
  }
  await rejects(/not owned/, lead, 'status', '--team', design.id);
  const ownerStatus = await ok(lead, 'status');
  assert.match(ownerStatus, /team build/);
  assert.doesNotMatch(ownerStatus, /team portfolio|team design/);
  assert.match(await ok(null, 'status'), /role=sub-manager[\s\S]*team build[\s\S]*team design/);
  assert.match(await ok(null, 'status', '--team', 'design'), /team design/);
  await ok(lead, 'assign', '--detach', 'build feature');
  const request = '80000000-0000-4000-8000-000000000001';
  const coordinate = [null, 'assign', '--detach', '--worker', 'w2', '--request-id', request, 'coordinate design'];
  const [assigned, replay] = await Promise.all([ok(...coordinate), ok(...coordinate)]);
  assert.equal(replay, assigned);
  assert.equal(calls.durable.get(request).spec.env.TEAM_BUILDING_ROLE, 'sub-manager');
  assert.deepEqual(calls.submissions.map(spec => [spec.team, spec.env.TEAM_BUILDING_ROLE]), [[build.id, 'worker'], [parent.id, 'sub-manager']]);
  delete calls.durable.get(request).spec.env.TEAM_BUILDING_ROLE;
  await rejects(/different durable worker role/, ...coordinate);
  assert.equal(calls.submissions.length, 2);

  const legacy = 'tb-0101-000001';
  await mkdir(join(stateRoot, legacy));
  await writeFile(join(stateRoot, legacy, 'team.json'), JSON.stringify({ id: legacy, name: 'legacy', cwd, workers: {} }));
  await rejects(/cannot change team mode.*single-team/, null, 'init', '--team', legacy, '--mode', 'multi-team');
  await rejects(/multiple teams.*legacy.*portfolio|multiple teams.*portfolio.*legacy/, null, 'status');
});

test('an older compatibility-4 supervisor blocks multi-team resources and new manager assignments only', async t => {
  const { terminals, calls, ok, rejects, teams } = await fixture(t);
  const unsupported = /stale_supervisor: multi-team requires supervisor compatibility 4 and health\.sub_managers=true \(running: compatibility=4, sub_managers=missing\)/;
  calls.subManagers = false;
  const init = [null, 'init', '--mode', 'multi-team', '--name', 'portfolio', '--model', 'fixture', '--member', '1'];
  await rejects(unsupported, ...init);
  assert.deepEqual(await teams(), []);
  assert.deepEqual(await readdir(terminals), []);

  await ok(null, 'init', '--name', 'ordinary', '--model', 'fixture', '--member', '1');
  const request = '80000000-0000-4000-8000-000000000002';
  const assign = [null, 'assign', '--detach', '--team', 'ordinary', '--request-id', request, 'execute work'];
  const assigned = await ok(...assign);
  assert.equal(calls.durable.get(request).spec.env.TEAM_BUILDING_ROLE, 'worker');
  delete calls.durable.get(request).spec.env.TEAM_BUILDING_ROLE; // A durable request written by the old CLI.
  assert.equal(await ok(...assign), assigned);

  calls.subManagers = true;
  await ok(...init);
  calls.subManagers = false;
  const parent = (await teams()).find(team => team.name === 'portfolio');
  await rejects(unsupported, null, 'assign', '--detach', '--team', parent.id, 'coordinate work');
  await rejects(unsupported, null, 'member', '2', '--team', parent.id);
  const retained = (await teams()).find(team => team.id === parent.id);
  assert.equal(retained.next_task, parent.next_task);
  assert.deepEqual(Object.keys(retained.workers), ['w1']);
  assert.equal(calls.submissions.length, 1);
});

test('retiring a sub-manager drains only its child and requires stop and observer closure proof', async t => {
  const { stateRoot, denyClose, calls, ok, rejects, teams } = await fixture(t);
  await ok(null, 'init', '--mode', 'multi-team', '--name', 'portfolio', '--model', 'fixture', '--member', '2');
  const [parent] = await teams();
  const first = `${parent.id}/w1`;
  const second = `${parent.id}/w2`;
  await ok(first, 'init', '--name', 'build', '--member', '2', '--model', 'fixture');
  await ok(second, 'init', '--name', 'design', '--member', '1', '--model', 'fixture');
  const stored = await teams();
  const build = stored.find(team => team.name === 'build');
  const design = stored.find(team => team.name === 'design');
  await ok(null, 'stop', '--worker', 'w1');
  assert.deepEqual(calls.stops, [first, `${build.id}/w1`, `${build.id}/w2`]);
  const designPath = join(stateRoot, design.id, 'team.json');
  await writeFile(designPath, JSON.stringify({ ...design, mode: 'multi-team' }));
  await rejects(/does not match the sub-manager/, second, 'status');
  await rejects(/child teams must use single-team mode/, null, 'init', '--team', design.id);
  await rejects(/does not match the sub-manager/, null, 'member', '1');
  assert.ok((await teams()).find(team => team.id === parent.id).workers.w2.retiring);
  assert.ok((await teams()).some(team => team.id === design.id));
  await writeFile(designPath, JSON.stringify(design));
  await ok(null, 'member', '1');
  assert.deepEqual((await teams()).map(team => team.name).sort(), ['build', 'portfolio']);
  assert.ok(calls.stops.includes(`${design.id}/w1`));
  calls.denyStop = `${build.id}/w1`;
  await rejects(/supervisor did not confirm stop/, null, 'clear', '--fast');
  const afterFailure = await teams();
  const retained = afterFailure.find(team => team.id === parent.id);
  assert.ok(retained.closing);
  assert.ok(retained.workers.w1.retiring);
  assert.ok(afterFailure.some(team => team.id === build.id));
  await rejects(/closing, retiring, or stopping/, first, 'init');
  await rejects(/closing, retiring, or stopping/, first, 'assign', '--detach', 'too late');
  calls.denyStop = null;
  const session = build.workers.w1.session_dir;
  await mkdir(session, { recursive: true });
  await writeFile(join(session, 'recoverable.jsonl'), 'session record');
  await writeFile(denyClose, build.workers.w2.observer);
  await rejects(/observer .*w2 is not proven closed/, null, 'clear', '--fast');
  assert.equal(await readFile(join(session, 'recoverable.jsonl'), 'utf8'), 'session record');
  await rm(denyClose);
  await ok(null, 'clear', '--fast');
  assert.deepEqual(await teams(), []);
});

test('Orca folder workspaces bind teams to ORCA_WORKSPACE_ROOT without git checks', async t => {
  const { cwd, env, terminals, invoke, ok, rejects, teams } = await fixture(t);
  await exec('git', ['init', '--quiet', join(cwd, '..')]); // a git-tracked home must not reject the folder
  Object.assign(env, { ORCA_WORKTREE_ID: 'folder:46d09e84-1e03-4abf-b57d-1d1762d0a11b', ORCA_WORKSPACE_ROOT: '' });
  const missing = await invoke(null, 'init', '--model', 'fixture', '--member', '1');
  assert.equal(missing.code, 4, missing.stderr);
  assert.match(missing.stderr, /ORCA_WORKTREE_ID=folder:\S+ needs an absolute ORCA_WORKSPACE_ROOT/);
  env.ORCA_WORKSPACE_ROOT = cwd;
  await rejects(/--isolate needs a git repository/, null, 'init', '--isolate', '--model', 'fixture', '--member', '1');
  assert.deepEqual(await teams(), []);
  assert.deepEqual(await readdir(terminals), []);
  await ok(null, 'init', '--model', 'fixture', '--member', '1');
  assert.equal((await teams())[0].worktree, cwd);
  await ok(null, 'status');
  await ok(null, 'assign', '--detach', 'folder work');
  await ok(null, 'member', '2');
  assert.equal((await readdir(terminals)).length, 2);
  await ok(null, 'clear', '--fast');
  assert.deepEqual(await teams(), []);
});
