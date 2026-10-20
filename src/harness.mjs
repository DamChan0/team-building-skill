import { chmod, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { exists, GATED, STATE_ROOT, WORKER_ENV, dropPointers, load, save, withLock } from './state.mjs';

export class OrcaError extends Error {}
export const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
export const shellQuote = value => `'${String(value).replaceAll("'", "'\\''")}'`;

export function command(program, args, { cwd, env, timeout = 60_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, { cwd, env: env && { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`${program} timed out`)); }, timeout);
    child.stdout.on('data', chunk => { out += chunk; });
    child.stderr.on('data', chunk => { err += chunk; });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => { clearTimeout(timer); resolve({ code, out, err }); });
  });
}

export async function requireOmp(die) {
  const result = await command('omp', ['config', 'get', 'tools.approvalMode']).catch(error => {
    if (error.code === 'ENOENT') die('OMP is required for the default harness but was not found. Install it: curl -fsSL https://omp.sh/install | sh\nSee https://omp.sh/docs/quickstart', 4);
    throw error;
  });
  if (result.code !== 0) die(`omp config get tools.approvalMode failed: ${(result.err || result.out).trim().slice(-300)}`, 4);
  return result.out.trim();
}

async function sessionHeader(path) {
  const input = createReadStream(path, { encoding: 'utf8' });
  const lines = createInterface({ input, crlfDelay: Infinity });
  try {
    let count = 0;
    for await (const line of lines) {
      const record = JSON.parse(line);
      if (record.type === 'session') return { id: record.id, cwd: record.cwd };
      if (record.type === 'session_meta') return { id: record.payload?.id || record.payload?.session_id, cwd: record.payload?.cwd };
      if (++count >= 8) break;
    }
  } finally {
    lines.close();
    input.destroy();
  }
  return null;
}

async function ompFiles(worker) {
  if (!(await exists(worker.session_dir))) return [];
  if (worker.session_file) return await exists(worker.session_file) ? [worker.session_file] : [];
  return (await readdir(worker.session_dir)).filter(file => file.endsWith('.jsonl')).map(file => join(worker.session_dir, file));
}
async function claudeFiles(worker) {
  const found = [], root = join(homedir(), '.claude', 'projects');
  async function walk(dir) {
    let entries; try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    await Promise.all(entries.map(entry => entry.isDirectory() ? walk(join(dir, entry.name)) : entry.name === `${worker.session_id}.jsonl` && found.push(join(dir, entry.name))));
  }
  await walk(root); return found;
}
async function codexFiles(worker) { return worker.session_file && await exists(worker.session_file) ? [worker.session_file] : []; }


export async function recordSession(teamDir, worker, cwd) {
  if (!worker.session_file) return;
  if (!(await exists(worker.session_file))) throw new OrcaError(`pinned session file is missing for ${worker.id}; refusing a fresh session`);
  if (!worker.session_id) throw new OrcaError(`pinned session has no native identity for ${worker.id}; refusing a fresh session`);
  if (worker.harness === 'claude') {
    if (!(await claudeFiles(worker)).includes(worker.session_file)) {
      throw new OrcaError(`pinned session identity does not match ${worker.id}; refusing a fresh session`);
    }
    return;
  }
  const header = await sessionHeader(worker.session_file);
  if (!header || header.id !== worker.session_id || header.cwd !== cwd) {
    throw new OrcaError(`pinned session identity does not match ${worker.id}; refusing a fresh session`);
  }
}

const HARNESSES = {
  omp: {
    files: ompFiles,
    async cleanup(worker) {
      await dropPointers(worker.session_dir);
      await rm(worker.session_dir, { recursive: true, force: true });
    },
  },
  claude: {
    bypass: '--dangerously-skip-permissions',
    files: claudeFiles,
    async cleanup(worker) {
      await Promise.all((await claudeFiles(worker)).map(file => rm(file, { force: true })));
    },
  },
  codex: {
    bypass: '--dangerously-bypass-approvals-and-sandbox',
    files: codexFiles,
    async cleanup(worker) {
      if (worker.session_file) await rm(worker.session_file, { force: true });
    },
  },
};
export const configFor = worker => HARNESSES[worker.harness || 'omp'];
export const isGitPush = args => firstCommand(
  args,
  ['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--super-prefix', '--config-env', '--exec-path'],
)[0] === 'push';
export const isDockerPush = args => {
  const [commandName, index] = firstCommand(
    args,
    ['--context', '--host', '-H', '--config', '--log-level', '--tlscacert', '--tlscert', '--tlskey'],
  );
  return commandName === 'push' || (commandName === 'image' && firstCommand(args.slice(index + 1))[0] === 'push');
};
export function firstCommand(args, options = []) {
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (options.includes(arg) && index + 1 < args.length) {
      index++;
      continue;
    }
    if (options.some(option => arg.startsWith(`${option}=`)) || arg.startsWith('-')) continue;
    return [arg, index];
  }
  return ['', args.length];
}

export async function writeShims(dir, data) {
  const extra = (process.env.TEAM_BUILDING_GATED_EXTRA || '').split(/\s+/).filter(Boolean);
  const gated = [...new Set([...GATED, ...extra])];
  if (gated.some(name => !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) || name === 'run.mjs')) {
    throw new Error('gated commands must be safe command names');
  }
  data.gated = gated;
  const shim = join(dir, 'shim');
  await mkdir(shim, { recursive: true });
  const script = `#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

if (process.env.TEAM_BUILDING_SHIM_ACTIVE === '1') {
  console.error('team-building shim: recursion detected, aborting');
  process.exit(127);
}
const shimDir = dirname(fileURLToPath(import.meta.url));
const teamBuildingDir = resolve(shimDir, '..', '..');

const [team, wid] = (process.env.TEAM_BUILDING_WORKER || '/').split('/');
const root = join(process.env.HOME, '.local/state/team-building', team);
const name = process.env.TEAM_BUILDING_COMMAND || basename(process.argv[1]);
const argv = [name, ...process.argv.slice(2)];
const approvalTask = process.env.TEAM_BUILDING_APPROVAL_TASK;
const first = (args, options = []) => {
  for (let index = 0; index < args.length; index++) {
    if (options.includes(args[index]) && index + 1 < args.length) {
      index++;
      continue;
    }
    if (options.some(option => args[index].startsWith(\`\${option}=\`)) || args[index].startsWith('-')) continue;
    return [args[index], index];
  }
  return ['', args.length];
};
const git = first(argv.slice(1), ['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--super-prefix', '--config-env', '--exec-path'])[0] === 'push';
const dockerArgs = argv.slice(1);
const [dockerCommand, dockerIndex] = first(dockerArgs, ['--context', '--host', '-H', '--config', '--log-level', '--tlscacert', '--tlscert', '--tlskey']);
const docker = dockerCommand === 'push' || (dockerCommand === 'image' && first(dockerArgs.slice(dockerIndex + 1))[0] === 'push');

let approved = [];
try {
  if (!approvalTask) throw new Error('no approval source task');
  const approval = JSON.parse(readFileSync(join(root, 'approvals', approvalTask + '.json')));
  if (approval.worker === wid && approval.task === approvalTask) approved = approval.commands || [];
} catch {}
if ((name !== 'git' || git) && (name !== 'docker' || docker) && !approved.some(command => JSON.stringify(command) === JSON.stringify(argv))) {
  console.error('BLOCKED: needs approval — return blocked with approval_requests');
  process.exit(126);
}
const path = process.env.PATH.split(':').filter(entry => {
  const resolved = resolve(entry);
  return resolved !== shimDir &&
    !(basename(resolved) === 'shim' && dirname(dirname(resolved)) === teamBuildingDir);
}).join(':');
const result = spawnSync(name, process.argv.slice(2), {
  stdio: 'inherit',
  env: { ...process.env, PATH: path, TEAM_BUILDING_SHIM_ACTIVE: '1' },
});
process.exit(result.status ?? 127);
`;
  await writeFile(join(shim, 'run.mjs'), script);
  await chmod(join(shim, 'run.mjs'), 0o755);
  for (const name of data.gated) {
    const launcher = `#!/usr/bin/env node
process.env.TEAM_BUILDING_COMMAND = ${JSON.stringify(name)};
await import('./run.mjs');
`;
    const path = join(shim, name);
    await rm(path, { force: true });
    await writeFile(path, launcher);
    await chmod(path, 0o755);
  }
}

export const contract = (team, wid) => `You are team-building worker ${wid} of team ${team}. Work only on the assigned task. Your task is the prompt sent by your manager.

Rules:
- Implement the assigned slice directly; never run team-building commands, manage teams, or create workers.
- You are not the lead. The manager triages and reviews your result, so skip lead-only startup: do not read ~/.codex/orchestration.md or output-style skills (caveman), and do not run an independent-review gate.
- Do not ask the user. If blocked, return status "blocked" and state the exact need.
- Touch only assigned files. Delete only paths explicitly allowed by the brief or files you created; never delete a directory wholesale or rewrite git history.
- External/gated commands need manager approval. If not approved, do not retry; return a blocked result with approval_requests containing the exact command argv, target, and reason. Local commands need no approval.
- In an isolated worktree, make a local commit and report its branch and commit. Never push.
- Return exactly one JSON object, without prose or Markdown, containing status ("succeeded", "failed", or "blocked"), summary, files_changed, files_deleted, verification, blockers, approval_requests, branch, and commit. summary, verification, branch, and commit must be strings; use "\\n" inside verification for multiple checks and "" for unavailable branch/commit, never null. files_changed, files_deleted, and blockers must be arrays of strings; approval_requests must be an array of request objects; use [] when empty. Do not write a result file; the supervisor receives the structured native result.`;
export function launchConfig(worker) {
  return { model: worker.task_model ?? worker.model ?? null, thinking: worker.task_thinking ?? null };
}

async function defaultOmpThinking() {
  const result = await command('omp', ['config', 'get', 'defaultThinkingLevel'], { timeout: 5_000 });
  const thinking = result.code === 0 ? result.out.trim() : '';
  if (!/^[a-z][a-z0-9_-]{0,31}$/i.test(thinking)) {
    throw new OrcaError('could not read a valid OMP defaultThinkingLevel; refusing to inherit native thinking');
  }
  return thinking;
}

export async function nativeTask(team, worker, { prompt, teamDir, cwd }) {
  const instruction = contract(team, worker.id);
  const { model, thinking: configuredThinking } = launchConfig(worker);
  const harness = worker.harness || 'omp';
  if (worker.session_file) await recordSession(teamDir, worker, cwd);
  if (harness === 'omp') {
    // The worker is the interactive omp in its multiplexer tab (see ompTabCommand); the broker only needs the thinking level.
    return { argv: [], env: {}, thinking: configuredThinking ?? await defaultOmpThinking() };
  }
  if (harness === 'claude') {
    const schema = JSON.stringify({ type: 'object', additionalProperties: false, required: ['status', 'summary', 'files_changed', 'files_deleted', 'verification', 'blockers', 'approval_requests', 'branch', 'commit'], properties: { status: { enum: ['succeeded', 'failed', 'blocked'] }, summary: { type: 'string' }, files_changed: { type: 'array', items: { type: 'string' } }, files_deleted: { type: 'array', items: { type: 'string' } }, verification: { type: 'string' }, blockers: { type: 'array', items: { type: 'string' } }, approval_requests: { type: 'array' }, branch: { type: 'string' }, commit: { type: 'string' } } });
    const argv = ['claude', '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--replay-user-messages', '--json-schema', schema, '--append-system-prompt', instruction];
    if (worker.allow_bypass) argv.push(HARNESSES.claude.bypass);
    argv.push(...(worker.session_id ? ['--resume', worker.session_id] : ['--session-id', randomUUID()]));
    if (model) argv.push('--model', model);
    if (configuredThinking) argv.push('--effort', configuredThinking);
    return { argv, env: {}, thinking: configuredThinking };
  }
  const argv = ['codex'];
  if (worker.allow_bypass) argv.push('-c', 'approval_policy="never"', '-c', 'sandbox_mode="danger-full-access"');
  argv.push('-c', `developer_instructions=${JSON.stringify(instruction)}`, 'app-server');
  return { argv, env: {}, thinking: configuredThinking };
}

export const tabDir = (teamDir, worker) => join(teamDir, 'tabs', worker.id);

// Shell command that turns a multiplexer tab into the OMP worker: the team-role extension in this
// interactive session receives broker prompts via TEAM_BUILDING_TAB_DIR. Per-task model and
// thinking are applied by the extension; the launch model only seeds a fixed-model team.
export function ompTabCommand(team, worker, { teamDir, cwd }) {
  const argv = ['omp', '--no-title', '--cwd', cwd, '--session-dir', worker.session_dir, '--append-system-prompt', contract(team, worker.id)];
  if (worker.session_file) argv.push('--resume', worker.session_file);
  if (worker.model) argv.push('--model', worker.model);
  const env = {
    TEAM_BUILDING_WORKER: `${team}/${worker.id}`,
    TEAM_BUILDING_TAB_DIR: tabDir(teamDir, worker),
    PATH: `${join(teamDir, 'shim')}:${process.env.PATH || ''}`,
  };
  return [`cd ${shellQuote(cwd)}`, ...Object.entries(env).map(([key, value]) => `export ${key}=${shellQuote(value)}`), `exec ${argv.map(shellQuote).join(' ')}`].join(' && ');
}
export async function cleanupWorker(worker) {
  await configFor(worker).cleanup(worker);
}
