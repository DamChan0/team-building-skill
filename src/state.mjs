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
export const backendName = () => (process.env.HERDR_ENV === '1' ? 'herdr' : 'orca');

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
    if (!(await exists(join(dir, 'team.json')))) return null;
    return ((await load(dir)).backend || 'orca') === backendName() ? dir : null;
  }));
  return teams.filter(Boolean).sort();
}

export async function resolveTeam(id, die, cwd) {
  if (id && TEAM_ID_PATTERN.test(id)) {
    const dir = join(STATE_ROOT, id);
    if (!(await exists(join(dir, 'team.json')))) die(`no team ${JSON.stringify(id)} under ${STATE_ROOT}`);
    return dir;
  }

  const active = await Promise.all((await activeTeams()).map(async dir => ({ dir, data: await load(dir) })));
  const label = ({ data }) => data.name ? `${data.name} (${data.id})` : data.id;
  if (id) {
    const matches = active.filter(team => team.data.name === id);
    if (matches.length === 1) return matches[0].dir;
    if (matches.length > 1) die(`team name ${JSON.stringify(id)} is ambiguous; select a team ID`);
    die(`no team ${JSON.stringify(id)} under ${STATE_ROOT}; active teams: ${active.map(label).join(', ') || '(none)'}`);
  }

  if (!active.length) die('no active team; run `team-building init` first');
  const path = cwd && await realpath(cwd);
  if (path) {
    const matches = active.filter(team => team.data.cwd === path);
    if (matches.length === 1) return matches[0].dir;
    if (matches.length > 1) {
      die(`multiple teams for cwd ${path}; pass --team <id|name>: ${matches.map(label).join(', ')}`);
    }
    die(`no active team for cwd ${path}; active teams: ${active.map(team => `${label(team)} (${team.data.cwd || 'legacy: no cwd'})`).join(', ')}; run \`team-building init\` or pass --team <id|name>`);
  }
  if (active.length > 1) {
    die(`several teams active, pass --team: ${active.map(label).join(', ')}`);
  }
  return active[0].dir;
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
