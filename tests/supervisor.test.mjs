import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { afterEach } from 'node:test';
import { Supervisor, supervisorBinary, supervisorPaths } from '../src/supervisor.mjs';

const result = JSON.stringify({ status: 'succeeded', summary: 'fixture completed', verification: 'fixture' });
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const uuid = index => `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
const cli = fileURLToPath(new URL('../src/main.mjs', import.meta.url));

// Codex worker fixture: a native child process speaking JSON-RPC on stdio.
const fixture = `
import { appendFileSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import readline from 'node:readline';
const session = process.env.FIXTURE_SESSION;
const control = process.env.FIXTURE_CONTROL;
const effect = process.env.FIXTURE_EFFECT;
let thread;
let turn;
let complete;
writeFileSync(process.env.FIXTURE_SESSION_FILE, session);
const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
const finish = () => {
  if (!complete) return;
  appendFileSync(effect, session + '\\n');
  send({ jsonrpc: '2.0', method: 'item/completed', params: { threadId: thread, turnId: turn, item: { type: 'agentMessage', text: ${JSON.stringify(result)} } } });
  send({ jsonrpc: '2.0', method: 'turn/completed', params: { threadId: thread, turnId: turn, turn: { status: 'completed' } } });
};
net.createServer(socket => {
  let input = '';
  socket.on('data', chunk => {
    input += chunk;
    const end = input.indexOf('\\n');
    if (end < 0) return;
    const message = JSON.parse(input.slice(0, end));
    if (message && typeof message === 'object' && message.type === 'complete') {
      complete = true;
      finish();
      socket.end(JSON.stringify({ type: 'ack' }) + '\\n');
    }
  });
}).listen(control);
readline.createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line);
  if (message.id === 1) {
    send({ jsonrpc: '2.0', id: 1, result: {} });
  } else if (message.id === 2) {
    thread = 'thread-' + session;
    send({ jsonrpc: '2.0', id: 2, result: { thread: { id: thread } } });
  } else if (message.id === 3) {
    turn = 'turn-' + session;
    send({ jsonrpc: '2.0', id: 3, result: { turn: { id: turn } } });
    send({ jsonrpc: '2.0', method: 'turn/completed', params: { threadId: thread, turnId: 'wrong-turn', turn: { status: 'completed' } } });
  }
});
`;

// OMP worker fixture: a long-lived "tab" process that speaks the broker's file protocol
// (supervisor/src/worker.rs) the way the team-role extension does inside a real omp tab.
const tabFixture = `
import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import net from 'node:net';
const dir = process.env.FIXTURE_TAB;
const session = process.env.FIXTURE_SESSION;
const sessionFile = process.env.FIXTURE_SESSION_FILE;
const put = (name, value) => { writeFileSync(dir + '/' + name + '.tmp', JSON.stringify(value)); renameSync(dir + '/' + name + '.tmp', dir + '/' + name); };
let active;
let completeRequested = false;
const finish = () => {
  if (!active || !completeRequested) return;
  appendFileSync(process.env.FIXTURE_EFFECT, session + '\\n');
  put('outcome.json', { request_id: active, text: ${JSON.stringify(result)} });
  active = undefined;
  completeRequested = false;
};
mkdirSync(dir, { recursive: true });
writeFileSync(sessionFile, session);
put('ready.json', { pid: process.pid, session_id: session, session_file: sessionFile });
net.createServer(socket => {
  let input = '';
  socket.on('data', chunk => {
    input += chunk;
    const end = input.indexOf('\\n');
    if (end < 0) return;
    if (JSON.parse(input.slice(0, end))?.type === 'complete') {
      completeRequested = true;
      finish();
      socket.end(JSON.stringify({ type: 'ack' }) + '\\n');
    }
  });
}).listen(process.env.FIXTURE_CONTROL);
setInterval(() => {
  writeFileSync(dir + '/beat', String(Date.now()));
  if (active) return;
  try { renameSync(dir + '/task.json', dir + '/task.taken.json'); } catch { return; }
  active = JSON.parse(readFileSync(dir + '/task.taken.json', 'utf8')).request_id;
  put('started.json', { request_id: active });
  writeFileSync(process.env.FIXTURE_READY, 'ready');
  finish();
}, 50);
`;

const tabs = [];
// Starts the fixture tab in its own process group (the broker may SIGTERM that group).
async function startTab(root, control, { source = tabFixture, session = 'session-tab', worker = 'w1' } = {}) {
  await writeFile(join(root, 'tab.mjs'), source);
  const child = spawn(process.execPath, [join(root, 'tab.mjs')], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, FIXTURE_TAB: join(root, 'tabs', worker), FIXTURE_SESSION: session, FIXTURE_SESSION_FILE: join(root, `${worker}.session`), FIXTURE_CONTROL: control, FIXTURE_EFFECT: join(root, 'effect'), FIXTURE_READY: `${control}.ready` },
  });
  tabs.push(child);
  return child;
}
afterEach(() => { for (const child of tabs.splice(0)) { try { process.kill(-child.pid, 'SIGKILL'); } catch {} } });

async function connectControl(path) {
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      await new Promise((resolve, reject) => {
        const socket = net.createConnection(path);
        socket.once('error', reject);
        socket.once('connect', () => socket.write(`${JSON.stringify({ type: 'complete' })}\n`));
        socket.once('data', chunk => {
          try {
            const ack = JSON.parse(chunk.toString('utf8').trim());
            if (ack?.type !== 'ack') throw new Error('fixture returned an invalid control acknowledgement');
            socket.end();
            resolve();
          } catch (error) {
            reject(error);
          }
        });
      });
      return;
    } catch {
      await delay(20);
    }
  }
  throw new Error('fixture control socket did not become ready');
}

async function waitForFile(path, diagnostic) {
  for (let attempt = 0; attempt < 100 && !existsSync(path); attempt++) await delay(10);
  assert.ok(existsSync(path), `fixture did not create ${path}: ${JSON.stringify(await diagnostic())}`);
}

async function start(root, name = 'supervisor', paths = null) {
  const stateDir = paths?.stateDir || join(root, name, 'state');
  const socket = paths?.socket || join(root, name, 'socket');
  await mkdir(stateDir, { recursive: true });
  const process = spawn(supervisorBinary, ['serve', '--state-dir', stateDir, '--socket', socket], { stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error('supervisor did not become ready')), 5_000);
    process.once('error', reject);
    process.stdout.on('data', chunk => {
      output += chunk;
      if (!output.includes('"ready":true')) return;
      clearTimeout(timer);
      resolve();
    });
  });
  return { process, client: new Supervisor({ stateDir, socket }) };
}

async function stop(daemon, signal = false) {
  if (daemon.process.exitCode !== null) return;
  if (signal) daemon.process.kill('SIGKILL');
  else await daemon.client.request('shutdown').catch(() => {});
  await new Promise(resolve => daemon.process.once('exit', resolve));
}

function task(root, request, control, effect, { team = 'team', harness = 'omp', session = null, sessionFile = null, worker = 'w1', task: name = 't001' } = {}) {
  const nativeSessionFile = sessionFile || join(root, `${request}.session`);
  const native = harness === 'omp';
  return {
    team_dir: root,
    team, worker, task: name, kind: 'task', cwd: root, harness,
    argv: native ? [] : [process.execPath, join(root, 'fixture.mjs')],
    env: native ? {} : { FIXTURE_SESSION: session || `session-${request}`, FIXTURE_SESSION_FILE: nativeSessionFile, FIXTURE_CONTROL: control, FIXTURE_EFFECT: effect, FIXTURE_READY: `${control}.ready` },
    prompt: 'Complete this fixture task and report a structured result.',
    log: join(root, `${request}.log`), idle_timeout_ms: 10_000, max_timeout_ms: 30_000,
    ...(native && session ? { session_id: session, session_file: sessionFile } : {}),
  };
}

async function running(client, request) {
  let after = 0;
  for (;;) {
    const reply = await client.wait(request, after, 1_000);
    for (const event of reply.events) {
      after = Math.max(after, event.seq);
      await client.ack(request, event.seq);
    }
    if (reply.task.state === 'running' && reply.events.some(event => event.state === 'started')) return reply.task;
    if (['failed', 'blocked', 'unknown'].includes(reply.task.state)) throw new Error(`worker failed before running: ${JSON.stringify(reply.task)}`);
  }
}

async function owned(client, request) {
  let after = 0;
  for (;;) {
    const reply = await client.wait(request, after, 1_000);
    for (const event of reply.events) {
      after = Math.max(after, event.seq);
      if (event.state === 'owned') return;
    }
    if (['failed', 'blocked', 'unknown'].includes(reply.task.state)) throw new Error(`worker failed before ownership: ${JSON.stringify(reply.task)}`);
  }
}

async function terminal(client, request) {
  let after = 0;
  for (;;) {
    const reply = await client.wait(request, after, 1_000);
    for (const event of reply.events) after = Math.max(after, event.seq);
    if (['succeeded', 'failed', 'blocked', 'unknown'].includes(reply.task.state)) return reply.task;
  }
}

const available = existsSync(supervisorBinary);
test('broker keeps native work pending through acceptance and reuses its exact session', { skip: !available, concurrency: false }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'team-supervisor-'));
  const effect = join(root, 'effect');
  let daemon;
  try {
    daemon = await start(root);
    const first = uuid(1);
    const firstControl = join(root, 'first.sock');
    await startTab(root, firstControl);
    await daemon.client.submit(task(root, first, firstControl, effect), first);
    await running(daemon.client, first);
    await waitForFile(`${firstControl}.ready`, async () => (await daemon.client.get(first)).task);
    const previous = await daemon.client.wait(first, 0, 0);
    const after = previous.events.at(-1)?.seq || 0;
    const waiting = daemon.client.wait(first, after, 30_000);
    await connectControl(firstControl);
    const completedReply = await Promise.race([waiting, delay(1_000).then(() => null)]);
    assert.ok(completedReply, 'terminal event must wake an active waiter before its checkpoint');
    const completed = completedReply.task;
    assert.equal(completed.state, 'succeeded');
    assert.equal(completed.session_id, 'session-tab');

    const second = uuid(2);
    const secondControl = firstControl;
    await daemon.client.submit(task(root, second, secondControl, effect, { session: completed.session_id, sessionFile: completed.session_file, task: 't002' }), second);
    await running(daemon.client, second);
    await connectControl(secondControl);
    assert.equal((await terminal(daemon.client, second)).session_id, completed.session_id);
    assert.equal((await daemon.client.status('team')).workers[0].assignments, 2);
    assert.deepEqual(readFileSync(effect, 'utf8').trim().split('\n'), [completed.session_id, completed.session_id]);
  } finally {
    if (daemon) await stop(daemon);
    await rm(root, { recursive: true, force: true });
  }
});

test('broker preserves successful results with loose optional field types', { skip: !available, concurrency: false }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'team-supervisor-normalization-'));
  let daemon;
  try {
    const loose = JSON.stringify({
      status: 'succeeded', summary: 'fixture completed',
      verification: ['test passed', 'smoke passed'],
      branch: null, commit: null, files_changed: 'output.txt', blockers: null,
    });
    daemon = await start(root);
    await startTab(root, join(root, 'result.sock'), { source: tabFixture.replaceAll(JSON.stringify(result), JSON.stringify(loose)) });
    const request = uuid(9);
    const control = join(root, 'result.sock');
    await daemon.client.submit(task(root, request, control, join(root, 'effect')), request);
    await running(daemon.client, request);
    await waitForFile(`${control}.ready`, async () => (await daemon.client.get(request)).task);
    await connectControl(control);
    const completed = await terminal(daemon.client, request);
    assert.equal(completed.state, 'succeeded');
    assert.equal(completed.result.verification, 'test passed\nsmoke passed');
    assert.equal(completed.result.branch, '');
    assert.equal(completed.result.commit, '');
    assert.deepEqual(completed.result.files_changed, ['output.txt']);
    assert.deepEqual(completed.result.blockers, []);
  } finally {
    if (daemon) await stop(daemon);
    await rm(root, { recursive: true, force: true });
  }
});

test('broker survives manager EOF and makes identical request retries single-execution', { skip: !available, concurrency: false }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'team-supervisor-'));
  const effect = join(root, 'effect');
  let daemon;
  try {
    daemon = await start(root);
    const control = join(root, 'eof.sock');
    await startTab(root, control);
    const request = uuid(3);
    const spec = task(root, request, control, effect);
    await new Promise((resolve, reject) => {
      const socket = net.createConnection(daemon.client.paths.socket);
      socket.once('error', reject);
      socket.once('connect', () => { socket.end(`${JSON.stringify({ version: 1, id: request, type: 'submit', payload: spec })}\n`); resolve(); });
    });
    await running(daemon.client, request);
    await daemon.client.submit(spec, request);
    await assert.rejects(daemon.client.submit({ ...spec, prompt: 'different' }, request), error => error.code === 'conflict');
    await connectControl(control);
    assert.equal((await terminal(daemon.client, request)).state, 'succeeded');
    assert.equal(readFileSync(effect, 'utf8').trim().split('\n').length, 1);
  } finally {
    if (daemon) await stop(daemon);
    await rm(root, { recursive: true, force: true });
  }
});

test('Codex ignores a wrong-turn completion until its matching result arrives', { skip: !available, concurrency: false }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'team-supervisor-'));
  let daemon;
  try {
    await writeFile(join(root, 'fixture.mjs'), fixture);
    daemon = await start(root);
    const request = uuid(4);
    const control = join(root, 'codex.sock');
    await daemon.client.submit(task(root, request, control, join(root, 'effect'), { harness: 'codex' }), request);
    await running(daemon.client, request);
    await connectControl(control);
    assert.equal((await terminal(daemon.client, request)).state, 'succeeded');
  } finally {
    if (daemon) await stop(daemon);
    await rm(root, { recursive: true, force: true });
  }
});

test('restart marks running work unknown and fences its queued successor until verified CLI stop', { skip: !available, concurrency: false }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'team-supervisor-'));
  const effect = join(root, 'effect');
  const stateRoot = join(root, '.local', 'state', 'team-building');
  const runtime = join(root, 'runtime');
  const team = 'tb-0101-000001';
  const teamDir = join(stateRoot, team);
  const previousRuntime = process.env.XDG_RUNTIME_DIR;
  let daemon;
  try {
    process.env.XDG_RUNTIME_DIR = runtime;
    const paths = supervisorPaths(stateRoot);
    await mkdir(runtime, { recursive: true, mode: 0o700 });
    await mkdir(teamDir, { recursive: true });
    await writeFile(join(teamDir, 'team.json'), JSON.stringify({
      id: team,
      queue: [],
      workers: { w1: { id: 'w1', state: 'idle', harness: 'omp', log: join(teamDir, 'w1.log'), assignments: 0 } },
    }));
    daemon = await start(root, 'supervisor', paths);
    const first = uuid(5);
    const firstControl = join(root, 'restart-first.sock');
    await startTab(root, firstControl);
    await daemon.client.submit(task(root, first, firstControl, effect, { team }), first);
    await running(daemon.client, first);
    await owned(daemon.client, first);
    await waitForFile(`${firstControl}.ready`, async () => (await daemon.client.get(first)).task);
    await stop(daemon, true);
    daemon = await start(root, 'supervisor', paths);

    const second = uuid(6);
    const control = join(root, 'restart-second.sock');
    await daemon.client.submit(task(root, second, control, effect, { team, task: 't002' }), second);
    const before = await daemon.client.status(team);
    assert.deepEqual([before.workers[0].state, before.queued], ['unknown', 1]);

    const result = spawnSync(process.execPath, [cli, 'stop', '--team', team, '--worker', 'w1'], {
      encoding: 'utf8',
      timeout: 10_000,
      env: { ...process.env, HOME: root, XDG_RUNTIME_DIR: runtime },
    });
    assert.equal(result.status, 0, `${result.error?.message || ''}${result.stderr}`);
    assert.match(result.stdout, /broker-proven idle/);
    const saved = JSON.parse(readFileSync(join(teamDir, 'team.json'), 'utf8'));
    assert.equal(saved.workers.w1.state, 'idle');
    assert.equal(saved.workers.w1.session_id, 'session-tab');
    assert.equal((await daemon.client.get(second)).task.state, 'blocked');
    assert.equal((await daemon.client.status(team)).queued, 0);
  } finally {
    if (previousRuntime === undefined) delete process.env.XDG_RUNTIME_DIR;
    else process.env.XDG_RUNTIME_DIR = previousRuntime;
    if (daemon) await stop(daemon);
    await rm(root, { recursive: true, force: true });
  }
});
