---
name: team-building
description: >
  Persistent AI-worker teams supervised by a Rust broker. Examples: `init claude --member 3`,
  `member 4`, `status`, `clear`, or `assign --worker w1 <task>`. Use for team init/status/clear/member,
  explicit worker assignments such as “w1에게 …”, or Korean requests containing 팀, 작업자, 워커, or wN.
  Workers may use OMP, Claude Code, or Codex.
argument-hint: init claude --member 3 | init gpt | member 4 | status | clear | assign --worker w1 <task>
---

# team-building

Run `node ~/.agents/skills/team-building/src/main.mjs`. Node manages team metadata and routing; the singleton Rust supervisor owns native processes, scheduling, exact session identity, and durable task state. State lives under `~/.local/state/team-building/<team-id>/`.

## Commands (manager runs)

| Request | Command and behavior |
|---|---|
| `init [gpt\|claude] [--member N] [--model M] [--harness omp\|claude\|codex] [--isolate] [--clear-previous\|--keep-previous]` | `node ~/.agents/skills/team-building/src/main.mjs init ...`. One manager team per absolute manager path: a team at the current path is adopted (routed OMP teams refresh the selected/current family). If teams exist only at other paths, init exits 3 and lists them; the manager MUST ask the user whether to delete the previous manager, then rerun with `--clear-previous` (clear them first) or `--keep-previous`. New workers run in that path and their Orca observer tabs open immediately. OMP requires `tools.approvalMode=yolo`; native Claude Code/Codex require explicit `--allow-bypass`. `--isolate` creates one Orca worktree per worker. |
| `member N [--model M] [--harness H]` | Resize the selected team; added workers get Orca observer tabs immediately. An omitted harness retains the existing team harness. |
| `dismiss --worker wN[,wM...]` | Retire the named idle workers (wrap-up summary, broker stop, observer close, session cleanup). Use for "퇴근" of specific workers. |
| `status [--team ID]` | Show workers, harness, requested/resolved model, router family, state, current task, queue, and log path. |
| `assign [--worker wN] [--approval tNNN] [--request-id UUID] [--model M] [--difficulty TIER] PROMPT` | Submit work and wait for the durable native result. A busy selected worker is queued behind its current task. |
| `approve --worker wN --task tNNN -- COMMAND...` | Record an exact external-command approval for one worker and source task. |
| `stop --worker wN [--team ID]` | Broker-proven recovery of a broker-owned `unknown` worker. Queued tasks are blocked, not replayed. |
| `clear [--team ID]` | Wrap up workers, clean only recoverable/owned sessions, report assignment history, and remove the selected team's state. |

Without `--team`, commands select the team registered for the current path; with none there, they fail and list active teams. `--model <exact selector>` pins a fixed model; `--difficulty` requires a routed OMP worker. On a new or restarted manager session, run `status` first and adopt the path's team with `init`.

## OMP role badge

Setup installs an OMP extension that shows blue `🔧 Role: worker` for workers and bold purple `👑 Role: manager` only for the active manager session. `init` records that manager session. Restart OMP after installation before the extension loads.

## Broker and message contract

Every supervisor request is a versioned object envelope: `{"version":1,"id":"<uuid>","type":"submit|get|wait|ack|status|stop|shutdown","payload":{...}}`. The payload is always a JSON object; scalar strings and non-object envelopes are rejected. Responses and events are structured, bounded, and correlated by UUID. Do not add a scalar command channel or send control traffic through an Orca terminal.

OMP RPC, Claude stream-json, and Codex app-server JSON-RPC remain private to the Rust worker. Orca tabs are read-only observers running `team-supervisor view --log <path>`; they display typed UI messages only, never native protocol frames or TaskResult JSON. The manager may disconnect without cancelling an accepted worker. Retrying the same request UUID and identical spec replays the existing assignment; a changed prompt, team, worker, model, thinking, difficulty, or approval conflicts rather than duplicating or rerouting work.

Work is durable FIFO per worker, one active assignment per worker. After supervisor restart, a running task becomes `unknown`; this is an ownership fence, not a synthetic failure or success. Do not submit follow-up work, wrap up, clean sessions, or remove a worktree until the broker proves the recorded process group stopped. `stop` preserves the exact native session and blocks queued successors; explicitly resubmit the work afterward.

Workers resume only exact persisted identities. OMP needs its actual session file; Claude/Codex resume their broker-recorded native IDs even when no local session file is available. Never use `latest`, `continue`, `fork`, or a fresh session as recovery. A legacy live terminal has no broker-owned process identity; leave it open until the original owner proves it stopped and recovers the exact native identity. Closing an Orca tab is not stop proof.

## Routing

OMP routing is automatic for a routed team. Plain `init` / `init gpt` selects the GPT family; `init claude` selects the Claude model family, not native Claude Code. The model catalog is refreshed and pinned until the next `init` adoption. An exact `init --model M` is fixed and does not auto-route.

- GPT tiers: simple Luna Max, moderate Terra, complex Sol, extreme Astra. Astra has no explicit thinking override.
- Claude tiers: simple/moderate Sonnet, complex Opus, extreme the same latest Opus with `thinking=xhigh`; Haiku is only the lightweight classifier. Initialization fails closed if Opus lacks xhigh support.
- `assign --difficulty simple|moderate|complex|extreme` uses the saved route directly; `assign --model M` is a per-task override. Classification errors, invalid JSON, or a family/map change before dispatch stop the assignment rather than guessing.
- The model family selects worker routes; it does not switch the manager session. OMP headless resume without task-specific thinking reapplies `defaultThinkingLevel` so a prior extreme task's `xhigh` cannot leak into ordinary work.

Difficulty rubric: **simple** for bounded edits or known-file fixes; **moderate** for familiar multi-file integration; **complex** for difficult security, concurrency, architecture, or root-cause work; **extreme** only for exceptionally difficult multi-system failures or formal algorithm/security reasoning.

## Worktree and worker safety

Shared teams bind to the active Orca worktree. Every assignment checks that the team still points to the active worktree and that the selected worker cwd remains inside it. Legacy teams without a recorded worktree are accepted only when their worker cwd is inside the current worktree; the path is then persisted. Isolated workers use their own recorded worktree and cwd. Manager changes are not copied into isolated worktrees; ask each worker for a local commit, review in the manager worktree, then merge/cherry-pick there. Workers never push.

Workers implement only their assigned slice, never manage teams or create nested workers, and touch only assigned files. Delete only brief-listed `May delete:` paths or files created for the assignment. Workers do not ask the user; if blocked, they return `blocked` with the exact need. They return one structured result object with `status`, `summary`, `files_changed`, `files_deleted`, `verification`, `blockers`, and `approval_requests` (plus isolated-worktree `branch`/`commit`). The manager reviews each result against its acceptance check before reporting completion.

Gated commands are `git push`, `ssh`, `scp`, `rsync`, `sftp`, `gh`, and `docker push` (plus `TEAM_BUILDING_GATED_EXTRA`). Even read-only SSH needs approval. Approval is exact, bound to the source task and worker; after user approval, run `approve` and submit a same-worker `assign --approval tNNN` follow-up. PATH shims deter mistakes, not malicious workers: absolute paths and harness-native remote tools can bypass them.

## Dispatch workflow and limits

1. Split a request into independent slices with non-overlapping file ownership. An indivisible task gets one worker.
2. Route ordinary OMP work automatically. Use `--difficulty` only when the tier is already known, or `--model` for a deliberate one-task override. Follow-up work goes to the same worker with `--worker wN` to preserve its session.
3. For parallel slices, launch assignments through the harness's background-job mechanism, then wait for every result; do useful work while they run. No sleep/poll loops and no final reply while an assignment remains pending.
4. Inspect each structured result, integrate/review changes, and report exact verification and blockers. A generic `blocked` result needs manager/user resolution; an approval request needs explicit user approval.

`--timeout` is the idle limit (default 1200 seconds); `--max` is the absolute cap (default 14400 seconds). The supervisor's 60-second wait checkpoint is not a worker failure. `clear` waits for current work before wrap-up. It removes only recorded worker sessions; clean merged isolated worktrees may be removed, while dirty or unmerged worktrees are left in place. A legacy live terminal remains blocked because its process identity is not broker-owned.

Memory bounds: current-thread Tokio, at most 32 IPC clients and 4 active workers, 1 MiB frames, 1024 queued tasks, bounded worker output, and rotated logs. Do not add a persistent Node observer or duplicate control/event queues.
