import { access, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import lockfile from 'proper-lockfile';

export const STATE_ROOT = join(homedir(), '.local/state/team-building');
export const NOTES_DIR = join(homedir(), 'work-notes/team-building');
export const POINTERS = join(homedir(), '.omp/agent/custom-session-files');
export const DEFAULT_TIMEOUT = 1200;
export const DEFAULT_MAX = 14400;
export const WORKER_ENV = 'TEAM_BUILDING_WORKER';
export const TEAM_ID_PATTERN = /^tb-\d{4}-\d{6}(?:-\d+)?$/;
export const TEAM_NAME_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;
export const GATED = ['git', 'ssh', 'scp', 'rsync', 'sftp', 'gh', 'docker'];
export const teamMode = data => data.mode ?? 'single-team';
export const isOwnedChild = (data, team, worker) =>
  data.parent?.team === team && data.parent?.worker === worker;
export const backendName = () => (
  process.env.HERDR_ENV === '1'
    ? 'herdr'
    : process.env.HC_TERMINAL_ID || process.env.HC_TERMINAL_SOCKET
      ? 'hc'
      : 'orca'
);

export const now = () => new Date().toISOString().replace(/\.\d{3}Z$/, '');

export async function exists(path) {
  return access(path, constants.F_OK).then(() => true, () => false);
}

export async function load(dir) {
  return JSON.parse(await readFile(join(dir, 'team.json'), 'utf8'));
}

export async function save(dir, data) {
  const temporary = join(dir, 'team.json.tmp');
  await writeFile(temporary, JSON.stringify(data, null, 2));
  await rename(temporary, join(dir, 'team.json'));
}

export async function withLock(dir, fn, name = 'lock') {
  await mkdir(dir, { recursive: true });
  const path = join(dir, name);
  await writeFile(path, '', { flag: 'a' });
  const release = await lockfile.lock(path, {
    retries: { retries: 20, factor: 1.2, minTimeout: 50, maxTimeout: 500 },
    stale: 30000,
  });
  try {
    return await fn();
  } finally {
    await release().catch(() => {});
  }
}
export async function tryWithLock(dir, name, fn) {
  await mkdir(dir, { recursive: true });
  const path = join(dir, name);
  await writeFile(path, '', { flag: 'a' });
  let release;
  try {
    release = await lockfile.lock(path, { retries: 0, stale: 30000 });
  } catch (error) {
    if (error.code === 'ELOCKED') return false;
    throw error;
  }
  try {
    await fn();
    return true;
  } finally {
    await release().catch(() => {});
  }
}

export async function teamRecords() {
  const entries = await readdir(STATE_ROOT, { withFileTypes: true }).catch(error => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  const teams = await Promise.all(entries.filter(entry => entry.isDirectory() && TEAM_ID_PATTERN.test(entry.name)).map(async entry => {
    const teamDir = join(STATE_ROOT, entry.name);
    try {
      const data = await load(teamDir);
      if (data.id !== entry.name) throw new Error(`recorded team ID does not match ${teamDir}`);
      return { teamDir, data };
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  }));
  return teams.filter(Boolean).sort((left, right) => left.teamDir.localeCompare(right.teamDir));
}

export async function activeTeams() {
  return (await teamRecords()).filter(({ data }) => (data.backend || 'orca') === backendName());
}

export async function subManagerContext() {
  const identity = process.env[WORKER_ENV];
  if (identity === undefined) return null;
  const [teamId, workerId, extra] = identity.split('/');
  if (extra !== undefined || /\s/.test(identity) || !TEAM_ID_PATTERN.test(teamId) || !/^w[1-9]\d*$/.test(workerId || '')) {
    throw new Error(`invalid ${WORKER_ENV}: expected a team ID and worker ID such as tb-0101-000001/w1`);
  }
  const noRecursion = () => new Error(`refused: running inside worker ${identity}; workers cannot manage teams (no recursion)`);
  const team = await load(join(STATE_ROOT, teamId)).catch(error => {
    if (error.code === 'ENOENT') throw noRecursion();
    throw error;
  });
  const worker = team.workers?.[workerId];
  if (team.id !== teamId || team.parent || teamMode(team) !== 'multi-team'
    || worker?.id !== workerId || worker.role !== 'sub-manager') throw noRecursion();
  if ((worker.harness || team.harness || 'omp') !== 'omp') {
    throw new Error(`sub-manager ${identity} requires the OMP harness`);
  }
  if (team.closing || worker.retiring || worker.stopping) {
    throw new Error(`sub-manager ${identity} is closing, retiring, or stopping; cannot manage its child team`);
  }
  return { team, worker, cwd: worker.cwd || team.cwd };
}

export function assertOwnedChild(child, team, worker) {
  if (team.parent || teamMode(team) !== 'multi-team' || !isOwnedChild(child, team.id, worker.id)
    || teamMode(child) !== 'single-team' || child.cwd !== (worker.cwd || team.cwd)
    || (child.backend || 'orca') !== (team.backend || 'orca')) {
    throw new Error(`child team ${child.id} does not match the sub-manager's ownership, mode, cwd or backend`);
  }
}

export function ownedChild(teams, { team, worker }) {
  const matches = teams.filter(({ data }) => isOwnedChild(data, team.id, worker.id));
  if (matches.length > 1) throw new Error(`multiple child teams for ${team.id}/${worker.id}; clear the duplicate as root manager`);
  const child = matches[0];
  if (child) assertOwnedChild(child.data, team, worker);
  return child;
}

export async function resolveTeam(id, die, cwd, context = null) {
  if (context) {
    const child = ownedChild(await teamRecords(), context);
    if (id && (!child || (id !== child.data.id && id !== child.data.name))) {
      die(`team ${JSON.stringify(id)} is not owned by sub-manager ${context.team.id}/${context.worker.id}`);
    }
    if (!child) die('no owned child team; run `team-building init` first');
    return child.teamDir;
  }
  if (id && TEAM_ID_PATTERN.test(id)) {
    const dir = join(STATE_ROOT, id);
    const data = await load(dir).catch(error => {
      if (error.code === 'ENOENT') die(`no team ${JSON.stringify(id)} under ${STATE_ROOT}`);
      throw error;
    });
    if (data.id !== id) throw new Error(`recorded team ID does not match ${dir}`);
    return dir;
  }

  const active = (await activeTeams()).filter(({ data }) => id || !data.parent);
  const label = ({ data }) => data.name ? `${data.name} (${data.id})` : data.id;
  if (id) {
    const matches = active.filter(team => team.data.name === id);
    if (matches.length === 1) return matches[0].teamDir;
    if (matches.length > 1) die(`team name ${JSON.stringify(id)} is ambiguous; select a team ID`);
    die(`no team ${JSON.stringify(id)} under ${STATE_ROOT}; active teams: ${active.map(label).join(', ') || '(none)'}`);
  }

  if (!active.length) die('no active team; run `team-building init` first');
  const path = cwd && await realpath(cwd);
  if (path) {
    const matches = active.filter(team => team.data.cwd === path);
    if (matches.length === 1) return matches[0].teamDir;
    if (matches.length > 1) {
      die(`multiple teams for cwd ${path}; pass --team <id|name>: ${matches.map(label).join(', ')}`);
    }
    die(`no active team for cwd ${path}; active teams: ${active.map(team => `${label(team)} (${team.data.cwd || 'legacy: no cwd'})`).join(', ')}; run \`team-building init\` or pass --team <id|name>`);
  }
  if (active.length > 1) {
    die(`several teams active, pass --team: ${active.map(label).join(', ')}`);
  }
  return active[0].teamDir;
}

export function failed(summary, blockers = []) {
  return {
    status: 'failed',
    summary,
    files_changed: [],
    files_deleted: [],
    verification: '',
    blockers,
    approval_requests: [],
  };
}

export async function writeResult(dir, result) {
  await writeFile(join(dir, 'results', `${result.task}.json`), JSON.stringify(result, null, 2));
}

export async function dropPointers(prefix) {
  if (!(await exists(POINTERS))) return;
  for (const name of await readdir(POINTERS)) {
    const path = join(POINTERS, name);
    try {
      if ((await readFile(path, 'utf8')).trim().startsWith(`${prefix}/`)) {
        await rm(path);
      }
    } catch {}
  }
}
