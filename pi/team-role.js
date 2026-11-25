// team-building managed pi extension
// Shows the manager or sub-manager role below Pi's editor. OMP worker-tab
// protocol stays in omp/team-role.ts; Pi exports PI_SESSION_ID to its bash tool.
import { registerTeamPolicy } from '../runtime/team-policy.mjs';


function render(ctx, manager) {
  if (!ctx.hasUI || !ctx.ui?.setWidget) return;
  const subManager = !!process.env.TEAM_BUILDING_WORKER && process.env.TEAM_BUILDING_ROLE === 'sub-manager';
  const line = subManager
    ? '🧭 \x1b[1;38;5;91mRole: sub-manager\x1b[22;39m'
    : manager
      ? '👑 \x1b[1;38;5;91mRole: manager\x1b[22;39m'
      : undefined;
  ctx.ui.setWidget('team-role', line && [line], { placement: 'belowEditor' });
}

export default function (pi) {
  const routing = registerTeamPolicy(pi, { onModeChange: render });
  for (const name of ['session_start', 'session_switch', 'session_branch', 'session_tree', 'agent_end']) {
    pi.on(name, (_event, ctx) => render(ctx, routing.active(ctx)));
  }
}
