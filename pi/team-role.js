// team-building managed pi extension
// Shows the active manager session's role below Pi's editor. OMP worker-tab
// protocol stays in omp/team-role.ts; Pi exports PI_SESSION_ID to its bash tool.
import { readdirSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const STATE_ROOT = join(homedir(), '.local/state/team-building');

function managesTeam(cwd, session) {
  if (typeof session !== 'string' || !session) return false;
  let path;
  try { path = realpathSync(cwd); } catch { return false; }
  try {
    return readdirSync(STATE_ROOT).some(id => {
      if (!id.startsWith('tb-')) return false;
      try {
        const team = JSON.parse(readFileSync(join(STATE_ROOT, id, 'team.json'), 'utf8'));
        return team.cwd === path && !team.closing && team.manager_session === session;
      } catch { return false; }
    });
  } catch { return false; }
}

function render(ctx) {
  if (!ctx.hasUI || !ctx.ui?.setWidget) return;
  const manager = managesTeam(ctx.cwd ?? process.cwd(), ctx.sessionManager?.getSessionId?.());
  const line = manager ? '👑 \x1b[1;38;5;91mRole: manager\x1b[22;39m' : undefined;
  ctx.ui.setWidget('team-role', line && [line], { placement: 'belowEditor' });
}

export default function (pi) {
  pi.on('session_start', (_event, ctx) => render(ctx));
  pi.on('agent_end', (_event, ctx) => render(ctx));
}
