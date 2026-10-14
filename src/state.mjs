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
export const GATED = ['git', 'ssh', 'scp', 'rsync', 'sftp', 'gh', 'docker'];

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

export async function withLock(dir, fn) {
  await mkdir(dir, { recursive: true });
  const path = join(dir, 'lock');
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

export async function activeTeams() {
  if (!(await exists(STATE_ROOT))) return [];
  const entries = await readdir(STATE_ROOT, { withFileTypes: true });
  const teams = await Promise.all(entries.filter(entry => entry.isDirectory()).map(async entry => {
    const dir = join(STATE_ROOT, entry.name);
    return await exists(join(dir, 'team.json')) ? dir : null;
  }));
  return teams.filter(Boolean).sort();
}

export async function resolveTeam(id, die, cwd) {
  if (id) {
    if (!/^tb-\d{4}-\d{6}$/.test(id)) {
      die(`bad team id ${JSON.stringify(id)} (expected tb-MMDD-HHMMSS)`);
    }
    const dir = join(STATE_ROOT, id);
    if (!(await exists(join(dir, 'team.json')))) {
      die(`no team ${JSON.stringify(id)} under ${STATE_ROOT}`);
    }
    return dir;
  }

  const teams = await activeTeams();
  if (!teams.length) die('no active team; run `team-building init` first');
  const path = cwd && await realpath(cwd);
  if (path) {
    for (const team of teams) {
      if ((await load(team)).cwd === path) return team;
    }
    const active = await Promise.all(teams.map(async team => {
      const data = await load(team);
      return `${data.id} (${data.cwd || 'legacy: no cwd'})`;
    }));
    die(`no active team for cwd ${path}; active teams: ${active.join(', ')}; run \`team-building init\` or pass --team <id>`);
  }
  if (teams.length > 1) {
    die(`several teams active, pass --team: ${teams.map(team => team.split('/').pop()).join(', ')}`);
  }
  return teams[0];
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
