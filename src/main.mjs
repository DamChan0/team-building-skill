#!/usr/bin/env node
import {
  appendFile,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createWriteStream, realpathSync } from 'node:fs';
import { finished } from 'node:stream/promises';
import {
  activeTeams,
  DEFAULT_MAX,
  DEFAULT_TIMEOUT,
  dropPointers,
  exists,
  failed,
  load,
  NOTES_DIR,
  now,
  resolveTeam,
  save,
  STATE_ROOT,
  withLock,
  WORKER_ENV,
  writeResult,
} from './state.mjs';
import {
  agentCommand,
  launchConfig,
  cleanupWorker,
  closeTerminal,
  command,
  configFor,
  OrcaError,
  orca,
  recordSession,
  requireOmp,
  requireOrca,
  shellQuote,
  sleep,
  writeShims,
} from './harness.mjs';
import { classifyRequest, configureRouter, DIFFICULTIES } from './router.mjs';

const MAX_WORKERS = 8;
const WARN_WORKERS = 4;
const POLL_MS = 2_000;
const ACTIVITY_CHECK_MS = 15_000;
let interruption = null;

export function requiresBypass(harness) {
  return harness !== 'omp';
}

function die(message, code = 2) {
  console.error(`team-building: ${message}`);
  process.exitCode = code;
  throw new Error('__team_die__');
}

function workerIndex(id) {
  return Number(id.slice(1));
}

function forbidWorkerManager() {
  if (process.env[WORKER_ENV]) {
    die(`refused: running inside worker ${process.env[WORKER_ENV]}; workers cannot manage teams (no recursion)`);
  }
}

function interrupted() {
  return interruption ? new Error(interruption) : null;
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function reapDeadAssignments(teamDir, data) {
  data.queue = data.queue.filter(entry => processAlive(entry.pid));

  for (const worker of Object.values(data.workers)) {
    if (worker.state !== 'busy' || processAlive(worker.pid) || (worker.child && processAlive(worker.child))) continue;

    await writeResult(teamDir, {
      ...failed(`wrapper process ${worker.pid} died before returning a result`),
      team: data.id,
      worker: worker.id,
      task: worker.task,
      kind: 'task',
      finished: now(),
    });
    Object.assign(worker, {
      state: 'idle',
      task: null,
      task_prompt: null,
      pid: null,
      child: null,
      approval_task: null,
    });
  }
}

function routingError(data, workerId) {
  if (data.model) return '--difficulty cannot be used when the team has a fixed --model; omit it or use assign --model';
  const workers = workerId
    ? [data.workers[workerId]]
    : Object.values(data.workers).filter(worker => !worker.retiring);
  if (!workers.length || workers.some(worker => !worker || workerHarness(worker, data) !== 'omp')) {
    return '--difficulty requires an explicitly selected OMP worker or a team whose eligible workers are all OMP';
  }
  return null;
}

export function chooseWorker(data, task, kind) {
  const taken = new Set();
  const queue = [...data.queue].sort(
    (left, right) => Number(left.worker === null) - Number(right.worker === null),
  );

  for (const entry of queue) {
    let candidate = null;
    let reason = entry.difficulty ? routingError(data, entry.worker) : null;
    if (reason) {
      if (entry.task === task) return ['fail', reason];
      continue;
    }

    if (entry.worker) {
      const worker = data.workers[entry.worker];
      if (!worker) {
        reason = `worker ${entry.worker} does not exist (retired or never spawned)`;
      } else if (worker.retiring && entry.kind !== 'final') {
        reason = `worker ${entry.worker} is being retired`;
      } else if (worker.state === 'idle' && !taken.has(worker.id)) {
        candidate = worker.id;
      }
    } else {
      const liveWorkers = Object.values(data.workers).filter(worker => !worker.retiring);
      if (!liveWorkers.length) {
        reason = 'no active workers left (team is closing or shrunk to zero)';
      } else {
        candidate = liveWorkers
          .filter(worker => worker.state === 'idle' && !taken.has(worker.id))
          .sort((left, right) => (
            left.assignments - right.assignments || workerIndex(left.id) - workerIndex(right.id)
          ))[0]?.id ?? null;
      }
    }

    if (entry.task === task) {
      if (reason) return ['fail', reason];
      if (candidate) return ['take', candidate];
      return ['wait', null];
    }
    if (candidate) taken.add(candidate);
  }

  return ['fail', 'task vanished from queue'];
}

async function newestSessionMtime(worker) {
  const files = await configFor(worker).files(worker);
  const dated = await Promise.all(files.map(async file => ({
    file,
    mtime: (await stat(file)).mtimeMs,
  })));
  return dated.sort((left, right) => right.mtime - left.mtime)[0] || null;
}

async function lastAssistant(worker) {
  const newest = await newestSessionMtime(worker);
  if (!newest) return null;

  const lines = (await readFile(newest.file, 'utf8')).split('\n').reverse();
  for (const line of lines) {
    try {
      const record = JSON.parse(line);
      const message = record.message || record.payload || {};
      if (message.role !== 'assistant' && !['agent_message', 'error'].includes(message.type)) continue;

      if (worker.harness === 'omp') {
        return {
          timestamp: (message.timestamp || 0) / 1_000,
          model: message.model || message.model_id,
          stopReason: message.stopReason,
          errorMessage: message.errorMessage || '',
        };
      }
      if (worker.harness === 'claude') {
        return {
          timestamp: Date.parse(record.timestamp || message.timestamp || '') / 1_000,
          model: message.model,
          stopReason: message.stop_reason,
          errorMessage: message.error || '',
        };
      }
      return { timestamp: 0 };
    } catch {
      // Ignore incomplete JSONL records while a harness is writing them.
    }
  }
  return null;
}

async function terminalCursor(handle, cursor) {
  const args = ['terminal', 'read', '--terminal', handle];
  if (cursor) args.push('--cursor', cursor);
  const response = await orca(...args);
  return response.nextCursor ?? response.next_cursor ?? response.cursor ?? null;
}

export function needsTerminalRestart(worker) {
  const configured = Object.hasOwn(worker, 'terminal_model') || Object.hasOwn(worker, 'terminal_thinking');
  const desired = launchConfig(worker);
  if (!configured) return !!(worker.task_model || worker.task_thinking);
  return (
    worker.terminal_model !== desired.model
    || worker.terminal_thinking !== desired.thinking
  );
}

async function updateWorker(teamDir, worker, fields) {
  await withLock(teamDir, async () => {
    const data = await load(teamDir);
    if (!data.workers[worker.id]) throw new OrcaError(`worker ${worker.id} no longer exists`);
    Object.assign(data.workers[worker.id], fields);
    await save(teamDir, data);
  });
  Object.assign(worker, fields);
}

async function reconnectTerminal(teamDir, worker, worktree) {
  let terminal;
  if (worker.terminal) {
    try {
      const shown = (await orca('terminal', 'show', '--terminal', worker.terminal)).terminal;
      if (shown) terminal = { ...shown, handle: shown.handle || worker.terminal };
    } catch {
      // Handles expire across runtime restarts; recover only the saved PTY/pane.
    }
  }
  const sameTerminal = candidate => (
    !!candidate.handle && (!candidate.worktreePath || resolve(candidate.worktreePath) === resolve(worktree))
    && (!worker.terminal_incarnation_id || candidate.incarnationId === worker.terminal_incarnation_id)
    && (worker.terminal_pty_id
      ? candidate.ptyId === worker.terminal_pty_id
      : worker.terminal_tab_id && worker.terminal_leaf_id
        ? candidate.tabId === worker.terminal_tab_id && candidate.leafId === worker.terminal_leaf_id
        : candidate.handle === worker.terminal)
  );
  if (!terminal || !sameTerminal(terminal) || (terminal.connected === false && !terminal.exited && terminal.exitCode == null)) {
    const inventory = await orca('terminal', 'list', '--worktree', `path:${worktree}`);
    const matches = (inventory.terminals || []).filter(sameTerminal);
    if (matches.length !== 1 || inventory.truncated) {
      throw new OrcaError(`cannot confirm existing terminal for ${worker.id}; refusing a duplicate tab or concurrent session`);
    }
    terminal = matches[0];
  }
  if (terminal.exited || terminal.exitCode != null) {
    await updateWorker(teamDir, worker, { terminal_stopped: true });
    return null;
  }
  if (terminal.connected === false || terminal.writable === false || terminal.orphaned) {
    throw new OrcaError(`worker ${worker.id} terminal is disconnected, not confirmed stopped; refusing a duplicate session`);
  }
  const handle = terminal.handle || worker.terminal;
  await updateWorker(teamDir, worker, {
    terminal: handle,
    terminal_pty_id: terminal.ptyId || worker.terminal_pty_id || null,
    terminal_incarnation_id: terminal.incarnationId || worker.terminal_incarnation_id || null,
    terminal_tab_id: terminal.tabId || worker.terminal_tab_id || null,
    terminal_leaf_id: terminal.leafId || worker.terminal_leaf_id || null,
  });
  return handle;
}

async function stopWorkerTerminal(teamDir, worker, handle, cwd) {
  if (!(await closeTerminal(handle))) throw new OrcaError(`failed to close worker terminal ${handle}; refusing a concurrent resume`);
  await updateWorker(teamDir, worker, { terminal_stopped: true });
  await recordSession(teamDir, worker, cwd, worker.session_started_at || 0);
}

async function ensureTerminal(teamDir, team, worker, cwd, worktree) {
  if (worker.terminal || worker.terminal_started || worker.session_id || worker.session_file) {
    await recordSession(teamDir, worker, cwd, worker.session_started_at || 0);
  }
  if (worker.headless_pending || (worker.child && processAlive(worker.child))) {
    throw new OrcaError(`worker ${worker.id} resume owner is still active or uncertain; refusing a concurrent session`);
  }
  if (worker.terminal_stopped) return null;
  if (worker.terminal_started || worker.terminal) {
    const handle = await reconnectTerminal(teamDir, worker, worktree);
    if (!handle || !needsTerminalRestart(worker)) return handle;
    // Capture a real session before stopping its TUI; never replace it with a new conversation.
    await agentCommand(team, worker, { headless: true, prompt: '' });
    await stopWorkerTerminal(teamDir, worker, handle, cwd);
    return null;
  }
  if (worker.session_file) {
    throw new OrcaError(`worker ${worker.id} has a saved session but no confirmed terminal owner; refusing a duplicate session`);
  }
  const since = Date.now();
  const argv = await agentCommand(team, worker);
  // Persist before create: a lost create response must not trigger another create.
  await updateWorker(teamDir, worker, { terminal_started: true, session_started_at: since });
  const response = await orca(
    'terminal', 'create', '--worktree', `path:${worktree}`, '--title', `${team} ${worker.id}`,
    '--command', `cd ${shellQuote(cwd)} && exec ${argv.map(shellQuote).join(' ')}`,
  );
  const terminal = response.terminal || response;
  if (!terminal.handle) throw new OrcaError('terminal create returned no handle; refusing another create');
  const desired = launchConfig(worker);
  await updateWorker(teamDir, worker, {
    terminal: terminal.handle,
    terminal_pty_id: terminal.ptyId || null,
    terminal_incarnation_id: terminal.incarnationId || null,
    terminal_tab_id: terminal.tabId || null,
    terminal_leaf_id: terminal.leafId || null,
    terminal_model: desired.model,
    terminal_thinking: desired.thinking,
  });
  await orca('terminal', 'wait', '--terminal', terminal.handle, '--for', 'tui-idle', '--timeout-ms', '90000');
  await recordSession(teamDir, worker, cwd, since);
  return terminal.handle;
}

async function runResumed(teamDir, worker, cwd, task, briefPath, timeout, maximum, log) {
  await recordSession(teamDir, worker, cwd);
  const argv = await agentCommand(basename(teamDir), worker, {
    headless: true, prompt: `Assignment ${task}: read ${briefPath} and do it. Continue any unfinished work; do not create or fork a session.`,
  });
  await updateWorker(teamDir, worker, { headless_pending: true });
  const output = createWriteStream(log, { flags: 'a' });
  let outputError;
  output.on('error', error => { outputError = error; });
  let activity = Date.now();
  let outcome;
  const child = spawn(argv[0], argv.slice(1), { cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const exit = new Promise(resolveExit => {
    child.once('error', error => { outcome = { error }; resolveExit(); });
    child.once('close', (code, signal) => { outcome ||= { code, signal }; resolveExit(); });
  });
  for (const stream of [child.stdout, child.stderr]) {
    stream.on('data', () => { activity = Date.now(); });
    stream.pipe(output, { end: false });
  }
  let failure;
  try {
    await updateWorker(teamDir, worker, { child: child.pid || null, headless_pending: false });
    const deadline = Date.now() + maximum * 1_000;
    while (!outcome) {
      if (outputError || interrupted() || Date.now() >= deadline || Date.now() - activity >= timeout * 1_000) {
        failure = outputError?.message || interrupted()?.message || (Date.now() >= deadline ? `max timeout after ${maximum}s` : `idle timeout after ${timeout}s`);
        break;
      }
      await Promise.race([exit, sleep(POLL_MS)]);
    }
  } finally {
    if (!outcome && child.pid) {
      try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
    await exit;
    output.end();
    try { await finished(output); } finally {
      await updateWorker(teamDir, worker, { child: null, headless_pending: false });
    }
  }
  if (failure) return [failed(`${failure}; resumed worker stopped`), null];
  if (outcome.error || outcome.code !== 0) return [failed(`session resume failed: ${outcome.error?.message || outcome.signal || outcome.code}`), null];
  const resultPath = join(teamDir, 'results', `${task}.json`);
  const result = await exists(resultPath) ? resultFrom(await readFile(resultPath, 'utf8')) : null;
  return [result || failed('resumed worker exited without a valid result'), (await lastAssistant(worker))?.model];
}

async function terminalWorktree(teamDir, worker, cwd) {
  const data = await load(teamDir);
  if (data.isolate) {
    if (!worker.worktree) throw new OrcaError(`isolated worker ${worker.id} has no recorded worktree`);
    return worker.worktree;
  }

  const current = await registeredCwd();
  if (!insideWorktree(current, cwd)) {
    throw new OrcaError(`worker cwd ${cwd} is outside current Orca worktree ${current}; return to the team's initialized worktree or initialize a new team there`);
  }
  if (data.worktree) {
    if (resolve(data.worktree) !== resolve(current)) {
      throw new OrcaError(`current Orca worktree ${current} does not match team worktree ${data.worktree}; return to the team's initialized worktree or initialize a new team there`);
    }
    return data.worktree;
  }

  await withLock(teamDir, async () => {
    const latest = await load(teamDir);
    if (!latest.worktree) {
      latest.worktree = current;
      await save(teamDir, latest);
    } else if (resolve(latest.worktree) !== resolve(current)) {
      throw new OrcaError(`current Orca worktree ${current} does not match team worktree ${latest.worktree}; return to the team's initialized worktree or initialize a new team there`);
    }
  });
  return current;
}

async function runTerminal(teamDir, worker, cwd, task, prompt, timeout, maximum, log) {
  const resultPath = join(teamDir, 'results', `${task}.json`);
  const briefPath = join(teamDir, 'briefs', `${task}.md`);
  await mkdir(join(teamDir, 'briefs'), { recursive: true });

  const approval = worker.approval_task
    ? `\nApproved source task: \`${worker.approval_task}\`; exact approved argv are in \`${join(teamDir, 'approvals', `${worker.approval_task}.json`)}\`.\n`
    : '';
  await writeFile(
    briefPath,
    `# [team ${basename(teamDir)} / ${worker.id} / ${task}]\n\n${prompt}${approval}\n---\nWhen finished, write the result JSON object (worker contract) to \`${resultPath}\` (write \`${resultPath}.tmp\`, then rename). That file is the assignment-result channel.\n`,
  );

  const worktree = await terminalWorktree(teamDir, worker, cwd);
  let handle = await ensureTerminal(teamDir, basename(teamDir), worker, cwd, worktree);
  if (!handle) return runResumed(teamDir, worker, cwd, task, briefPath, timeout, maximum, log);
  const cursorBeforeSend = await terminalCursor(handle);
  let cursor = cursorBeforeSend;
  let sessionMtime = (await newestSessionMtime(worker))?.mtime ?? 0;
  await appendFile(log, `[terminal ${handle}] brief ${briefPath}\n`);
  await orca('terminal', 'send', '--terminal', handle, '--text', `Assignment ${task}: read ${briefPath} and do it.`, '--enter');

  const sent = Date.now();
  const deadline = sent + maximum * 1_000;
  let activity = sent;
  let nextActivityCheck = sent + ACTIVITY_CHECK_MS;
  while (true) {
    if (interrupted()) {
      await stopWorkerTerminal(teamDir, worker, handle, cwd);
      return [failed(`interrupted by ${interruption}; worker terminal closed`), null];
    }
    if (await exists(resultPath)) {
      const text = await readFile(resultPath, 'utf8');
      const result = resultFrom(text);
      if (result) {
        await recordSession(teamDir, worker, cwd, worker.session_started_at || 0);
        return [result, (await lastAssistant(worker))?.model];
      }
      if (Date.now() - (await stat(resultPath)).mtimeMs > 5_000) {
        return [
          failed('worker wrote an invalid result file', [`result file tail: ${text.slice(-800)}`]),
          (await lastAssistant(worker))?.model,
        ];
      }
    }

    const current = Date.now();
    if (current >= deadline) {
      await stopWorkerTerminal(teamDir, worker, handle, cwd);
      return [failed(`max timeout after ${maximum}s; worker terminal closed`), (await lastAssistant(worker))?.model];
    }
    if (current >= nextActivityCheck) {
      nextActivityCheck = current + ACTIVITY_CHECK_MS;
      await recordSession(teamDir, worker, cwd, worker.session_started_at || 0);
      const previousHandle = handle;
      handle = await reconnectTerminal(teamDir, worker, worktree);
      if (!handle) return runResumed(teamDir, worker, cwd, task, briefPath, timeout, Math.max(1, Math.ceil((deadline - current) / 1_000)), log);
      if (handle !== previousHandle) cursor = null;
      const nextCursor = await terminalCursor(handle, cursor);
      const nextSessionMtime = (await newestSessionMtime(worker))?.mtime ?? 0;
      if (nextCursor !== cursor || nextSessionMtime > sessionMtime) activity = current;
      cursor = nextCursor;
      sessionMtime = Math.max(sessionMtime, nextSessionMtime);

      const message = await lastAssistant(worker);
      if (message?.timestamp >= sent / 1_000 && ['error', 'aborted'].includes(message.stopReason)) {
        return [failed(`model run ${message.stopReason}: ${message.errorMessage || ''}`.slice(0, 500)), message.model];
      }
    }
    if (current - activity >= timeout * 1_000) {
      await stopWorkerTerminal(teamDir, worker, handle, cwd);
      return [failed(`idle timeout after ${timeout}s; worker terminal closed`), (await lastAssistant(worker))?.model];
    }
    await sleep(POLL_MS);
  }
}

export async function runAssignment(teamDir, preferredWorker, prompt, timeout, maximum, kind = 'task', approval = null, assignment = {}) {
  const started = Date.now();
  const team = basename(teamDir);
  let task;
  let workerId;
  let result;
  let worker;
  let cwd;

  try {
    await withLock(teamDir, async () => {
      const data = await load(teamDir);
      if (assignment.router_family && (
        data.model || data.router?.family !== assignment.router_family
        || data.router?.models?.[assignment.difficulty]?.model !== assignment.model
        || (data.router?.models?.[assignment.difficulty]?.thinking ?? null) !== (assignment.thinking ?? null)
      )) throw new Error('router configuration changed during classification; assignment not started');
      const finalWorker = kind === 'final' && data.workers[preferredWorker];
      if (finalWorker) {
        assignment.model ??= finalWorker.task_model || finalWorker.last_route?.model || finalWorker.resolved_model || finalWorker.model;
        assignment.thinking ??= finalWorker.task_thinking ?? finalWorker.last_route?.thinking ?? null;
      }
      await mkdir(join(teamDir, 'approvals'), { recursive: true });
      await writeShims(teamDir, data);
      task = `t${String(data.next_task++).padStart(3, '0')}`;
      data.queue.push({
        task,
        worker: preferredWorker || null,
        kind,
        prompt: prompt.slice(0, 120),
        queued: now(),
        pid: process.pid,
        approval,
        model: assignment.model || null,
        thinking: assignment.thinking ?? null,
        difficulty: assignment.difficulty || null,
        intent: assignment.intent || null,
      });
      await save(teamDir, data);
    });

    while (!result) {
      if (interrupted()) throw interrupted();
      const [action, detail] = await withLock(teamDir, async () => {
        const data = await load(teamDir);
        await reapDeadAssignments(teamDir, data);
        const decision = chooseWorker(data, task, kind);
        const entry = data.queue.find(item => item.task === task);
        if (decision[0] !== 'wait') data.queue = data.queue.filter(item => item.task !== task);
        if (decision[0] === 'take') {
          workerId = decision[1];
          Object.assign(data.workers[workerId], {
            state: 'busy',
            task,
            task_prompt: prompt.slice(0, 120),
            pid: process.pid,
            approval_task: approval,
            task_model: entry.model,
            task_thinking: entry.thinking,
            task_difficulty: entry.difficulty,
            task_intent: entry.intent,
          });
          worker = { ...data.workers[workerId] };
          cwd = worker.cwd || data.cwd;
        }
        await save(teamDir, data);
        return decision;
      });

      if (action === 'fail') {
        result = failed(`not started: ${detail}`);
      } else if (action === 'take') {
        break;
      } else {
        await sleep(1_000);
      }
    }

    if (!result) {
      await appendFile(
        worker.log,
        `\n=== ${task} ${kind} start ${now()} model=${launchConfig(worker).model || 'omp default'} difficulty=${worker.task_difficulty || 'manual'} intent=${JSON.stringify(worker.task_intent || null)} router=${assignment.router_model || 'manual'} ===\n${prompt}\n--- output ---\n`,
      );
      const [workerResult, model] = await runTerminal(teamDir, worker, cwd, task, prompt, timeout, maximum, worker.log);
      result = workerResult;
      result.model = model || worker.task_model || worker.model;
      result.difficulty = worker.task_difficulty || null;
    }
  } catch (error) {
    const message = error instanceof OrcaError
      ? `orca: ${error.message.split('\n')[0]}`
      : `helper crashed or was interrupted: ${error.message || error}`;
    result = failed(message);
  }

  if (task) {
    await withLock(teamDir, async () => {
      const data = await load(teamDir);
      data.queue = data.queue.filter(entry => entry.task !== task);
      const assignedWorker = workerId && data.workers[workerId];
      if (assignedWorker && assignedWorker.task === task) {
        Object.assign(assignedWorker, {
          state: 'idle',
          task: null,
          task_prompt: null,
          pid: null,
          child: null,
          approval_task: null,
          task_model: null,
          task_thinking: null,
          task_difficulty: null,
          task_intent: null,
        });
        assignedWorker.assignments++;
        assignedWorker.resolved_model = result.model || assignedWorker.resolved_model;
        if (kind === 'task') assignedWorker.last_route = {
          intent: assignment.intent || null,
          difficulty: assignment.difficulty || null,
          model: assignment.model || assignedWorker.model || result.model,
          thinking: assignment.thinking ?? null,
          router_model: assignment.router_model || null,
          duration_ms: assignment.router_duration_ms ?? null,
        };
      }
      await save(teamDir, data);
    });
  }

  Object.assign(result, {
    team,
    worker: workerId,
    task,
    kind,
    difficulty: result.difficulty || worker?.task_difficulty || null,
    intent: assignment.intent || null,
    router_model: assignment.router_model || null,
    router_duration_ms: assignment.router_duration_ms ?? null,
    duration_s: Math.round((Date.now() - started) / 100) / 10,
    finished: now(),
  });
  if (workerId) result.log = join(teamDir, 'logs', `${workerId}.log`);
  await writeResult(teamDir, result).catch(() => {});
  return result;
}

function printResult(result) {
  console.log(`[${result.team}] ${result.worker || '-'} ${result.task} ${result.status} (${result.model || 'model n/a'}, ${result.duration_s}s): ${result.summary.slice(0, 200)}`);
  console.log(JSON.stringify(result, null, 2));
}

function newWorker(teamDir, data, harness, cwd) {
  const id = `w${data.next_worker++}`;
  const selectedHarness = harness || data.harness || 'omp';
  data.workers[id] = {
    id,
    model: data.model || data.router?.worker_model || null,
    resolved_model: null,
    state: 'idle',
    task: null,
    task_prompt: null,
    pid: null,
    retiring: false,
    assignments: 0,
    session_dir: join(teamDir, 'sessions', id),
    log: join(teamDir, 'logs', `${id}.log`),
    harness: selectedHarness,
    session_id: configFor({ harness: selectedHarness }).session(),
    session_file: null,
    cwd: cwd || data.cwd,
    worktree: null,
    terminal_started: false,
    terminal_stopped: false,
    approval_task: null,
  };
  return id;
}

export async function show(teamDir) {
  let data;
  await withLock(teamDir, async () => {
    data = await load(teamDir);
    await reapDeadAssignments(teamDir, data);
    await save(teamDir, data);
  });

  console.log(`team ${data.id}  cwd=${data.cwd}  model=${data.model || 'routed/default'}  router=${data.router?.enabled ? data.router.family : 'off'}  state=${teamDir}`);
  if (data.router?.enabled) {
    console.log(`  classifier=${data.router.classifier} checked=${data.router.checked_at} simple=${data.router.models.simple.model} moderate=${data.router.models.moderate.model} complex=${data.router.models.complex.model} extreme=${data.router.models.extreme?.model || 'init required'}${data.router.models.extreme?.thinking ? ` thinking=${data.router.models.extreme.thinking}` : ''}`);
  }
  for (const worker of Object.values(data.workers).sort((left, right) => workerIndex(left.id) - workerIndex(right.id))) {
    let model = worker.model || 'omp default';
    if (worker.resolved_model) model += ` -> ${worker.resolved_model}`;
    const state = worker.state + (worker.retiring ? ' retiring' : '');
    const task = worker.task ? `${worker.task}: ${JSON.stringify(worker.task_prompt)}${worker.task_difficulty ? ` difficulty=${worker.task_difficulty}` : ''}${worker.task_model ? ` model=${worker.task_model}${worker.task_thinking ? ` thinking=${worker.task_thinking}` : ''}` : ''}` : '-';
    console.log(`  ${worker.id.padEnd(4)} ${state.padEnd(14)} harness=${worker.harness || 'omp'} model=${model}  session=${worker.session_id || 'pending'} transport=${worker.terminal_stopped ? 'headless-resume' : 'orca'} terminal=${worker.terminal || '-'}  assignments=${worker.assignments}  task=${task}  log=${worker.log}`);
  }
  for (const entry of data.queue) {
    const route = entry.difficulty ? ` difficulty=${entry.difficulty} model=${entry.model}` : entry.model ? ` model=${entry.model}` : '';
    console.log(`  queued ${entry.task} worker=${entry.worker || 'any'} kind=${entry.kind}${route} prompt=${JSON.stringify(entry.prompt)}`);
  }
}

async function registeredCwd() {
  const program = process.env.ORCA_CLI_COMMAND || 'orca-ide';
  const result = await command(program, ['worktree', 'current', '--json']);
  let response;
  try {
    response = JSON.parse(result.out);
  } catch {
    die('Orca is not available; start Orca (`orca-ide open`) and retry.', 4);
  }

  const root = response.ok && response.result?.worktree?.path;
  if (root) return root;
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
}

function insideWorktree(worktree, cwd) {
  const path = relative(resolve(worktree), resolve(cwd));
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

async function gitOutput(args, cwd) {
  const result = await command('git', args, { cwd });
  return [result.code, result.out.trim()];
}

export async function isolatedCwd(data, workerId) {
  const [rootCode, root] = await gitOutput(['rev-parse', '--show-toplevel'], data.cwd);
  if (rootCode) die('--isolate requires a git repository cwd', 2);
  const [headCode, base] = await gitOutput(['rev-parse', 'HEAD'], data.cwd);
  if (headCode) die('--isolate requires a repository with HEAD', 2);

  const response = await orca(
    'worktree',
    'create',
    '--repo',
    `path:${data.cwd}`,
    '--name',
    `${data.id}-${workerId}`,
    '--base-branch',
    base,
    '--setup',
    'skip',
    '--no-parent',
  );
  const worktree = JSON.stringify(response).match(/"path"\s*:\s*"([^"]+)"/)?.[1];
  if (!worktree) throw new OrcaError('orca worktree create returned no path');

  const nested = relative(root, data.cwd);
  return [worktree, join(worktree, nested === '.' ? '' : nested)];
}

export async function removeIsolated(data, worker) {
  if (!data.isolate || !worker.worktree || !worker.cwd) return null;

  const [statusCode, dirty] = await gitOutput(['status', '--porcelain'], worker.cwd);
  const [branchCode, branch] = await gitOutput(['branch', '--show-current'], worker.cwd);
  const [merged] = branchCode === 0 && branch
    ? await gitOutput(['merge-base', '--is-ancestor', branch, 'HEAD'], data.cwd)
    : [1];

  if (statusCode === 0 && !dirty && merged === 0) {
    try {
      await orca('worktree', 'rm', '--worktree', `path:${worker.worktree}`);
      return `removed isolated worktree ${worker.worktree} (${branch})`;
    } catch (error) {
      return `left isolated worktree ${worker.worktree} (${branch}): ${error.message}`;
    }
  }
  return `left isolated worktree ${worker.worktree} (${branch || 'unknown branch'}): not clean or not merged`;
}

async function rollbackIsolated(data) {
  await Promise.all(Object.values(data.workers).map(async worker => {
    if (worker.worktree) await orca('worktree', 'rm', '--worktree', `path:${worker.worktree}`).catch(() => {});
  }));
}

async function retire(teamDir, ids, timeout, maximum) {
  let workers;
  await withLock(teamDir, async () => {
    const data = await load(teamDir);
    for (const id of ids) data.workers[id].retiring = true;
    await save(teamDir, data);
    workers = Object.fromEntries(ids.map(id => [id, { ...data.workers[id] }]));
  });

  const finals = {};
  await Promise.all(ids.map(async id => {
    const worker = workers[id];
    finals[id] = worker.state === 'busy' || (await configFor(worker).files(worker)).length
      ? await runAssignment(teamDir, id, 'Wrap-up: this worker is being shut down. Do not start new work. Return a final summary of ALL work you did across every assignment in this team (what was done, files changed, verification, open issues) in the required JSON block. Use status succeeded unless something you were given is unfinished (then blocked or failed).', timeout, maximum, 'final')
      : {
        status: 'succeeded', summary: 'no assignments; nothing to summarise', files_changed: [], files_deleted: [], verification: '', blockers: [], team: basename(teamDir), worker: id, kind: 'final',
      };
    await writeFile(join(teamDir, 'results', `${id}-final.json`), JSON.stringify(finals[id], null, 2));
  }));

  await withLock(teamDir, async () => {
    const data = await load(teamDir);
    for (const id of ids) {
      await cleanupWorker(workers[id]);
      await closeTerminal(data.workers[id]?.terminal);
      delete data.workers[id];
    }
    await save(teamDir, data);
  });
  return finals;
}

async function init(args) {
  forbidWorkerManager();
  if (args.member !== undefined && (!Number.isInteger(args.member) || args.member < 1 || args.member > MAX_WORKERS)) {
    die(`member must be 1..${MAX_WORKERS} (task.maxConcurrency)`);
  }
  const selectedFamily = args.family || (['gpt', 'claude'].includes(args.model) ? args.model : null);
  if (args.family && args.model && args.family !== args.model) die(`conflicting family ${args.family} and --model ${args.model}`);
  const familySelected = !!selectedFamily;
  const fixedModel = familySelected ? null : args.model || null;
  const harness = args.harness || 'omp';
  if (familySelected && harness !== 'omp') die('gpt/claude family routing requires --harness omp; the family selects models, not the harness');
  if (harness === 'omp') await requireOmp(die);
  if (requiresBypass(harness) && !args.allowBypass) {
    die(`--harness ${harness} requires explicit --allow-bypass (it enables ${configFor({ harness }).bypass})`, 3);
  }

  let approvalMode = null;
  if (harness === 'omp') {
    approvalMode = (await command('omp', ['config', 'get', 'tools.approvalMode'])).out.trim();
    if (approvalMode !== 'yolo') {
      die(`tools.approvalMode is ${JSON.stringify(approvalMode)}; omp workers need yolo because nobody can answer their prompts.`, 3);
    }
  }

  const teams = await activeTeams();
  if (teams.length && !args.new) {
    if (!args.team && teams.length > 1) {
      await status(args);
      console.log('several teams active: rerun `init --team <id>` to adopt one, or `init --new` for a new team');
      return;
    }
    const teamDir = await resolveTeam(args.team, die);
    console.log(`adopted existing team ${basename(teamDir)} (no new team; \`init --new\` creates one)`);
    const current = await load(teamDir);
    const ompOnly = Object.values(current.workers).filter(worker => !worker.retiring).every(worker => workerHarness(worker, current) === 'omp');
    if (familySelected && !ompOnly) die('family routing requires OMP workers; cannot change the harness of existing sessions');
    if (!fixedModel && ompOnly && (familySelected || !current.model)) {
      const family = familySelected ? selectedFamily : current.router?.family || 'gpt';
      const changesFamily = data => data.model || (data.router?.family || null) !== family;
      const rejectBusyChange = data => {
        if (changesFamily(data) && (data.queue.length || Object.values(data.workers).some(worker => worker.state === 'busy'))) {
          die('cannot change router family while assignments are busy or queued; wait for this team to become idle');
        }
      };
      rejectBusyChange(current);
      const router = await configureRouter(family);
      await withLock(teamDir, async () => {
        const data = await load(teamDir);
        rejectBusyChange(data);
        if (data.closing) die('team is being cleared');
        if (Object.values(data.workers).some(worker => workerHarness(worker, data) !== 'omp')) die('family routing requires OMP workers');
        data.router = router;
        data.model = null;
        for (const worker of Object.values(data.workers)) worker.model = router.worker_model;
        await save(teamDir, data);
      });
    }
    if (args.member || fixedModel) {
      return member({ ...args, model: fixedModel, n: args.member || Object.keys(current.workers).length, team: basename(teamDir) });
    }
    return show(teamDir);
  }

  const worktree = await registeredCwd();
  if (!args.isolate && !insideWorktree(worktree, process.cwd())) {
    die(`manager cwd ${process.cwd()} is outside active Orca worktree ${worktree}; return to that worktree or initialize a new team there`, 4);
  }
  if (args.isolate && (await gitOutput(['rev-parse', '--show-toplevel'], process.cwd()))[0]) {
    die('--isolate requires a git repository cwd', 2);
  }
  if (args.isolate && (await gitOutput(['status', '--porcelain'], process.cwd()))[1]) {
    console.error('team-building: warning: uncommitted manager changes are not copied into isolated worker worktrees');
  }
  const router = harness === 'omp' && !fixedModel
    ? await configureRouter(selectedFamily || 'gpt')
    : null;

  const stamp = new Date();
  const id = `tb-${String(stamp.getMonth() + 1).padStart(2, '0')}${String(stamp.getDate()).padStart(2, '0')}-${String(stamp.getHours()).padStart(2, '0')}${String(stamp.getMinutes()).padStart(2, '0')}${String(stamp.getSeconds()).padStart(2, '0')}`;
  const teamDir = join(STATE_ROOT, id);
  for (const subdir of ['sessions', 'logs', 'results', 'approvals']) {
    await mkdir(join(teamDir, subdir), { recursive: true });
  }

  const data = {
    id,
    created: now(),
    cwd: process.cwd(),
    worktree,
    model: fixedModel,
    router,
    harness,
    approval_mode: approvalMode,
    next_task: 1,
    next_worker: 1,
    closing: false,
    workers: {},
    queue: [],
    isolate: !!args.isolate,
  };
  await writeShims(teamDir, data);
  try {
    for (let index = 0; index < (args.member || 3); index++) {
      const workerId = `w${data.next_worker}`;
      const [workerWorktree, cwd] = data.isolate ? await isolatedCwd(data, workerId) : [null, null];
      newWorker(teamDir, data, null, cwd);
      data.workers[workerId].worktree = workerWorktree;
    }
  } catch (error) {
    await rollbackIsolated(data);
    await rm(teamDir, { recursive: true, force: true });
    die(`orca: ${error.message.split('\n')[0]}`, 4);
  }

  await save(teamDir, data);
  console.log(`team ${id} ready: ${args.member || 3} workers, harness=${harness}, model=${fixedModel || 'automatic'}, router=${router?.family || 'off'}, cwd=${data.cwd}`);
  await show(teamDir);
}

async function member(args) {
  forbidWorkerManager();
  if (['gpt', 'claude'].includes(args.model)) die('select a model family with init --model gpt|claude, not member --model');
  if (!Number.isInteger(args.n) || args.n < 1 || args.n > MAX_WORKERS) die(`member must be 1..${MAX_WORKERS} (task.maxConcurrency)`);

  const teamDir = await resolveTeam(args.team, die);
  let retirees = [];
  let removed = {};
  let data;
  await withLock(teamDir, async () => {
    data = await load(teamDir);
    if (data.closing) die('team is being cleared');

    const effectiveHarness = args.harness || data.harness || 'omp';
    const liveWorkers = Object.values(data.workers)
      .filter(worker => !worker.retiring)
      .sort((left, right) => workerIndex(left.id) - workerIndex(right.id));
    const growing = args.n > liveWorkers.length;
    if (requiresBypass(effectiveHarness) && !args.allowBypass && (args.harness || growing)) {
      die(`--harness ${effectiveHarness} requires explicit --allow-bypass (it enables ${configFor({ harness: effectiveHarness }).bypass})`, 3);
    }
    if (args.model) {
      data.model = args.model;
      data.router = null;
    }
    if (growing) {
      for (let index = liveWorkers.length; index < args.n; index++) {
        const workerId = `w${data.next_worker}`;
        const [workerWorktree, cwd] = data.isolate ? await isolatedCwd(data, workerId) : [null, null];
        newWorker(teamDir, data, args.harness, cwd);
        data.workers[workerId].worktree = workerWorktree;
      }
    } else if (args.n < liveWorkers.length) {
      retirees = [...liveWorkers]
        .sort((left, right) => Number(left.state !== 'idle') - Number(right.state !== 'idle') || workerIndex(right.id) - workerIndex(left.id))
        .slice(0, liveWorkers.length - args.n)
        .map(worker => worker.id);
      removed = Object.fromEntries(retirees.map(id => [id, { ...data.workers[id] }]));
    }

    if (args.model) {
      for (const worker of liveWorkers) {
        if (!retirees.includes(worker.id)) worker.model = args.model;
      }
    }
    await save(teamDir, data);
  });

  if (retirees.length) {
    const finals = await retire(teamDir, retirees, args.timeout, args.max);
    for (const [id, result] of Object.entries(finals)) {
      console.log(`  ${id} final ${result.status}: ${result.summary.slice(0, 200)}`);
      const note = await removeIsolated(data, removed[id]);
      if (note) console.log(`  ${note}`);
    }
  }
  await show(teamDir);
}

async function status(args) {
  const teams = await activeTeams();
  if (args.team || teams.length < 2) return show(await resolveTeam(args.team, die));

  console.log(`${teams.length} teams active; pass --team <id> to the other commands:`);
  for (const teamDir of teams) await show(teamDir);
}

async function readPrompt(prompt) {
  if (prompt !== undefined && prompt !== '-') return prompt;
  return new Promise(resolvePrompt => {
    let value = '';
    process.stdin.on('data', chunk => { value += chunk; });
    process.stdin.on('end', () => resolvePrompt(value));
  });
}

function workerHarness(worker, team) {
  return worker.harness || team.harness || 'omp';
}

export function routedAssignment(data, args) {
  if (!args.difficulty || args.model) return args.model ? { model: args.model } : {};
  const error = routingError(data, args.worker);
  if (error) die(error);
  const selected = data.router?.models?.[args.difficulty];
  if (!selected) die('router model catalog is missing; run init --model gpt|claude');
  return { ...selected, difficulty: args.difficulty };
}

async function assign(args) {
  forbidWorkerManager();
  const teamDir = await resolveTeam(args.team, die);
  const prompt = await readPrompt(args.prompt);
  if (!prompt.trim()) die('empty prompt');
  if (args.approval && !/^t\d{3}$/.test(args.approval)) die('--approval must name a source task such as t001');

  if (args.approval) {
    await withLock(teamDir, async () => {
      const data = await load(teamDir);
      const approvalPath = join(teamDir, 'approvals', `${args.approval}.json`);
      if (!(await exists(approvalPath))) die(`approval ${args.approval} does not exist`);
      const worker = JSON.parse(await readFile(approvalPath, 'utf8')).worker;
      if (!data.workers[worker]) die(`approval ${args.approval} belongs to unknown worker ${JSON.stringify(worker)}`);
      if (args.worker && args.worker !== worker) die(`approval ${args.approval} belongs to ${worker}, not ${args.worker}`);
      args.worker = worker;
    });
  }

  await requireOrca(die);
  let data = await load(teamDir);
  const automatic = data.router?.enabled && !data.model && !args.model && !args.difficulty;
  if (automatic || (args.difficulty && !args.model)) {
    const error = routingError(data, args.worker);
    if (error) die(error);
  }
  if (args.difficulty && !args.model && !data.model && !data.router) {
    const router = await configureRouter('gpt', { refresh: false });
    router.enabled = false;
    await withLock(teamDir, async () => {
      data = await load(teamDir);
      if (!data.model && !data.router) {
        data.router = router;
        await save(teamDir, data);
      }
    });
  }
  let assignment;
  if (automatic) {
    const started = Date.now();
    assignment = await classifyRequest(data.router, prompt, { cwd: data.cwd });
    assignment.router_duration_ms = Date.now() - started;
    console.log(`route ${data.router.family}: ${assignment.difficulty} model=${assignment.model} intent=${JSON.stringify(assignment.intent)} (${assignment.router_duration_ms}ms)`);
  } else {
    assignment = routedAssignment(data, args);
  }
  if (assignment.difficulty && data.router?.family) assignment.router_family = data.router.family;
  if (interrupted()) throw interrupted();
  printResult(await runAssignment(teamDir, args.worker, prompt, args.timeout, args.max, 'task', args.approval, assignment));
}

async function approve(args) {
  forbidWorkerManager();
  const teamDir = await resolveTeam(args.team, die);
  if (!/^w\d+$/.test(args.worker) || !/^t\d{3}$/.test(args.task) || !args.command.length) {
    die('approve requires --worker wN --task tNNN -- <command...>');
  }

  await withLock(teamDir, async () => {
    const data = await load(teamDir);
    if (!data.workers[args.worker]) die(`worker ${args.worker} does not exist`);
    await mkdir(join(teamDir, 'approvals'), { recursive: true });
    await writeShims(teamDir, data);

    const approvalPath = join(teamDir, 'approvals', `${args.task}.json`);
    const resultPath = join(teamDir, 'results', `${args.task}.json`);
    if (await exists(resultPath) && JSON.parse(await readFile(resultPath, 'utf8')).worker !== args.worker) {
      die(`task ${args.task} belongs to another worker`);
    }
    const approval = await exists(approvalPath)
      ? JSON.parse(await readFile(approvalPath, 'utf8'))
      : { task: args.task, worker: args.worker, commands: [] };
    if (approval.worker !== args.worker) die(`task ${args.task} approval belongs to ${approval.worker}`);
    if (!approval.commands.some(entry => JSON.stringify(entry) === JSON.stringify(args.command))) {
      approval.commands.push(args.command);
    }
    await writeFile(`${approvalPath}.tmp`, JSON.stringify(approval, null, 2));
    await rename(`${approvalPath}.tmp`, approvalPath);
    await save(teamDir, data);
  });
  console.log(`approved ${args.command.join(' ')} for ${args.worker} source task ${args.task}: ${join(teamDir, 'approvals', `${args.task}.json`)}`);
}

function tableCell(value) {
  return String(value ?? '').replaceAll('|', '\\|').replaceAll('\n', ' ');
}

async function clear(args) {
  forbidWorkerManager();
  const teamDir = await resolveTeam(args.team, die);
  let data;
  await withLock(teamDir, async () => {
    data = await load(teamDir);
    data.closing = true;
    await save(teamDir, data);
  });

  const finals = await retire(teamDir, Object.keys(data.workers), args.timeout, args.max);
  const worktrees = (await Promise.all(Object.values(data.workers).map(worker => removeIsolated(data, worker)))).filter(Boolean);
  for (const file of (await readdir(join(teamDir, 'results'))).filter(name => /^w\d+-final\.json$/.test(name)).sort()) {
    finals[file.replace('-final.json', '')] = JSON.parse(await readFile(join(teamDir, 'results', file), 'utf8'));
  }
  const history = [];
  for (const file of (await readdir(join(teamDir, 'results'))).filter(name => /^t\d+\.json$/.test(name)).sort()) {
    history.push(JSON.parse(await readFile(join(teamDir, 'results', file), 'utf8')));
  }

  const lines = [
    `# team-building ${data.id} — final summary`,
    '',
    `- created: ${data.created}  cleared: ${now()}`,
    `- cwd: \`${data.cwd}\``,
    `- default harness: ${data.harness || 'omp'}; model: ${data.model || 'harness default'}`,
    '',
    '## Worktrees',
    ...(worktrees.length ? worktrees.map(note => `- ${note}`) : ['- shared cwd']),
    '',
    '## Worker final summaries',
    '',
  ];
  for (const id of Object.keys(finals).sort((left, right) => workerIndex(left) - workerIndex(right))) {
    const result = finals[id];
    lines.push(
      `### ${id} — ${result.status} (${result.model || 'n/a'})`, '', result.summary || '(empty)', '',
      `- files_changed: ${(result.files_changed || []).join(', ') || '-'}`,
      `- files_deleted: ${(result.files_deleted || []).join(', ') || '-'}`,
      `- verification: ${result.verification || '-'}`,
      `- blockers: ${(result.blockers || []).join('; ') || '-'}`,
      '',
    );
  }
  lines.push(
    '## Assignment log',
    '',
    '|task|worker|kind|status|model|summary|files_changed|files_deleted|blockers|',
    '|---|---|---|---|---|---|---|---|---|',
  );
  for (const result of history) {
    lines.push(`|${[
      result.task,
      result.worker,
      result.kind,
      result.status,
      result.model || '-',
      result.summary,
      (result.files_changed || []).join(', '),
      (result.files_deleted || []).join(', '),
      (result.blockers || []).join('; '),
    ].map(tableCell).join('|')}|`);
  }

  await mkdir(NOTES_DIR, { recursive: true });
  const report = join(NOTES_DIR, `${new Date().toISOString().slice(0, 10)}-${data.id}.md`);
  await writeFile(report, `${lines.join('\n')}\n`);
  await withLock(teamDir, async () => {
    await dropPointers(teamDir);
    await rm(teamDir, { recursive: true, force: true });
  });

  for (const [id, result] of Object.entries(finals).sort(([left], [right]) => workerIndex(left) - workerIndex(right))) {
    console.log(`  ${id} final ${result.status}: ${result.summary.slice(0, 200)}`);
  }
  console.log(`team ${data.id} cleared; state removed (${teamDir}); summary: ${report}`);
}

function usage() {
  console.log(`usage: node src/main.mjs {init,member,status,assign,approve,clear} [options]

team-building helper: persistent harness-neutral workers driven by one manager session.

Commands:
  init [gpt|claude] [--model gpt|claude|MODEL] [--member N] [--harness omp|claude|codex] [--allow-bypass] [--isolate] [--new]
  member N [--model MODEL] [--harness omp|claude|codex] [--allow-bypass]
  status
  assign [--worker wN] [--approval tNNN] [--model MODEL] [--difficulty simple|moderate|complex|extreme] [PROMPT]
  approve --worker wN --task tNNN -- COMMAND...
  clear

Common options: --team ID --timeout SECONDS --max SECONDS`);
}

export function parseArgs(argv) {
  const args = { timeout: DEFAULT_TIMEOUT, max: DEFAULT_MAX };
  const take = (index, name) => {
    if (index + 1 >= argv.length) die(`${name} requires a value`);
    return argv[index + 1];
  };

  let index = 0;
  for (; index < argv.length && argv[index].startsWith('-'); index++) {
    const option = argv[index];
    if (option === '--help' || option === '-h') {
      args.help = true;
    } else if (option === '--team') {
      args.team = take(index, '--team');
      index++;
    } else if (option === '--timeout') {
      args.timeout = Number(take(index, '--timeout'));
      index++;
    } else if (option === '--max') {
      args.max = Number(take(index, '--max'));
      index++;
    } else {
      break;
    }
  }

  args.cmd = argv[index++];
  if (!args.cmd) return { ...args, help: true };

  for (; index < argv.length; index++) {
    const option = argv[index];
    if (option === '--team') {
      args.team = take(index, '--team');
      index++;
    } else if (option === '--timeout') {
      args.timeout = Number(take(index, '--timeout'));
      index++;
    } else if (option === '--max') {
      args.max = Number(take(index, '--max'));
      index++;
    } else if (option === '--model') {
      args.model = take(index, '--model');
      index++;
    } else if (option === '--member') {
      args.member = Number(take(index, '--member'));
      index++;
    } else if (option === '--difficulty') {
      args.difficulty = take(index, '--difficulty');
      index++;
      if (!DIFFICULTIES.includes(args.difficulty)) die(`invalid difficulty: ${args.difficulty} (choose ${DIFFICULTIES.join(', ')})`);
    } else if (option === '--harness') {
      args.harness = take(index, '--harness');
      index++;
      if (!['omp', 'claude', 'codex'].includes(args.harness)) die(`invalid choice: ${args.harness}`);
    } else if (option === '--allow-bypass') {
      args.allowBypass = true;
    } else if (option === '--isolate') {
      args.isolate = true;
    } else if (option === '--new') {
      args.new = true;
    } else if (option === '--worker') {
      args.worker = take(index, '--worker');
      index++;
    } else if (option === '--approval') {
      args.approval = take(index, '--approval');
      index++;
    } else if (option === '--task') {
      args.task = take(index, '--task');
      index++;
    } else if (option === '--') {
      args.command = argv.slice(index + 1);
      break;
    } else if (option === '-' && args.cmd === 'assign' && args.prompt === undefined) {
      args.prompt = option;
    } else if (option.startsWith('-')) {
      die(`unrecognized argument ${option}`);
    } else if (args.cmd === 'member' && !args.n) {
      args.n = Number(option);
    } else if (args.cmd === 'approve') {
      args.command = argv.slice(index);
      break;
    } else if (args.cmd === 'assign' && args.prompt === undefined) {
      args.prompt = option;
    } else if (args.cmd === 'init' && !args.family && ['gpt', 'claude'].includes(option)) {
      args.family = option;
    } else {
      die(`unexpected argument ${option}`);
    }
  }

  args.command ??= [];
  if (!Number.isInteger(args.timeout) || !Number.isInteger(args.max)) die('--timeout and --max must be integers');
  return args;
}

function installSignalHandlers() {
  for (const signal of ['SIGTERM', 'SIGHUP', 'SIGINT']) {
    process.on(signal, () => {
      interruption ||= signal;
      process.exitCode ||= 130;
    });
  }
}

async function main() {
  installSignalHandlers();
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    usage();
    return;
  }

  await mkdir(STATE_ROOT, { recursive: true });
  const action = { init, member, status, assign, approve, clear }[args.cmd];
  if (!action) {
    usage();
    die(`invalid command ${args.cmd}`);
  }
  await action(args);
}

const modulePath = realpathSync(fileURLToPath(import.meta.url));
const invokedPath = process.argv[1] && realpathSync(process.argv[1]);
if (invokedPath && modulePath === invokedPath) {
  main().catch(error => {
    if (error.message !== '__team_die__') console.error(`team-building: ${error.message}`);
    if (!process.exitCode) process.exitCode = 2;
  });
}

function balancedJsonObjects(text) {
  const objects = [];
  const starts = [];
  let quoted = false;
  let escaped = false;

  for (let index = 0; index < text.length; index++) {
    const character = text[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') quoted = false;
      continue;
    }
    if (character === '"') {
      quoted = true;
    } else if (character === '{') {
      starts.push(index);
    } else if (character === '}' && starts.length) {
      objects.push(text.slice(starts.pop(), index + 1));
    }
  }
  return objects.reverse();
}

export function resultFrom(text) {
  for (const candidate of balancedJsonObjects(text)) {
    try {
      const value = JSON.parse(candidate);
      if (!['succeeded', 'failed', 'blocked'].includes(value.status)) continue;
      const list = item => item == null || item === '' ? [] : Array.isArray(item) ? item.map(String) : [String(item)];
      return {
        status: value.status,
        summary: String(value.summary || '').trim(),
        files_changed: list(value.files_changed),
        files_deleted: list(value.files_deleted),
        verification: Array.isArray(value.verification) ? value.verification.join('; ') : String(value.verification || ''),
        blockers: list(value.blockers),
        approval_requests: Array.isArray(value.approval_requests) ? value.approval_requests : [],
        branch: String(value.branch || ''),
        commit: String(value.commit || ''),
      };
    } catch {
      // Continue looking for the last valid worker result.
    }
  }
  return null;
}
