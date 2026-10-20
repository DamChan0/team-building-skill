import { access, mkdir } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';

const root = dirname(fileURLToPath(import.meta.url));
export const supervisorBinary = join(root, '..', 'supervisor', 'target', 'release', 'team-supervisor');
const MAX_FRAME = 1024 * 1024;
// Bump when a submit payload change makes a daemon incompatible with its CLI.
export const supervisorCompatibility = 2;

const starters = new Map();

export function supervisorPaths(stateRoot) {
  const stateDir = join(stateRoot, 'supervisor');
  const digest = createHash('sha256').update(stateDir).digest('hex').slice(0, 24);
  return { stateDir, socket: join(process.env.XDG_RUNTIME_DIR || '/tmp', `tb-${process.getuid?.() || 0}-${digest}.sock`) };
}

const available = path => access(path).then(() => true, () => false);
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

function staleSupervisorError() {
  const error = new Error('supervisor is stale or incompatible with this CLI; let tasks finish, then locate and stop the daemon only while it is idle, and retry');
  error.code = 'stale_supervisor';
  return error;
}

function compatible(health) {
  return health.compatibility === supervisorCompatibility;
}


export class Supervisor {
  constructor(paths) { this.paths = paths; }

  request(command, payload = {}, id = randomUUID(), timeout = 15_000) {
    if (!payload || Array.isArray(payload) || typeof payload !== 'object') throw new Error('supervisor payload must be an object');
    const frame = Buffer.from(`${JSON.stringify({ version: 1, id, type: command, payload })}\n`);
    if (frame.length > MAX_FRAME) throw new Error('supervisor request exceeds 1MiB');
    return new Promise((resolve, reject) => {
      const socket = net.createConnection(this.paths.socket);
      let input = Buffer.alloc(0);
      let settled = false;
      const done = (error, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.removeAllListeners();
        socket.destroy();
        error ? reject(error) : resolve(value);
      };
      const timer = setTimeout(() => done(new Error('supervisor request timed out')), timeout);
      socket.once('error', error => done(error));
      socket.once('end', () => done(new Error('supervisor closed before response')));
      socket.on('data', chunk => {
        input = Buffer.concat([input, chunk]);
        if (input.length > MAX_FRAME) return done(new Error('supervisor response exceeds 1MiB'));
        const end = input.indexOf(0x0a);
        if (end < 0) return;
        try {
          const response = JSON.parse(input.subarray(0, end).toString('utf8'));
          if (!response || Array.isArray(response) || response.version !== 1 || response.id !== id || response.type !== 'response' || !response.payload || Array.isArray(response.payload) || typeof response.payload !== 'object') throw new Error('invalid supervisor response');
          if (!response.payload.ok) {
            const code = response.payload.error?.code;
            const message = response.payload.error?.message || 'supervisor rejected request';
            const error = new Error(`supervisor ${command} rejected request (${code || 'error'}): ${message}`);
            error.code = response.payload.error?.code;
            throw error;
          }
          done(null, response.payload);
        } catch (error) { done(error); }
      });
      socket.once('connect', () => socket.write(frame));
    });
  }

  health() { return this.request('health'); }
  async submit(spec, requestId) {
    if (!compatible(await this.health())) throw staleSupervisorError();
    return this.request('submit', spec, requestId, 15_000);
  }
  get(request_id) { return this.request('get', { request_id }); }
  wait(request_id, after_seq, timeout_ms) { return this.request('wait', { request_id, after_seq, timeout_ms }, randomUUID(), timeout_ms + 10_000); }
  ack(request_id, seq) { return this.request('ack', { request_id, seq }); }
  status(team, after = 0, limit = 128) { return this.request('status', { ...(team ? { team } : {}), after, limit }); }
  stop(team, worker) { return this.request('stop', { team, worker }, randomUUID(), 20_000); }
}

async function buildSupervisor() {
  if (await available(supervisorBinary)) return;
  await new Promise((resolve, reject) => {
    const child = spawn('cargo', ['build', '--release', '--locked'], { cwd: join(root, '..', 'supervisor'), stdio: 'ignore' });
    child.once('error', reject);
    child.once('close', code => code === 0 ? resolve() : reject(new Error(`cargo build --release --locked exited ${code}`)));
  });
  if (!(await available(supervisorBinary))) throw new Error(`team supervisor build did not produce ${supervisorBinary}`);
}

async function start(paths, client) {
  try {
    if (compatible(await client.health())) return;
    throw staleSupervisorError();
  } catch (error) {
    if (error.code === 'stale_supervisor') throw error;
  }
  await buildSupervisor();
  await new Promise((resolve, reject) => {
    const daemonEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('HERDR_')));
    const child = spawn(supervisorBinary, ['serve', '--state-dir', paths.stateDir, '--socket', paths.socket], { detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: daemonEnv });
    let output = Buffer.alloc(0);
    let settled = false;
    const finish = error => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdout?.destroy();
      child.stderr?.destroy();
      child.removeAllListeners();
      child.unref();
      error ? reject(error) : resolve();
    };
    const timer = setTimeout(() => finish(new Error('team supervisor startup timed out')), 8_000);
    child.once('error', error => finish(error));
    child.once('exit', () => finish(new Error('team supervisor exited during startup')));
    child.stdout.on('data', chunk => {
      output = Buffer.concat([output, chunk]);
      if (output.length > MAX_FRAME) return finish(new Error('supervisor readiness exceeds 1MiB'));
      const end = output.indexOf(0x0a);
      if (end < 0) return;
      try {
        const ready = JSON.parse(output.subarray(0, end).toString('utf8'));
        if (ready?.version !== 1 || ready?.type !== 'response' || ready?.id !== '00000000-0000-0000-0000-000000000000' || ready.payload?.ready !== true) throw new Error('invalid supervisor readiness frame');
        finish();
      } catch (error) { finish(error); }
    });
    child.stderr.resume();
  }).catch(async error => {
    // A competing manager may own the exclusive Rust lock; only a compatible daemon is usable.
    for (let retry = 0; retry < 8; retry++) {
      try {
        if (compatible(await client.health())) return;
        throw staleSupervisorError();
      } catch (retryError) {
        if (retryError.code === 'stale_supervisor') throw retryError;
      }
      await sleep(250);
    }
    throw error;
  });
  if (!compatible(await client.health())) throw staleSupervisorError();
}

export async function connectSupervisor(stateRoot) {
  const paths = supervisorPaths(stateRoot);
  await mkdir(paths.stateDir, { recursive: true, mode: 0o700 });
  const client = new Supervisor(paths);
  try { await client.health(); return client; } catch {}
  const key = paths.stateDir;
  let pending = starters.get(key);
  if (!pending) {
    pending = start(paths, client).finally(() => starters.delete(key));
    starters.set(key, pending);
  }
  await pending;
  return client;
}
