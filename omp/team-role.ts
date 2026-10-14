// team-building managed omp extension
// Shows the team-building role under the editor: manager (bold dark purple) / worker (blue).
// Worker = launched by the team supervisor (TEAM_BUILDING_WORKER set).
// Manager = an active team at this cwd whose manager_session is this session.
// Bun child processes ignore process.env writes, so tool_call prefixes team-building bash
// commands with OMP_SESSION_ID for `init` to record.
import { readdirSync, readFileSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const STATE_ROOT = join(homedir(), '.local/state/team-building')

type Ctx = { cwd?: string; sessionManager?: { getSessionId?: () => unknown }; ui?: { setWidget?: (key: string, content: string[] | undefined, options?: { placement: 'aboveEditor' | 'belowEditor' }) => void } }
type ToolCall = { toolName?: string; input?: { command?: unknown } }
type Pi = { on(event: string, handler: (event: never, ctx: Ctx) => unknown): void }

function managesTeam(cwd: string, session: unknown): boolean {
  if (typeof session !== 'string' || !session) return false
  let path: string
  try { path = realpathSync(cwd) } catch { return false }
  try {
    return readdirSync(STATE_ROOT).some(id => {
      if (!id.startsWith('tb-')) return false
      try {
        const team = JSON.parse(readFileSync(join(STATE_ROOT, id, 'team.json'), 'utf8'))
        return team.cwd === path && !team.closing && team.manager_session === session
      } catch { return false }
    })
  } catch { return false }
}

function render(ctx: Ctx): void {
  const session = ctx?.sessionManager?.getSessionId?.()
  if (!ctx?.ui?.setWidget) return
  const line = process.env.TEAM_BUILDING_WORKER
    ? '🔧 \x1b[38;5;27mRole: worker\x1b[39m'
    : managesTeam(ctx.cwd ?? process.cwd(), session)
      ? '👑 \x1b[1;38;5;91mRole: manager\x1b[22;39m'
      : undefined
  ctx.ui.setWidget('team-role', line && [line], { placement: 'belowEditor' })
}

export default function (pi: Pi): void {
  // agent_end refreshes after `init`/`clear` changes the team mid-session.
  for (const event of ['session_start', 'agent_end']) pi.on(event, (_event, ctx) => render(ctx))
  pi.on('tool_call', (event: ToolCall, ctx) => {
    const { command } = event.input ?? {}
    const session = ctx?.sessionManager?.getSessionId?.()
    if (event.toolName !== 'bash' || typeof command !== 'string' || !command.includes('team-building')) return
    if (typeof session !== 'string' || !/^[\w-]+$/.test(session)) return
    return { input: { ...event.input, command: `export OMP_SESSION_ID=${session}; ${command}` } }
  })
}
