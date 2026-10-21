#!/usr/bin/env node
import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
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
  backendName,
  WORKER_ENV,
  writeResult,
} from './state.mjs';
import {
  cleanupWorker,
  command,
  configFor,
  OrcaError,
  requireOmp,
  shellQuote,
  writeShims,
  nativeTask,
  ompTabCommand,
  tabDir,
} from './harness.mjs';
import { MUXES, muxOf } from './mux.mjs';
import { connectSupervisor, supervisorBinary } from './supervisor.mjs';
import { classifyRequest, configureRouter, DIFFICULTIES } from './router.mjs';

const MAX_WORKERS = 8;
const WARN_WORKERS = 4;
let interruption = null;

export function requiresBypass(harness) {
  return harness !== 'omp';
}

function die(message, code = 2) {
  console.error(`team-building: ${message}`);
  process.exitCode = code;
  throw new Error('__team_die__');
}

// A team stays bound to the backend it was created under; its handles mean nothing elsewhere.
function backendMismatchError(data) {
  const recorded = data.backend || 'orca';
  if (recorded === backendName()) return null;
  return `team ${data.id} was created under ${recorded}; run it from ${recorded === 'herdr' ? 'a herdr pane' : 'Orca (not inside a herdr pane)'}`;
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


function routingError(data, workerId) {
  if (data.model) return '--difficulty cannot be used when the team has a fixed --model; omit it or use assign --model';
  if (workerId) {
    const worker = data.workers[workerId];
    return !worker || workerHarness(worker, data) !== 'omp'
      ? '--difficulty requires an OMP worker'
      : null;
  }
  return Object.values(data.workers).some(worker => !worker.retiring && workerHarness(worker, data) === 'omp')
    ? null
    : '--difficulty requires an available OMP worker';
}

export function chooseWorker(data, task, kind) {
  const entry = data.queue.find(item => item.task === task);
  if (!entry) return ['fail', 'task vanished from queue'];
  if (entry.difficulty) {
    const reason = routingError(data, entry.worker);
    if (reason) return ['fail', reason];
  }
  if (entry.worker) {
    const worker = data.workers[entry.worker];
    if (!worker) return ['fail', `worker ${entry.worker} does not exist (retired or never spawned)`];
    if (worker.retiring && kind !== 'final') return ['fail', `worker ${worker.id} is being retired`];
    return ['take', worker.id];
  }
  const worker = Object.values(data.workers)
    .filter(item => (!item.retiring || kind === 'final') && (!entry.difficulty || workerHarness(item, data) === 'omp'))
    .sort((left, right) => left.assignments - right.assignments || workerIndex(left.id) - workerIndex(right.id))[0];
  return worker ? ['take', worker.id] : ['fail', 'no compatible active workers left (team is closing or shrunk to zero)'];
}


function taskOutput(snapshot, fallback = {}) {
  const spec = snapshot.spec || {};
  const result = snapshot.result;
  const status = snapshot.state === 'unknown' ? 'unknown' : result?.status || (snapshot.state === 'failed' || snapshot.error ? 'failed' : 'blocked');
  return {
    status,
    summary: result?.summary || snapshot.error || `task ${snapshot.state || 'unknown'} without a native result`,
    files_changed: result?.files_changed || [],
    files_deleted: result?.files_deleted || [],
    verification: result?.verification || '',
    blockers: result?.blockers || (snapshot.error ? [snapshot.error] : []),
    approval_requests: result?.approval_requests || [],
    branch: result?.branch || '',
    commit: result?.commit || '',
    team: spec.team || fallback.team,
    worker: spec.worker || fallback.worker,
    task: spec.task || fallback.task,
    kind: spec.kind || fallback.kind,
    request_id: snapshot.request_id,
    state: snapshot.state,
    model: snapshot.model ?? spec.model ?? null,
    thinking: spec.thinking ?? null,
    difficulty: spec.env?.TEAM_BUILDING_DIFFICULTY || null,
    intent: spec.env?.TEAM_BUILDING_INTENT || null,
    router_model: spec.env?.TEAM_BUILDING_ROUTER_MODEL || null,
    session_id: snapshot.session_id ?? null,
    session_file: snapshot.session_file ?? null,
    error: snapshot.error ?? null,
    created_ms: snapshot.created_ms,
    updated_ms: snapshot.updated_ms,
    log: spec.log || fallback.log,
  };
}

async function cleanupToolSessions(teamDir, snapshot) {
  const sessions = snapshot.result?.tool_sessions || [];
  if (!sessions.length) return { cleaned: 0, errors: [] };
  let baseline;
  try {
    const handles = JSON.parse(snapshot.spec?.env?.TEAM_BUILDING_TOOL_TABS_BEFORE);
    if (!Array.isArray(handles) || handles.length > 2048 || handles.some(handle => typeof handle !== 'string' || !handle)) throw new Error('invalid tab census');
    baseline = new Set(handles);
  } catch {
    return { cleaned: 0, errors: ['could not verify which tabs existed before assignment; reported tabs left untouched'] };
  }
  let data;
  try {
    data = await load(teamDir);
  } catch (error) {
    return { cleaned: 0, errors: [`could not load team state for tool-tab cleanup: ${error.message}`] };
  }
  const worker = data.workers[snapshot.spec?.worker];
  const worktree = data.isolate ? worker?.worktree : data.worktree;
  const protectedTabs = new Set(Object.values(data.workers).map(item => item.observer).filter(Boolean));
  const mux = muxOf(data);
  const seen = new Set();
  const errors = [];
  let cleaned = 0;
  for (const session of sessions) {
    const { kind, id } = session || {};
    if (kind !== 'tab' || typeof id !== 'string' || !/^[A-Za-z0-9._:-]{1,256}$/.test(id)) {
      errors.push('invalid tool-tab handle; left untouched');
      continue;
    }
    if (seen.has(id)) continue;
    seen.add(id);
    if (protectedTabs.has(id)) {
      errors.push('refused to close a team worker tab');
      continue;
    }
    if (baseline.has(id)) {
      errors.push('refused to close a tab that existed before this assignment');
      continue;
    }
    if (!worktree) {
      errors.push('team worker worktree unavailable; left tool tab untouched');
      continue;
    }
    try {
      if (!(await mux.ownsToolTab(data, id, worktree))) continue;
      if (!(await mux.close(data, id))) {
        errors.push('multiplexer did not confirm tool-tab closure');
        continue;
      }
      cleaned++;
    } catch (error) {
      errors.push(`could not close tool tab: ${error.message}`);
    }
  }
  return { cleaned, errors };
}

async function taskOutputWithCleanup(teamDir, snapshot, fallback) {
  const output = taskOutput(snapshot, fallback);
  if (snapshot.result?.tool_sessions?.length) {
    const cleanup = await cleanupToolSessions(teamDir, snapshot);
    output.tool_sessions_cleaned = cleanup.cleaned;
    output.tool_session_cleanup_errors = cleanup.errors;
  }
  return output;
}

async function syncStatus(teamDir, client, team) {
  const workers = [];
  let queued = 0;
  for (let after = 0;;) {
    const page = await client.status(team, after);
    workers.push(...page.workers);
    queued = page.queued;
    if (!page.has_more) break;
    if (!Number.isInteger(page.next_after) || page.next_after <= after) throw new Error('supervisor returned an invalid status page');
    after = page.next_after;
  }
  await withLock(teamDir, async () => {
    const data = await load(teamDir);
    for (const item of workers) {
      const worker = data.workers[item.worker];
      if (!worker) continue;
      const snapshot = (await client.get(item.request_id)).task;
      if (!snapshot) continue;
      const spec = snapshot.spec || {};
      const active = ['queued', 'running'].includes(item.state);
      const fenced = item.state === 'unknown' && !item.fence_released;
      worker.state = active ? 'busy' : fenced ? 'unknown' : 'idle';
      worker.session_id = snapshot.session_id ?? item.session_id ?? worker.session_id ?? null;
      worker.session_file = snapshot.session_file ?? item.session_file ?? worker.session_file ?? null;
      worker.resolved_model = snapshot.model ?? spec.model ?? worker.resolved_model ?? null;
      worker.last_route = { model: spec.model ?? null, thinking: spec.thinking ?? null };
      if (!Number.isSafeInteger(item.assignments) || item.assignments < 0) throw new Error('supervisor returned an invalid worker assignment count');
      worker.assignments = item.assignments;
      if (active || fenced) {
        worker.task = spec.task || item.task;
        worker.task_prompt = spec.prompt || worker.task_prompt || null;
      } else {
        worker.task = null;
        worker.task_prompt = null;
      }
    }
    await save(teamDir, data);
  });
  return { workers, queued };
}

async function ensureObserver(teamDir, data, worker) {
  const mux = muxOf(data);
  const worktree = data.isolate ? worker.worktree : data.worktree;
  if (!worktree) throw new OrcaError(`worker ${worker.id} has no ${mux.label} worktree for its observer`);
  // OMP workers ARE their tab: an interactive omp session fed by the broker. Other harnesses keep a read-only summary log.
  const omp = workerHarness(worker, data) === 'omp';
  const title = `${data.id} ${worker.id} ${omp ? 'session' : 'observer'}`;
  if (worker.observer) {
    const terminal = await mux.inspect(data, worker.observer, worktree);
    if (terminal) {
      // An omp worker's tab recorded before the tab bridge existed is a log viewer, not a worker.
      const legacyViewer = omp && worker.observer_kind !== 'tab';
      if (!legacyViewer) {
        if (terminal.orphaned) console.error(`team-building: warning: ${worker.id} observer ${worker.observer} is running without a visible ${mux.label} pane; use terminal switch to reveal it`);
        // omp rewrites its own tab title, so only the read-only viewers are identified by it.
        if (omp || !terminal.title || terminal.title === title) return;
      }
      await mux.close(data, worker.observer);
    }
    console.error(`team-building: warning: ${worker.id} ${omp ? 'session tab' : 'observer'} ${worker.observer} is closed, missing, legacy, or incorrectly titled; recreating it (worker session unchanged)`);
  }
  const tab = tabDir(teamDir, worker);
  await mkdir(tab, { recursive: true });
  let launch;
  if (omp) {
    // A previous omp's identity files must not satisfy the broker's readiness check for the new one.
    await Promise.all(['ready.json', 'beat'].map(name => rm(join(tab, name), { force: true })));
    launch = ompTabCommand(basename(teamDir), worker, { teamDir, cwd: worker.cwd || data.cwd });
  } else {
    // Shell preexec hooks overwrite --title; restore it after the hook runs.
    launch = `printf '\\033]0;%s\\007' ${shellQuote(title)}; exec ${shellQuote(supervisorBinary)} view --log ${shellQuote(worker.log)}`;
  }
  const handle = await mux.create(data, { worktree, title, launch, cwd: worker.cwd || data.cwd, script: join(tab, 'launch.sh') });
  worker.observer = handle; // rollback reads the in-memory handle
  worker.observer_kind = omp ? 'tab' : 'viewer';
  await withLock(teamDir, async () => {
    const latest = await load(teamDir);
    if (latest.workers[worker.id]) {
      latest.workers[worker.id].observer = handle;
      latest.workers[worker.id].observer_kind = worker.observer_kind;
      await save(teamDir, latest);
    }
  });
}
// Settle every create before failing so rollback sees each recorded observer handle.
async function ensureObservers(teamDir, data, workers) {
  const failed = (await Promise.allSettled(workers.map(worker => ensureObserver(teamDir, data, worker)))).find(result => result.status === 'rejected');
  if (failed) throw failed.reason;
}

export async function runAssignment(teamDir, preferredWorker, prompt, timeout, maximum, kind = 'task', approval = null, assignment = {}, detach = false) {
  const team = basename(teamDir);
  const requestId = assignment.request_id || randomUUID();
  const client = await connectSupervisor(STATE_ROOT);
  const prior = await client.get(requestId);
  if (prior.task) {
    const spec = prior.task.spec;
    if (spec.team !== team || spec.prompt !== prompt || (preferredWorker && spec.worker !== preferredWorker)
      || (spec.env?.TEAM_BUILDING_APPROVAL_TASK || '') !== (approval || '')
      || (assignment.difficulty !== undefined && (spec.env?.TEAM_BUILDING_DIFFICULTY || '') !== (assignment.difficulty || ''))
      || (assignment.model !== undefined && spec.model !== assignment.model)
      || (assignment.thinking !== undefined && spec.thinking !== assignment.thinking)) {
      throw new Error(`request ${requestId} conflicts with its durable assignment`);
    }
    const fallback = { team, worker: spec.worker, task: spec.task, kind: spec.kind, log: spec.log };
    if (detach) {
      await rememberDetached(teamDir, { ...fallback, request_id: requestId });
      await syncStatus(teamDir, client, team);
      return fallback;
    }
    const snapshot = await waitForTask(client, requestId, timeout);
    await syncStatus(teamDir, client, team);
    return taskOutputWithCleanup(teamDir, snapshot, fallback);
  }

  let data; let worker; let task;
  await withLock(teamDir, async () => {
    data = await load(teamDir);
    if (assignment.difficulty) {
      const selected = data.router?.models?.[assignment.difficulty];
      if (assignment.router_family && data.router?.family !== assignment.router_family) {
        throw new Error('router family changed while the assignment was being classified; retry the assignment');
      }
      if (!selected || selected.model !== assignment.model || selected.thinking !== assignment.thinking) {
        throw new Error('router tier changed while the assignment was being classified; retry the assignment');
      }
    }
    const pendingTask = '__pending_assignment__';
    const [action, selectedWorker] = chooseWorker(
      { ...data, queue: [...data.queue, { task: pendingTask, worker: preferredWorker, difficulty: assignment.difficulty }] },
      pendingTask,
      kind,
    );
    if (action !== 'take') throw new Error(selectedWorker);
    worker = data.workers[selectedWorker];
    const worktreeError = assignmentWorktreeError(data, worker, assignment.current_worktree);
    if (worktreeError) throw new Error(worktreeError);
    if (!data.isolate && !data.worktree) data.worktree = assignment.current_worktree;
    const legacy = worker.terminal || worker.terminal_started || worker.terminal_stopped;
    if (legacy && (!worker.terminal_stopped || !worker.session_id)) {
      throw new Error(`legacy terminal for ${worker.id} has no broker-proven stop and exact native session identity; leave the production terminal open and recover its native session before migration`);
    }
    if (approval) {
      const approved = JSON.parse(await readFile(join(teamDir, 'approvals', `${approval}.json`), 'utf8'));
      if (approved.task !== approval || approved.worker !== worker.id) throw new Error(`approval ${approval} is not bound to ${worker.id}`);
    }
    const route = kind === 'final' ? worker.last_route || {} : assignment;
    worker = {
      ...worker,
      task_model: route.model ?? worker.model ?? null,
      task_thinking: route.thinking ?? null,
      approval_task: approval,
      allow_bypass: !!data.allow_bypass,
    };
    task = `t${String(data.next_task++).padStart(3, '0')}`;
    await writeShims(teamDir, data);
    await save(teamDir, data);
  });
  await ensureObserver(teamDir, data, worker);
  const toolTabsBefore = await muxOf(data).listToolTabs(data, data.isolate ? worker.worktree : data.worktree);
  if (toolTabsBefore.length > 2048) throw new Error('team workspace contains too many tabs to verify temporary-tab ownership safely');
  const cwd = worker.cwd || data.cwd;
  const native = await nativeTask(team, worker, { prompt, teamDir, cwd });
  const spec = {
    team_dir: teamDir, team, worker: worker.id, task, kind, cwd,
    harness: worker.harness || data.harness || 'omp', argv: native.argv,
    env: {
      ...native.env,
      TEAM_BUILDING_WORKER: `${team}/${worker.id}`,
      TEAM_BUILDING_APPROVAL_TASK: approval || '',
      TEAM_BUILDING_DIFFICULTY: assignment.difficulty || '',
      TEAM_BUILDING_TOOL_TABS_BEFORE: JSON.stringify(toolTabsBefore),
      TEAM_BUILDING_INTENT: assignment.intent || '',
      TEAM_BUILDING_ROUTER_MODEL: assignment.router_model || '',
      PATH: `${join(teamDir, 'shim')}:${process.env.PATH || ''}`,
    },
    prompt, model: worker.task_model, thinking: native.thinking,
    session_id: worker.session_id ?? null, session_file: worker.session_file ?? null,
    log: worker.log, idle_timeout_ms: Math.max(1_000, timeout * 1000), max_timeout_ms: Math.max(1_000, maximum * 1000),
  };
  const accepted = await client.submit(spec, requestId);
  const fallback = { team, worker: worker.id, task, kind, log: worker.log };
  if (detach) {
    await rememberDetached(teamDir, { ...fallback, request_id: accepted.request_id });
    await syncStatus(teamDir, client, team);
    return fallback;
  }
  await syncStatus(teamDir, client, team);
  const snapshot = await waitForTask(client, accepted.request_id, timeout);
  await syncStatus(teamDir, client, team);
  const output = { ...(await taskOutputWithCleanup(teamDir, snapshot, fallback)), finished: now() };
  if (output.status !== 'unknown') await writeResult(teamDir, output);
  return output;
}

async function rememberDetached(teamDir, task) {
  await withLock(teamDir, async () => {
    const data = await load(teamDir);
    data.detached = {
      ...(data.detached || {}),
      [task.task]: {
        request_id: task.request_id,
        worker: task.worker,
        kind: task.kind,
        log: task.log,
      },
    };
    await save(teamDir, data);
  });
}

async function waitForTask(client, requestId, timeout) {
  let after = 0;
  for (;;) {
    const reply = await client.wait(requestId, after, Math.min(60_000, Math.max(1_000, timeout * 1000)));
    for (const event of reply.events) {
      after = Math.max(after, event.seq);
      await client.ack(requestId, event.seq);
    }
    if (['succeeded', 'failed', 'blocked', 'unknown'].includes(reply.task?.state)) return reply.task;
  }
}

async function waitForTaskUntil(client, requestId, deadline) {
  let after = 0;
  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return null;
    const reply = await client.wait(requestId, after, Math.min(60_000, Math.max(1, remaining)));
    for (const event of reply.events) {
      after = Math.max(after, event.seq);
      await client.ack(requestId, event.seq);
    }
    if (['succeeded', 'failed', 'blocked', 'unknown'].includes(reply.task?.state)) return reply.task;
  }
}

function printResult(result) {
  const duration = result.created_ms && result.updated_ms ? `${Math.max(0, (result.updated_ms - result.created_ms) / 1000)}s` : 'duration n/a';
  console.log(`[${result.team}] ${result.worker || '-'} ${result.task} ${result.status || result.state} (${result.model || 'model n/a'}, ${duration}) request_id=${result.request_id || 'n/a'}: ${(result.summary || result.error || 'no result').slice(0, 200)}`);
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
    allow_bypass: !!data.allow_bypass,
    session_id: null,
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
  const team = basename(teamDir);
  const client = await connectSupervisor(STATE_ROOT);
  const status = await syncStatus(teamDir, client, team);
  const data = await load(teamDir);
  console.log(`team ${data.id}  cwd=${data.cwd}  model=${data.model || 'routed/default'}  router=${data.router?.enabled ? data.router.family : 'off'}  state=${teamDir}`);
  if (data.router?.enabled) {
    console.log(`  classifier=${data.router.classifier} checked=${data.router.checked_at} simple=${data.router.models.simple.model} moderate=${data.router.models.moderate.model} complex=${data.router.models.complex.model} extreme=${data.router.models.extreme?.model || 'init required'}`);
  }
  for (const worker of Object.values(data.workers).sort((left, right) => workerIndex(left.id) - workerIndex(right.id))) {
    const model = worker.resolved_model || worker.model || 'default';
    console.log(`  ${worker.id.padEnd(4)} ${String(worker.state || 'idle').padEnd(14)} harness=${worker.harness || data.harness} model=${model} session=${worker.session_id || 'pending'} assignments=${worker.assignments} task=${worker.task || '-'} log=${worker.log}`);
  }
  if (status.queued) console.log(`  queued=${status.queued}`);
}

function insideWorktree(worktree, cwd) {
  const path = relative(resolve(worktree), resolve(cwd));
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}
function assignmentWorktreeError(data, worker, currentWorktree) {
  const worktree = data.isolate ? worker.worktree : data.worktree || currentWorktree;
  const cwd = worker.cwd || data.cwd;
  if (!worktree || !cwd || !insideWorktree(worktree, cwd)) {
    return data.isolate
      ? `isolated worker ${worker.id} cwd ${cwd || '(unknown)'} is outside its recorded worktree`
      : `worker cwd ${cwd || '(unknown)'} is outside current ${muxOf(data).label} worktree ${worktree || '(unknown)'}`;
  }
  return null;
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

  const worktree = await muxOf(data).addWorktree(data, `${data.id}-${workerId}`, base);

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
      await muxOf(data).removeWorktree(data, worker.worktree);
      return `removed isolated worktree ${worker.worktree} (${branch})`;
    } catch (error) {
      return `left isolated worktree ${worker.worktree} (${branch}): ${error.message}`;
    }
  }
  return `left isolated worktree ${worker.worktree} (${branch || 'unknown branch'}): not clean or not merged`;
}

async function rollbackIsolated(data) {
  await Promise.all(Object.values(data.workers).map(async worker => {
    if (worker.worktree) await muxOf(data).removeWorktree(data, worker.worktree).catch(() => {});
  }));
}

async function retire(teamDir, ids, timeout, maximum, fast = false) {
  const team = basename(teamDir);
  const broker = await connectSupervisor(STATE_ROOT);
  await syncStatus(teamDir, broker, team);
  let workers;
  await withLock(teamDir, async () => {
    const data = await load(teamDir);
    for (const id of ids) data.workers[id].retiring = true;
    await save(teamDir, data);
    workers = Object.fromEntries(ids.map(id => [id, { ...data.workers[id] }]));
  });
  for (const worker of Object.values(workers)) {
    if (worker.state === 'unknown') await broker.stop(team, worker.id);
  }
  await syncStatus(teamDir, broker, team);
  const latestData = await load(teamDir);
  workers = Object.fromEntries(ids.map(id => [id, { ...latestData.workers[id] }]));
  const lastResults = new Map();
  if (fast) {
    await Promise.all((await readdir(join(teamDir, 'results')))
      .filter(file => /^t\d+\.json$/.test(file))
      .map(async file => {
        const result = JSON.parse(await readFile(join(teamDir, 'results', file), 'utf8'));
        const task = Number(file.slice(1, -5));
        const previous = lastResults.get(result.worker);
        if (!previous || task > previous.task) lastResults.set(result.worker, { task, result });
      }));
  }
  const finals = {};
  await Promise.all(ids.map(async id => {
    const worker = workers[id];
    const lastResult = lastResults.get(id)?.result;
    finals[id] = fast
      ? lastResult
        ? { ...lastResult, team, worker: id, kind: 'final' }
        : { status: 'succeeded', summary: 'no assignments; nothing to summarise', files_changed: [], files_deleted: [], verification: '', blockers: [], team, worker: id, kind: 'final' }
      : worker.state !== 'idle' || worker.session_id || worker.session_file
        ? await runAssignment(teamDir, id, 'Wrap-up: this worker is being shut down. Do not start new work. Return a final summary of all work and open issues in the required JSON object.', timeout, maximum, 'final')
        : { status: 'succeeded', summary: 'no assignments; nothing to summarise', files_changed: [], files_deleted: [], verification: '', blockers: [], team, worker: id, kind: 'final' };
    await writeFile(join(teamDir, 'results', `${id}-final.json`), JSON.stringify(finals[id], null, 2));
  }));
  for (const id of ids) await broker.stop(team, id);
  await syncStatus(teamDir, broker, team);
  await withLock(teamDir, async () => {
    const data = await load(teamDir);
    for (const id of ids) {
      const worker = data.workers[id];
      if (worker?.state !== 'idle') throw new Error(`broker has not proven ${id} stopped; refusing cleanup`);
      if (worker.observer && !(await muxOf(data).close(data, worker.observer))) throw new Error(`observer for ${id} is not proven closed`);
      await cleanupWorker(worker);
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
  if (args.clearPrevious && args.keepPrevious) die('choose only one of --clear-previous or --keep-previous');
  const selectedFamily = args.family || (['gpt', 'claude'].includes(args.model) ? args.model : null);
  if (args.family && args.model && args.family !== args.model) die(`conflicting family ${args.family} and --model ${args.model}`);
  const familySelected = !!selectedFamily;
  const fixedModel = familySelected ? null : args.model || null;
  const harness = args.harness || 'omp';
  if (familySelected && harness !== 'omp') die('gpt/claude family routing requires --harness omp; the family selects models, not the harness');
  // One omp spawn proves the binary exists and reads the approval mode.
  const approvalModePromise = harness === 'omp' ? requireOmp(die) : Promise.resolve(null);
  approvalModePromise.catch(() => {});
  if (requiresBypass(harness) && !args.allowBypass) {
    die(`--harness ${harness} requires explicit --allow-bypass (it enables ${configFor({ harness }).bypass})`, 3);
  }

  const cwd = realpathSync(process.cwd());
  const muxName = backendName();
  const teams = await activeTeams();
  const active = await Promise.all(teams.map(async teamDir => ({ teamDir, data: await load(teamDir) })));
  const existing = active.find(team => team.data.cwd === cwd);
  let approvalMode;
  if (existing) {
    approvalMode = await approvalModePromise;
    if (harness === 'omp' && approvalMode !== 'yolo') {
      die(`tools.approvalMode is ${JSON.stringify(approvalMode)}; omp workers need yolo because nobody can answer their prompts.`, 3);
    }
    const teamDir = existing.teamDir;
    const adoptMismatch = backendMismatchError(existing.data);
    if (adoptMismatch) die(adoptMismatch, 4);
    console.log(`adopted existing team ${basename(teamDir)} for cwd ${cwd}`);
    // The adopting session becomes the manager; role widgets key on this id.
    await withLock(teamDir, async () => {
      const data = await load(teamDir);
      data.manager_session = process.env.OMP_SESSION_ID || process.env.PI_SESSION_ID || null;
      await save(teamDir, data);
    });
    const current = existing.data;
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
    await ensureObservers(teamDir, current, Object.values(current.workers).filter(worker => !worker.retiring));
    return show(teamDir);
  }

  const mux = MUXES[muxName];
  const placePromise = Promise.all([mux.current(die), mux.home(die)]).then(([current, home]) => ({ worktree: current.worktree, home }));
  const routerPromise = harness === 'omp' && !fixedModel
    ? configureRouter(selectedFamily || 'gpt')
    : Promise.resolve(null);
  placePromise.catch(() => {});
  routerPromise.catch(() => {});
  approvalMode = await approvalModePromise;
  if (harness === 'omp' && approvalMode !== 'yolo') {
    die(`tools.approvalMode is ${JSON.stringify(approvalMode)}; omp workers need yolo because nobody can answer their prompts.`, 3);
  }

  if (active.length && !args.clearPrevious && !args.keepPrevious) {
    const previous = active.map(({ data }) => {
      const busy = Object.values(data.workers || {}).filter(worker => worker.state === 'busy').length;
      return `${data.id} cwd=${data.cwd || 'legacy: no cwd'} busy=${busy}`;
    });
    die(`active teams at other paths:\n${previous.join('\n')}\nAsk whether to delete the previous manager, then rerun with --clear-previous or --keep-previous.`, 3);
  }
  if (args.clearPrevious) {
    for (const { teamDir } of active) await clear({ ...args, team: basename(teamDir) });
  }

  const { worktree, home } = await placePromise;
  if (!args.isolate && !insideWorktree(worktree, cwd)) {
    die(`manager cwd ${cwd} is outside active ${mux.label} worktree ${worktree}; return to that worktree or initialize a new team there`, 4);
  }
  if (args.isolate && (await gitOutput(['rev-parse', '--show-toplevel'], cwd))[0]) {
    die('--isolate requires a git repository cwd', 2);
  }
  if (args.isolate && (await gitOutput(['status', '--porcelain'], cwd))[1]) {
    console.error('team-building: warning: uncommitted manager changes are not copied into isolated worker worktrees');
  }
  const router = await routerPromise;

  const stamp = new Date();
  const base = `tb-${String(stamp.getMonth() + 1).padStart(2, '0')}${String(stamp.getDate()).padStart(2, '0')}-${String(stamp.getHours()).padStart(2, '0')}${String(stamp.getMinutes()).padStart(2, '0')}${String(stamp.getSeconds()).padStart(2, '0')}`;
  let id = base;
  await mkdir(STATE_ROOT, { recursive: true });
  // Same-second inits must never share (and overwrite) a team directory.
  for (let suffix = 2; ; suffix++) {
    try {
      await mkdir(join(STATE_ROOT, id));
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      id = `${base}-${suffix}`;
    }
  }
  const teamDir = join(STATE_ROOT, id);
  for (const subdir of ['sessions', 'logs', 'results', 'approvals']) {
    await mkdir(join(teamDir, subdir), { recursive: true });
  }

  const data = {
    id,
    created: now(),
    cwd,
    manager_session: process.env.OMP_SESSION_ID || process.env.PI_SESSION_ID || null,
    backend: muxName,
    worktree,
    ...home,
    model: fixedModel,
    router,
    harness,
    allow_bypass: !!args.allowBypass,
    approval_mode: approvalMode,
    next_task: 1,
    next_worker: 1,
    closing: false,
    workers: {},
    queue: [],
    detached: {},
    isolate: !!args.isolate,
  };
  await writeShims(teamDir, data);
  try {
    for (let index = 0; index < (args.member || 3); index++) {
      const workerId = `w${data.next_worker}`;
      const [workerWorktree, workerCwd] = data.isolate ? await isolatedCwd(data, workerId) : [null, cwd];
      newWorker(teamDir, data, null, workerCwd);
      data.workers[workerId].worktree = workerWorktree;
    }
    await save(teamDir, data);
    await ensureObservers(teamDir, data, Object.values(data.workers));
  } catch (error) {
    const latest = await load(teamDir).catch(() => data);
    await Promise.all(Object.values(latest.workers).map(worker => worker.observer && mux.close(data, worker.observer)));
    await rollbackIsolated(latest);
    await rm(teamDir, { recursive: true, force: true });
    die(`${mux.name}: ${error.message.split('\n')[0]}`, 4);
  }

  console.log(`team ${id} ready: ${args.member || 3} workers, harness=${harness}, model=${fixedModel || 'automatic'}, router=${router?.family || 'off'}, cwd=${data.cwd}`);
  await show(teamDir);

}

async function member(args) {
  forbidWorkerManager();
  if (['gpt', 'claude'].includes(args.model)) die('select a model family with init --model gpt|claude, not member --model');
  if (!Number.isInteger(args.n) || args.n < 1 || args.n > MAX_WORKERS) die(`member must be 1..${MAX_WORKERS} (task.maxConcurrency)`);

  const teamDir = await resolveTeam(args.team, die, process.cwd());
  let retirees = [];
  let removed = {};
  let data;
  const added = [];
  await withLock(teamDir, async () => {
    data = await load(teamDir);
    if (data.closing) die('team is being cleared');
    const memberMismatch = backendMismatchError(data);
    if (memberMismatch) die(memberMismatch, 4);

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
        const [workerWorktree, cwd] = data.isolate ? await isolatedCwd(data, workerId) : [null, data.cwd];
        newWorker(teamDir, data, args.harness, cwd);
        data.workers[workerId].worktree = workerWorktree;
        added.push(data.workers[workerId]);
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
  try {
    await ensureObservers(teamDir, data, Object.values(data.workers).filter(worker => !worker.retiring && !retirees.includes(worker.id)));
  } catch (error) {
    await Promise.all(added.map(worker => worker.observer && muxOf(data).close(data, worker.observer)));
    await rollbackIsolated({ ...data, workers: Object.fromEntries(added.map(worker => [worker.id, worker])) });
    await withLock(teamDir, async () => {
      const latest = await load(teamDir);
      for (const worker of added) delete latest.workers[worker.id];
      await save(teamDir, latest);
    });
    die(`${muxOf(data).name}: ${error.message.split('\n')[0]}`, 4);
  }


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

async function dismiss(args) {
  forbidWorkerManager();
  const ids = String(args.worker || '').split(',').filter(Boolean);
  if (!ids.length) die('dismiss requires --worker wN[,wM...]');
  const teamDir = await resolveTeam(args.team, die, process.cwd());
  const data = await load(teamDir);
  for (const id of ids) {
    if (!data.workers[id]) die(`unknown worker ${id}`);
    if (data.workers[id].state === 'busy') die(`${id} is busy; wait for its task first`);
  }
  const finals = await retire(teamDir, ids, args.timeout, args.max);
  for (const [id, result] of Object.entries(finals)) {
    console.log(`  ${id} final ${result.status}: ${result.summary.slice(0, 200)}`);
    const note = await removeIsolated(data, data.workers[id]);
    if (note) console.log(`  ${note}`);
  }
  await show(teamDir);
}

async function status(args) {
  return show(await resolveTeam(args.team, die, process.cwd()));
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
  const teamDir = await resolveTeam(args.team, die, process.cwd());
  const prompt = await readPrompt(args.prompt);
  if (!prompt.trim()) die('empty prompt');
  if (args.approval && !/^t\d{3}$/.test(args.approval)) die('--approval must name a source task such as t001');
  if (args.request_id) {
    const client = await connectSupervisor(STATE_ROOT);
    const prior = (await client.get(args.request_id)).task;
    if (prior) {
      const retry = { request_id: args.request_id };
      if (args.difficulty !== undefined) Object.assign(retry, {
        difficulty: args.difficulty,
        model: prior.spec.model,
        thinking: prior.spec.thinking,
      });
      if (args.model !== undefined) retry.model = args.model;
      const output = await runAssignment(teamDir, args.worker, prompt, args.timeout, args.max, 'task', args.approval, retry, args.detach);
      if (args.detach) console.log(output.task);
      else {
        printResult(output);
        if (output.tool_session_cleanup_errors?.length) process.exitCode = 1;
      }
      return;
    }
  }

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

  let data = await load(teamDir);
  const assignMismatch = backendMismatchError(data);
  if (assignMismatch) die(assignMismatch, 4);
  const mux = muxOf(data);
  const muxReady = mux.require(data, die);
  const placePromise = mux.current(die);
  muxReady.catch(() => {});
  placePromise.catch(() => {});
  await muxReady;
  const currentWorktree = (await placePromise).worktree;
  if (data.worktree && resolve(data.worktree) !== resolve(currentWorktree)) {
    die(`team initialized worktree ${data.worktree} does not match active ${mux.label} worktree ${currentWorktree}; initialize a new team there`, 4);
  }
  const automatic = data.router?.enabled && !data.model && !args.model && !args.difficulty;
  if (automatic || (args.difficulty && !args.model)) {
    const error = routingError(data, args.worker);
    if (error) die(error);
  }
  if (args.difficulty && !args.model && !data.model && !data.router) {
    const router = await configureRouter('gpt');
    router.enabled = false;
    await withLock(teamDir, async () => {
      data = await load(teamDir);
      if (!data.model && !data.router) {
        data.router = router;
        await save(teamDir, data);
      }
    });
    data = await load(teamDir);
  }
  let assignment;
  if (automatic) {
    const started = Date.now();
    assignment = await classifyRequest(data.router, prompt, { cwd: data.cwd });
    assignment.router_duration_ms = Date.now() - started;
    const route = `route ${data.router.family}: ${assignment.difficulty} model=${assignment.model} intent=${JSON.stringify(assignment.intent)} (${assignment.router_duration_ms}ms)`;
    if (args.detach) console.error(route);
    else console.log(route);
  } else {
    assignment = routedAssignment(data, args);
  }
  const pendingTask = '__worktree_preflight__';
  const [action, selectedWorker] = chooseWorker(
    { ...data, queue: [...(data.queue || []), { task: pendingTask, worker: args.worker, difficulty: assignment.difficulty }] },
    pendingTask,
    'task',
  );
  if (action === 'take') {
    const error = assignmentWorktreeError(data, data.workers[selectedWorker], currentWorktree);
    if (error) die(error, 4);
  }
  if (assignment.difficulty && data.router?.family) assignment.router_family = data.router.family;
  assignment.current_worktree = currentWorktree;
  assignment.request_id = args.request_id;
  if (interrupted()) throw interrupted();
  const output = await runAssignment(teamDir, args.worker, prompt, args.timeout, args.max, 'task', args.approval, assignment, args.detach);
  if (args.detach) console.log(output.task);
  else {
    printResult(output);
    if (output.tool_session_cleanup_errors?.length) process.exitCode = 1;
  }
}

async function wait(args) {
  forbidWorkerManager();
  const teamDir = await resolveTeam(args.team, die, process.cwd());
  const data = await load(teamDir);
  const mismatch = backendMismatchError(data);
  if (mismatch) die(mismatch, 4);
  const detached = data.detached || {};
  const requestedTasks = args.task ? [...new Set(args.task.split(','))] : null;
  if (requestedTasks?.some(task => !/^t\d{3}$/.test(task))) die('--task must name detached tasks such as t001,t002');
  if (args.worker && !/^w\d+$/.test(args.worker)) die('--worker must name a worker such as w1');
  if (requestedTasks?.some(task => !detached[task])) die(`no detached task ${requestedTasks.find(task => !detached[task])}`);
  const selected = Object.entries(detached)
    .filter(([task, entry]) => (!requestedTasks || requestedTasks.includes(task)) && (!args.worker || entry.worker === args.worker))
    .map(([task, entry]) => ({ task, ...entry }));
  if ((requestedTasks || args.worker) && !selected.length) die('no detached tasks match the selection');
  if (!selected.length) return;

  const client = await connectSupervisor(STATE_ROOT);
  const deadline = Date.now() + args.timeout * 1000;
  let completed = [];
  if (args.any) {
    const after = new Map(selected.map(entry => [entry.request_id, 0]));
    while (Date.now() < deadline && !completed.length) {
      const replies = await Promise.all(selected.map(async entry => {
        const remaining = deadline - Date.now();
        if (remaining <= 0) return { entry, snapshot: null };
        const reply = await client.wait(entry.request_id, after.get(entry.request_id), Math.min(1_000, remaining));
        for (const event of reply.events) {
          after.set(entry.request_id, Math.max(after.get(entry.request_id), event.seq));
          await client.ack(entry.request_id, event.seq);
        }
        return {
          entry,
          snapshot: ['succeeded', 'failed', 'blocked', 'unknown'].includes(reply.task?.state) ? reply.task : null,
        };
      }));
      completed = replies.filter(result => result.snapshot).slice(0, 1);
    }
  } else {
    completed = (await Promise.all(selected.map(async entry => ({
      entry,
      snapshot: await waitForTaskUntil(client, entry.request_id, deadline),
    })))).filter(result => result.snapshot);
  }
  await syncStatus(teamDir, client, data.id);
  const outputs = [];
  for (const { entry, snapshot } of completed) {
    const fallback = { team: data.id, worker: entry.worker, task: entry.task, kind: entry.kind, log: entry.log };
    outputs.push({ ...(await taskOutputWithCleanup(teamDir, snapshot, fallback)), finished: now() });
  }
  for (const output of outputs) {
    if (output.status !== 'unknown') await writeResult(teamDir, output);
  }
  await withLock(teamDir, async () => {
    const latest = await load(teamDir);
    const mappings = { ...(latest.detached || {}) };
    for (const output of outputs) {
      if (mappings[output.task]?.request_id === output.request_id && !output.tool_session_cleanup_errors?.length) delete mappings[output.task];
    }
    latest.detached = mappings;
    await save(teamDir, latest);
  });
  for (const output of outputs) console.log(JSON.stringify(output));
  if (!outputs.length || outputs.some(output => output.status !== 'succeeded' || output.tool_session_cleanup_errors?.length) || (!args.any && outputs.length !== selected.length)) {
    process.exitCode = 1;
  }
}

async function approve(args) {
  forbidWorkerManager();
  const teamDir = await resolveTeam(args.team, die, process.cwd());
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

async function stop(args) {
  forbidWorkerManager();
  if (!/^w\d+$/.test(args.worker || '')) die('stop requires --worker wN');
  const teamDir = await resolveTeam(args.team, die, process.cwd());
  const team = basename(teamDir);
  const data = await load(teamDir);
  const worker = data.workers[args.worker];
  if (!worker) die(`worker ${args.worker} does not exist`);
  if (worker.terminal || worker.terminal_started || worker.terminal_stopped) {
    throw new Error(`legacy terminal for ${args.worker} has no broker-owned process identity; leave it open and recover its native session before migration`);
  }
  const client = await connectSupervisor(STATE_ROOT);
  await client.stop(team, args.worker);
  await syncStatus(teamDir, client, team);
  const latest = await load(teamDir).then(data => data.workers[args.worker]);
  if (latest.state !== 'idle') throw new Error(`broker did not prove ${args.worker} idle; state=${latest.state}`);
  console.log(`${team}/${args.worker}: broker-proven idle; ${latest.session_id ? 'native session retained' : 'no native session'}; queued tasks, if any, are blocked and must be resubmitted`);
}

function tableCell(value) {
  return String(value ?? '').replaceAll('|', '\\|').replaceAll('\n', ' ');
}

async function clear(args) {
  forbidWorkerManager();
  const teamDir = await resolveTeam(args.team, die, process.cwd());
  let data;
  await withLock(teamDir, async () => {
    data = await load(teamDir);
    const clearMismatch = backendMismatchError(data);
    if (clearMismatch) die(clearMismatch, 4);
    data.closing = true;
    await save(teamDir, data);
  });

  const finals = await retire(teamDir, Object.keys(data.workers), args.timeout, args.max, args.fast);
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
  console.log(`usage: node src/main.mjs {init,member,status,assign,wait,approve,stop,clear} [options]

team-building helper: persistent harness-neutral workers driven by one manager session.

Commands:
  init [gpt|claude] [--model gpt|claude|MODEL] [--member N] [--harness omp|claude|codex] [--allow-bypass] [--isolate] [--clear-previous|--keep-previous]
  member N [--model MODEL] [--harness omp|claude|codex] [--allow-bypass]
  dismiss --worker wN[,wM...]
  status
  assign [--detach] [--worker wN] [--approval tNNN] [--model MODEL] [--difficulty simple|moderate|complex|extreme] [PROMPT]
  wait [--task tNNN[,tMMM]] [--worker wN] [--all|--any]
  approve --worker wN --task tNNN -- COMMAND...
  stop --worker wN
  clear [--fast]

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
    } else if (option === '--fast') {
      args.fast = true;
    } else if (option === '--clear-previous') {
      args.clearPrevious = true;
    } else if (option === '--keep-previous') {
      args.keepPrevious = true;
    } else if (option === '--detach') {
      args.detach = true;
    } else if (option === '--all') {
      if (args.any) die('--all and --any cannot be combined');
      args.all = true;
    } else if (option === '--any') {
      if (args.all) die('--all and --any cannot be combined');
      args.any = true;
    } else if (option === '--request-id') {
      args.request_id = take(index, '--request-id');
      index++;
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(args.request_id)) die('--request-id must be a UUID');
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
  const action = { init, member, dismiss, status, assign, wait, approve, stop, clear }[args.cmd];
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
    if (error.message !== '__team_die__') console.error(`team-building: ${error.code ? `${error.code}: ` : ''}${error.message}`);
    if (!process.exitCode) process.exitCode = 2;
  });
}
