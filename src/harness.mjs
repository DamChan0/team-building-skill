import { chmod, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { exists, GATED, STATE_ROOT, WORKER_ENV, dropPointers, load, save, withLock } from './state.mjs';

const ORCA = process.env.ORCA_CLI_COMMAND || 'orca-ide';
export class OrcaError extends Error {}
export const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
export const shellQuote = value => `'${String(value).replaceAll("'", "'\\''")}'`;

export function command(program, args, { cwd, timeout = 60_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`${program} timed out`)); }, timeout);
    child.stdout.on('data', chunk => { out += chunk; });
    child.stderr.on('data', chunk => { err += chunk; });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => { clearTimeout(timer); resolve({ code, out, err }); });
  });
}

export async function orca(...args) {
  try {
    const response = await command(ORCA, [...args, '--json']);
    const body = JSON.parse(response.out);
    if (response.code === 0 && body.ok) return body.result;
    throw new Error((response.err || response.out).trim().slice(-300));
  } catch (error) {
    throw new OrcaError(`${ORCA} ${args.slice(0, 2).join(' ')}: ${error.message}`);
  }
}

export async function requireOrca(die) {
  try {
    const status = await orca('status');
    if (status.app.running && status.runtime.reachable) return;
  } catch (error) {
    die(`Orca is not available (${error.message}); team workers run as Orca terminal sessions. Start Orca (\`${ORCA} open\`) and retry.`, 4);
  }
  die(`Orca is not running/reachable; start it (\`${ORCA} open\`) and retry.`, 4);
}

export async function requireOmp(die) {
  const result = await command('omp', ['--version']).catch(() => null);
  if (!result || result.code !== 0) {
    die('OMP is required for the default harness but was not found. Install it: curl -fsSL https://omp.sh/install | sh\nSee https://omp.sh/docs/quickstart', 4);
  }
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

async function codexSessions(since) {
  const files = [];
  const root = join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'sessions');

  async function walk(dir) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    await Promise.all(entries.map(async entry => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) return walk(path);
      if (!entry.isFile() || !/^rollout-.*\.jsonl$/.test(entry.name)) return;
      try {
        files.push({ path, mtime: (await stat(path)).mtimeMs });
      } catch {}
    }));
  }

  await walk(root);
  return files.sort((left, right) => right.mtime - left.mtime);
}

export async function recordSession(teamDir, worker, cwd, since = 0) {
  if (worker.session_file) {
    if (!(await exists(worker.session_file))) throw new OrcaError(`pinned session file is missing for ${worker.id}; refusing a fresh session`);
    if (worker.harness !== 'claude') {
      const header = await sessionHeader(worker.session_file);
      if (!header || header.id !== worker.session_id || header.cwd !== cwd) {
        throw new OrcaError(`pinned session identity does not match ${worker.id}; refusing a fresh session`);
      }
    }
    return;
  }
  const candidates = worker.harness === 'codex'
    ? (await codexSessions(since)).filter(file => file.mtime >= since).map(file => file.path)
    : await configFor(worker).files(worker);
  const matches = [];
  for (const file of candidates) {
    const header = worker.harness === 'claude' ? { id: worker.session_id, cwd } : await sessionHeader(file);
    if (header?.id && header.cwd === cwd && (!worker.session_id || header.id === worker.session_id)) {
      matches.push({ id: header.id, file });
    }
  }
  if (matches.length > 1) throw new OrcaError(`ambiguous session identity for ${worker.id}; refusing to choose the latest session`);
  if (!matches.length) return;
  const identity = { session_id: matches[0].id, session_file: matches[0].file };
  await withLock(teamDir, async () => {
    const team = await load(teamDir);
    const savedWorker = team.workers[worker.id];
    if (!savedWorker) throw new OrcaError(`worker ${worker.id} was removed while recording its session`);
    if (savedWorker.session_file && savedWorker.session_file !== identity.session_file) {
      throw new OrcaError(`session identity changed for ${worker.id}`);
    }
    Object.assign(savedWorker, identity);
    await save(teamDir, team);
  });
  Object.assign(worker, identity);
}

const HARNESSES = {
  omp: {
    session: () => null,
    files: ompFiles,
    async argv(worker, contract) {
      await mkdir(worker.session_dir, { recursive: true });
      return [
        'omp',
        '--no-title',
        '--session-dir',
        worker.session_dir,
        '--append-system-prompt',
        contract,
        ...(worker.session_file ? ['--resume', worker.session_file] : []),
      ];
    },
    async cleanup(worker) {
      await dropPointers(worker.session_dir);
      await rm(worker.session_dir, { recursive: true, force: true });
    },
  },
  claude: {
    bypass: '--dangerously-skip-permissions',
    session: randomUUID,
    files: claudeFiles,
    async argv(worker, contract) {
      return [
        'claude',
        '--append-system-prompt',
        contract,
        this.bypass,
        ...((await claudeFiles(worker)).length ? ['--resume', worker.session_id] : ['--session-id', worker.session_id]),
      ];
    },
    async cleanup(worker) {
      await Promise.all((await claudeFiles(worker)).map(file => rm(file, { force: true })));
    },
  },
  codex: {
    bypass: '--dangerously-bypass-approvals-and-sandbox',
    session: () => null,
    files: codexFiles,
    async argv(worker, contract) {
      const config = `developer_instructions=${JSON.stringify(contract)}`;
      return worker.session_id
        ? ['codex', 'resume', '-c', config, this.bypass, worker.session_id]
        : ['codex', '-c', config, this.bypass];
    },
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
import { basename, join } from 'node:path';
import { spawnSync } from 'node:child_process';

const [team, wid] = (process.env.TEAM_BUILDING_WORKER || '/').split('/');
const root = join(process.env.HOME, '.local/state/team-building', team);
const name = process.env.TEAM_BUILDING_COMMAND || basename(process.argv[1]);
const argv = [name, ...process.argv.slice(2)];
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
  const worker = JSON.parse(readFileSync(join(root, 'team.json'))).workers[wid];
  const task = worker.approval_task || worker.task;
  const approval = JSON.parse(readFileSync(join(root, 'approvals', task + '.json')));
  if (approval.worker === wid) approved = approval.commands || [];
} catch {}
if ((name !== 'git' || git) && (name !== 'docker' || docker) && !approved.some(command => JSON.stringify(command) === JSON.stringify(argv))) {
  console.error('BLOCKED: needs approval — return blocked with approval_requests');
  process.exit(126);
}
const path = process.env.PATH.split(':').filter(entry => entry !== join(root, 'shim')).join(':');
const result = spawnSync(name, process.argv.slice(2), { stdio: 'inherit', env: { ...process.env, PATH: path } });
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

export const contract = (team, wid) => `You are team-building worker ${wid} of team ${team}. A manager assigns work by sending one line that points to a brief file; write the result file named in that brief. Your context persists across assignments in this team.
Rules:
- Do the assigned work directly. Never run team-building init/member/assign/approve/clear or create another team or worker session.
- You cannot ask the user. When blocked, write status "blocked", including approval_requests with exact command argv string, target, and why.
- Touch only assigned files. You MAY delete only paths explicitly listed after \`May delete:\` in the brief, or files you created for this assignment. Never remove a directory wholesale or change git history.
- Remote/external commands require manager approval. For an unapproved gated command, do not retry it: return blocked with approval_requests. Local work needs no approval.
- In an isolated worktree, make a local commit and report its branch and commit.
- Write exactly one JSON object to the result path (via .tmp then rename):
{"status":"succeeded|failed|blocked","summary":"...","files_changed":["path"],"files_deleted":["path"],"verification":"...","blockers":[],"approval_requests":[],"branch":"","commit":""}`;
export function launchConfig(worker) {
  return {
    model: worker.task_model ?? worker.model ?? null,
    thinking: worker.task_thinking ?? null,
  };
}

export async function agentCommand(team, worker, { headless = false, prompt } = {}) {
  if (headless && (!worker.session_id || !worker.session_file || !(await exists(worker.session_file)))) {
    throw new OrcaError(`no pinned session to resume for ${worker.id}; refusing a fresh session`);
  }
  let args = await configFor(worker).argv(worker, contract(team, worker.id));
  if (headless) {
    if (worker.harness === 'codex') {
      args = ['codex', 'exec', 'resume', '-c', `developer_instructions=${JSON.stringify(contract(team, worker.id))}`, HARNESSES.codex.bypass, worker.session_id];
    } else {
      args.push('-p');
    }
  }
  const { model, thinking } = launchConfig(worker);
  if (model) args.push('--model', model);
  if (thinking && (!worker.harness || worker.harness === 'omp')) args.push('--thinking', thinking);
  if (headless) args.push(prompt);
  return [
    'env',
    `${WORKER_ENV}=${team}/${worker.id}`,
    `PATH=${join(STATE_ROOT, team, 'shim')}:${process.env.PATH || ''}`,
    ...args,
  ];
}
export async function closeTerminal(handle) {
  if (!handle) return true;
  try {
    await orca('terminal', 'close', '--terminal', handle, '--tab');
    return true;
  } catch {
    return false;
  }
}
export async function cleanupWorker(worker) {
  await configFor(worker).cleanup(worker);
}
