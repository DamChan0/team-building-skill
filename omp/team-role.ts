// team-building managed omp extension
// 1. Shows the manager, sub-manager, or worker role under the editor.
//    Sub-manager and worker = launched by the team supervisor (TEAM_BUILDING_WORKER set).
//    Manager = the shared routing guard is active, including restored manager sessions.
// 2. Worker tab bridge (TEAM_BUILDING_TAB_DIR set): this interactive session *is* the worker.
//    The broker hands it prompts through small JSON files in that directory and reads the
//    final assistant text back (protocol documented in supervisor/src/worker.rs):
//      ready.json/beat/progress  -> broker   identity, liveness, activity
//      task.json                 <- broker   one prompt, claimed by renaming it to task.taken.json
//      started.json/outcome.json -> broker   prompt accepted / final assistant text or error
//      abort.json                <- broker   interrupt the running prompt
// Bun child processes ignore process.env writes, so tool_call prefixes bash commands with
// the env they need (OMP_SESSION_ID for `init` to record; per-task TEAM_BUILDING_* for workers).
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { registerTeamPolicy } from '../runtime/team-policy.mjs'

const TAB = process.env.TEAM_BUILDING_TAB_DIR

type Ctx = {
  cwd?: string
  sessionManager?: { getSessionId?: () => unknown; getSessionFile?: () => unknown }
  models?: { resolve?: (spec: string) => unknown }
  ui?: { setWidget?: (key: string, content: string[] | undefined, options?: { placement: 'aboveEditor' | 'belowEditor' }) => void }
  isIdle?: () => boolean
  hasPendingMessages?: () => boolean
  abort?: () => void
  setInterval?: (fn: () => void, ms: number) => unknown
  clearTimer?: (timer: unknown) => void
}
type ToolCall = { toolName?: string; input?: { command?: unknown } }
type Message = { role?: string; content?: unknown; stopReason?: string; errorMessage?: string; timestamp?: number }
type Pi = {
  on(event: string, handler: (event: never, ctx: Ctx) => unknown): void
  sendUserMessage(content: string): unknown
  setModel(model: unknown): Promise<unknown> | unknown
  setThinkingLevel(level: string): unknown
}
type Task = { request_id: string; prompt: string; model?: string | null; thinking?: string | null; env?: Record<string, unknown> }


function render(ctx: Ctx, manager: boolean): void {
  if (!ctx?.ui?.setWidget) return
  const line = process.env.TEAM_BUILDING_WORKER
    ? process.env.TEAM_BUILDING_ROLE === 'sub-manager'
      ? '🧭 \x1b[1;38;5;91mRole: sub-manager\x1b[22;39m'
      : '🔧 \x1b[38;5;27mRole: worker\x1b[39m'
    : manager
      ? '👑 \x1b[1;38;5;91mRole: manager\x1b[22;39m'
      : undefined
  ctx.ui.setWidget('team-role', line && [line], { placement: 'belowEditor' })
}

// --- worker tab bridge ---------------------------------------------------------------
let active: { id: string; started: number; env: Record<string, string> } | undefined
let ticking = false
let timer: unknown
let lastBeat = 0
let lastProgress = 0
let lastReady = ''

const put = (name: string, value: unknown) => {
  const path = join(TAB!, name)
  writeFileSync(`${path}.tmp`, JSON.stringify(value))
  renameSync(`${path}.tmp`, path)
}
const touch = (name: string) => writeFileSync(join(TAB!, name), String(Date.now()))

function readJson(name: string): Record<string, unknown> | undefined {
  try { return JSON.parse(readFileSync(join(TAB!, name), 'utf8')) } catch { return undefined }
}

function progress(): void {
  const now = Date.now()
  if (!TAB || !active || now - lastProgress < 1000) return
  lastProgress = now
  touch('progress')
}

function finish(outcome: { text?: string; error?: string }): void {
  if (!active) return
  put('outcome.json', { request_id: active.id, ...outcome })
  active = undefined
}

function assistantOutcome(messages: Message[], since: number): { text?: string; error?: string } {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (message?.role !== 'assistant') continue
    // An epoch-ms stamp older than this prompt means this run produced no assistant message.
    if (typeof message.timestamp === 'number' && message.timestamp > 1e12 && message.timestamp < since - 1000) break
    if (message.stopReason === 'error' || message.stopReason === 'aborted') {
      return { error: `assistant turn ${message.stopReason}${message.errorMessage ? `: ${message.errorMessage}` : ''}` }
    }
    const text = Array.isArray(message.content)
      ? message.content.filter(part => part?.type === 'text' && typeof part.text === 'string').map(part => part.text).join('')
      : typeof message.content === 'string' ? message.content : ''
    return text ? { text } : { error: 'worker produced no final text' }
  }
  return { error: 'worker produced no assistant message' }
}

async function begin(pi: Pi, ctx: Ctx, task: Task): Promise<void> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(task.env ?? {})) {
    if (/^[A-Z_][A-Z0-9_]*$/.test(key) && typeof value === 'string') env[key] = value
  }
  active = { id: task.request_id, started: Date.now(), env }
  touch('progress')
  try {
    if (task.model) {
      const model = ctx.models?.resolve?.(task.model)
      if (!model) throw new Error(`model ${task.model} not found`)
      await pi.setModel(model)
    }
    if (task.thinking) pi.setThinkingLevel(task.thinking)
  } catch (error) {
    finish({ error: `could not configure the worker tab: ${error instanceof Error ? error.message : error}` })
    return
  }
  put('started.json', { request_id: task.request_id })
  pi.sendUserMessage(task.prompt)
}

async function tick(pi: Pi, ctx: Ctx): Promise<void> {
  if (ticking) return
  ticking = true
  try {
    const now = Date.now()
    if (now - lastBeat >= 1000) {
      lastBeat = now
      touch('beat')
    }
    const ready = JSON.stringify({
      pid: process.pid,
      session_id: ctx.sessionManager?.getSessionId?.() ?? null,
      session_file: ctx.sessionManager?.getSessionFile?.() ?? null,
    })
    if (ready !== lastReady) {
      lastReady = ready
      put('ready.json', JSON.parse(ready))
    }
    if (active) {
      if (readJson('abort.json')?.request_id === active.id) {
        unlinkSync(join(TAB!, 'abort.json'))
        ctx.abort?.()
      }
      return
    }
    if (!ctx.isIdle?.() || ctx.hasPendingMessages?.()) return
    try { renameSync(join(TAB!, 'task.json'), join(TAB!, 'task.taken.json')) } catch { return }
    const task = readJson('task.taken.json') as Task | undefined
    if (typeof task?.request_id === 'string' && typeof task.prompt === 'string') await begin(pi, ctx, task)
  } finally {
    ticking = false
  }
}

export default function (pi: Pi): void {
  const routing = registerTeamPolicy(pi, { subagentSpawn: true, onModeChange: render })
  for (const name of ['session_switch', 'session_branch', 'session_tree']) {
    pi.on(name, (_event, ctx) => render(ctx, routing.active(ctx)))
  }
  pi.on('session_start', (_event, ctx) => {
    render(ctx, routing.active(ctx))
    if (!TAB) return
    mkdirSync(TAB, { recursive: true })
    lastReady = ''
    if (timer) ctx.clearTimer?.(timer)
    timer = ctx.setInterval?.(() => { void tick(pi, ctx).catch(() => { ticking = false }) }, 250)
  })
  pi.on('agent_end', (event: never, ctx) => {
    render(ctx, routing.active(ctx)) // refreshes after `init`/`clear` changes the team mid-session
    const { messages, willContinue } = event as { messages?: Message[]; willContinue?: boolean }
    if (TAB && active && !willContinue) finish(assistantOutcome(messages ?? [], active.started))
  })
  for (const name of ['agent_start', 'turn_end', 'message_end', 'tool_execution_end']) pi.on(name, progress)
  pi.on('tool_call', (event: ToolCall, ctx) => {
    const { command } = event.input ?? {}
    if (event.toolName !== 'bash' || typeof command !== 'string') return
    const env = active?.env ?? {}
    const session = ctx?.sessionManager?.getSessionId?.()
    const worker = process.env.TEAM_BUILDING_WORKER
    const teamCommand = command.includes('team-building')
    // The broker omits launch identity from the task env; keep it when addressing a child team.
    const exports = Object.entries({
      ...env,
      ...(teamCommand && typeof session === 'string' && /^[\w-]+$/.test(session) ? { OMP_SESSION_ID: session } : {}),
      ...(teamCommand && worker ? { TEAM_BUILDING_WORKER: worker } : {}),
    }).map(([key, value]) => `export ${key}='${value.replaceAll("'", "'\\''")}'`)
    if (!exports.length) return
    return { input: { ...event.input, command: `${exports.join('; ')}; ${command}` } }
  })
}
