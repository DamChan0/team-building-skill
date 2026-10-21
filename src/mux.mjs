import { realpathSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { command, OrcaError, shellQuote } from './harness.mjs';

// A multiplexer backend owns the places workers live in: it opens/inspects/closes the tab that
// hosts a worker (or its read-only viewer) and creates/removes isolated git worktrees.
// Team-bound methods take the team record first; the tab handle `create` returns is stored as
// worker.observer. `current` and `home` run in the manager's own pane, before a team exists.

const ORCA = process.env.ORCA_CLI_COMMAND || 'orca-ide';

async function orca(...args) {
  try {
    const response = await command(ORCA, [...args, '--json']);
    const body = JSON.parse(response.out);
    if (response.code === 0 && body.ok) return body.result;
    throw new Error((response.err || response.out).trim().slice(-300));
  } catch (error) {
    throw new OrcaError(`${ORCA} ${args.slice(0, 2).join(' ')}: ${error.message}`);
  }
}

async function orcaTerminals(worktree) {
  const listing = await orca('terminal', 'list', '--worktree', `path:${worktree}`);
  if (!Array.isArray(listing.terminals)) throw new OrcaError('terminal census returned no terminals');
  return listing.terminals;
}

const orcaMux = {
  name: 'orca',
  label: 'Orca',
  async require(data, die) {
    try {
      const status = await orca('status');
      if (status.app.running && status.runtime.reachable) return;
    } catch (error) {
      die(`Orca is not available (${error.message}); team workers run as Orca terminal sessions. Start Orca (\`${ORCA} open\`) and retry.`, 4);
    }
    die(`Orca is not running/reachable; start it (\`${ORCA} open\`) and retry.`, 4);
  },
  // The manager's worktree, as the multiplexer sees it.
  async current(die) {
    const result = await command(ORCA, ['worktree', 'current', '--json']);
    let response;
    try {
      response = JSON.parse(result.out);
    } catch {
      die('Orca is not available; start Orca (`orca-ide open`) and retry.', 4);
    }
    const root = response.ok && response.result?.worktree?.path;
    if (root) return { worktree: root };
    const error = response.error || response;
    if (error.code === 'selector_not_found') {
      const paths = error.registeredPaths
        || error.registered_paths
        || error.details?.registeredPaths
        || error.details?.registered_paths
        || [];
      die(`Orca current worktree is not registered (selector_not_found); registered paths: ${paths.join(', ') || '(none)'}`, 4);
    }
    die('Orca is not available; start Orca (`orca-ide open`) and retry.', 4);
  },
  // Fields persisted in the team record at init.
  home: async () => ({}),
  // null when the tab is closed or missing.
  async inspect(data, handle, worktree) {
    const terminal = (await orcaTerminals(worktree)).find(item => item.handle === handle);
    return terminal?.connected && !terminal.exitCause ? { orphaned: !!terminal.orphaned, title: terminal.title } : null;
  },
  async listToolTabs(data, worktree) {
    const terminals = await orcaTerminals(worktree);
    if (terminals.some(item => typeof item.handle !== 'string' || !item.handle)) throw new OrcaError('terminal census returned a terminal without a handle');
    return terminals.map(item => item.handle);
  },
  async ownsToolTab(data, handle, worktree) {
    return (await orcaTerminals(worktree)).some(item => item.handle === handle);
  },
  async create(data, { worktree, title, launch }) {
    // Shell preexec hooks overwrite --title; the launch command restores it.
    const response = await orca('terminal', 'create', '--worktree', `path:${worktree}`, '--title', title, '--command', launch);
    const terminal = response.terminal || response;
    if (!terminal.handle) throw new OrcaError('observer create returned no handle');
    if (terminal.orphaned || terminal.connected === false) console.error(`team-building: warning: observer ${terminal.handle} was created without a connected Orca pane; use terminal switch to reveal it`);
    return terminal.handle;
  },
  async close(data, handle) {
    try {
      await orca('terminal', 'close', '--terminal', handle, '--tab');
      return true;
    } catch (error) {
      // A stale handle means Orca no longer has the tab: already closed.
      return /terminal_handle_stale/.test(`${error.message}${error.stdout ?? ''}${error.stderr ?? ''}`);
    }
  },
  async addWorktree(data, name, base) {
    const response = await orca('worktree', 'create', '--repo', `path:${data.cwd}`, '--name', name, '--base-branch', base, '--setup', 'skip', '--no-parent');
    const path = JSON.stringify(response).match(/"path"\s*:\s*"([^"]+)"/)?.[1];
    if (!path) throw new OrcaError('orca worktree create returned no path');
    return path;
  },
  removeWorktree: (data, path) => orca('worktree', 'rm', '--worktree', `path:${path}`),
};

// herdr pane and workspace IDs are scoped to one server and the CLI targets the server of its
// caller, so every team-bound call is pinned to the socket recorded at init.
async function herdr(socket, ...args) {
  const program = process.env.HERDR_CLI_COMMAND || 'herdr';
  const run = await command(program, args, { env: socket && { HERDR_SOCKET_PATH: socket } })
    .catch(error => { throw new OrcaError(`herdr ${args.slice(0, 2).join(' ')}: ${error.message}`); });
  if (run.code === 0) return run.out.trim() ? JSON.parse(run.out).result : null;
  // Server errors are JSON on stderr: { error: { code, message } }.
  let failure = { code: '', message: (run.err || run.out).trim().slice(-300) };
  try { failure = JSON.parse(run.err || run.out).error; } catch {}
  throw Object.assign(new OrcaError(`herdr ${args.slice(0, 2).join(' ')}: ${failure.message}`), { code: failure.code });
}

// The herdr workspace that shows a worktree; reopened when the user closed it.
async function workspaceOf(data, path) {
  const { worktrees } = await herdr(data.socket, 'worktree', 'list', '--cwd', path);
  const open = worktrees.find(item => item.path === path)?.open_workspace_id;
  return open ?? (await herdr(data.socket, 'worktree', 'open', '--cwd', path, '--path', path, '--no-focus')).workspace.workspace_id;
}
async function herdrTabs(data, worktree) {
  let workspace = data.isolate
    ? await workspaceOf(data, worktree)
    : data.workspace || process.env.HERDR_WORKSPACE_ID;
  if (!workspace) throw new OrcaError('team has no herdr workspace for tool-tab cleanup');
  let listing;
  try {
    listing = await herdr(data.socket, 'tab', 'list', '--workspace', workspace);
  } catch (error) {
    if (data.isolate || error.code !== 'workspace_not_found') throw error;
    workspace = await workspaceOf(data, worktree);
    listing = await herdr(data.socket, 'tab', 'list', '--workspace', workspace);
  }
  if (!Array.isArray(listing.tabs)) throw new OrcaError('herdr tab census returned no tabs');
  if (listing.tabs.some(tab => typeof tab.tab_id !== 'string' || !tab.tab_id)) throw new OrcaError('herdr tab census returned a tab without an ID');
  return listing.tabs;
}

const herdrMux = {
  name: 'herdr',
  label: 'herdr',
  async require(data, die) {
    try {
      await herdr(data.socket, 'workspace', 'list');
    } catch (error) {
      die(`herdr is not reachable (${error.message})`, 4);
    }
  },
  async current() {
    const top = await command('git', ['rev-parse', '--show-toplevel']);
    return { worktree: top.code === 0 && top.out.trim() ? top.out.trim() : realpathSync(process.cwd()) };
  },
  async home(die) {
    if (process.env.HERDR_ENV !== '1') die('not inside a herdr pane (HERDR_ENV is not 1)', 4);
    return { socket: process.env.HERDR_SOCKET_PATH, workspace: process.env.HERDR_WORKSPACE_ID };
  },
  // The handle is the worker's tab. Tab labels are sticky, so a live tab needs no title repair.
  async inspect(data, handle) {
    try {
      await herdr(data.socket, 'tab', 'get', handle);
      return { orphaned: false, title: null };
    } catch (error) {
      if (/_not_found$/.test(error.code)) return null;
      throw error;
    }
  },
  async listToolTabs(data, worktree) {
    return (await herdrTabs(data, worktree)).map(tab => tab.tab_id);
  },
  async ownsToolTab(data, handle, worktree) {
    return (await herdrTabs(data, worktree)).some(tab => tab.tab_id === handle);
  },
  // herdr cannot start a command in a new tab, so the launch command goes into a script that the
  // tab's shell execs: when the program exits the pane (and its tab) closes with it.
  async create(data, { worktree, title, launch, cwd, script }) {
    await writeFile(script, `${launch}\n`);
    const open = workspace => herdr(data.socket, 'tab', 'create', '--workspace', workspace, '--cwd', cwd, '--label', title, '--no-focus');
    let tab;
    if (data.isolate) {
      tab = await open(await workspaceOf(data, worktree));
    } else {
      // Shared workers sit next to the manager; its workspace may have been closed since init.
      try {
        tab = await open(data.workspace ?? process.env.HERDR_WORKSPACE_ID);
      } catch (error) {
        if (error.code !== 'workspace_not_found') throw error;
        tab = await open(await workspaceOf(data, worktree));
      }
    }
    const tabId = tab.tab.tab_id;
    const pane = tab.root_pane.pane_id;
    try {
      await herdr(data.socket, 'pane', 'run', pane, `exec sh ${shellQuote(script)}`);
    } catch (error) {
      await herdr(data.socket, 'tab', 'close', tabId).catch(() => {});
      throw error;
    }
    return tabId;
  },
  async close(data, handle) {
    try {
      await herdr(data.socket, 'tab', 'close', handle);
      return true;
    } catch (error) {
      return /_not_found$/.test(error.code);
    }
  },
  async addWorktree(data, name, base) {
    const created = await herdr(data.socket, 'worktree', 'create', '--cwd', data.cwd, '--branch', name, '--base', base, '--label', name, '--no-focus');
    return created.worktree.path;
  },
  async removeWorktree(data, path) {
    await herdr(data.socket, 'worktree', 'remove', '--workspace', await workspaceOf(data, path));
  },
};

export const MUXES = { orca: orcaMux, herdr: herdrMux };
// Teams created before backend selection have no `backend` field and were Orca teams.
export const muxOf = data => MUXES[data.backend || 'orca'];
