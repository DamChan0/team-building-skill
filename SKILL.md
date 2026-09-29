---
name: team-building
description: >
  OMP manager/worker team: this session becomes the main (manager-only) session and routes every
  command to persistent omp worker sessions, each its own Orca terminal, that always return a result. Use for `team init`,
  `team_building init`, `member <N>`, bare `member 2`/`member 4`, `team status`, `team clear`, and — whenever an
  active team exists (`~/.local/state/team-building/*/team.json`) — bare `status`, `clear`, 작업자 N명, 워커 N명,
  "w1에게 …", "wN한테 시켜/배정", 작업자에게 배정, assign to worker, 팀 빌딩, 팀 만들어, 작업자 세션, worker sessions.
  Worker ids w1, w2… exist only through this skill's helper. Not the Claude-only `team-builder` agent picker.
---

# team-building

`$H` below = `~/.agents/skills/team-building/team.py` (Python stdlib; write the full path in each command). State: `~/.local/state/team-building/<team-id>/`
(team.json, `logs/wN.log`, `briefs/tNNN.md`, `results/*.json`, `sessions/wN/`). Each worker wN is its own Orca terminal
(interactive `omp`, the worker's model) in the team cwd: opened on its first assign, reused afterwards, closed by
`clear`/shrink/timeout. Needs Orca running: without it `assign` exits 4 (no headless fallback) — tell the user to start
Orca.

## Commands (user says → main session runs)

| User | Run (bash tool) |
|---|---|
| `init [--member N] [--model M]` | `python3 $H init [--member N] [--model M]` — sync. Active team exists → **adopts it** (no new team; `--member`/`--model` resize/switch it). None → new team, 3 workers or N. `--new` forces a new team only when the user asks for another team. "팀 만들어줘, 작업자 4명" = `init --member 4` (one call). |
| `member <N> [--model M]` | `python3 $H member N [--model M]` — async (shrink waits for wrap-up summaries). N 1–8; >4 prints a warning: tell the user the default cap is 4 and continue only if they asked for N. `--model` applies to workers that start a new session (a resumed worker keeps its session's model). |
| `status` | `python3 $H status` — workers, model (requested → resolved), state, current task, queue, log path. |
| `clear` | `python3 $H clear` — async, `timeout: 0`. Wrap-up from every worker, closes their Orca terminals, writes `~/work-notes/team-building/<date>-<team-id>.md`, deletes state and sessions. Report the printed path. |

Model = `omp --model` fuzzy pattern (e.g. `sonnet`, `gpt-5.6-terra`, `openai-codex/gpt-6-luna`); omitted = omp default.
`init` refuses when `tools.approvalMode` is not `yolo`: nobody answers approval prompts in a worker tab, so workers would need a broader approval than the user set.
Relay that as a user decision; never add `--auto-approve`.
Several teams active → `status` lists them all; pass `--team <id>` to every other command (and `init --team <id>` to adopt one).

## Session start / restart

A new or restarted main session with any team command (or a bare `member N`, `status`, `clear`, `작업자 N명`)
runs `python3 $H status` first. Active team → those bare phrases are team commands for it; adopt it with `init`
(never `--new` unless asked). Worker sessions and context survive the main session dying.

## Announced = executed

Every helper command you announce ("w4를 추가합니다", "clear 하겠습니다") must actually run and its output be
checked before your final reply. Never end a turn on an announced but unrun command; verify counts with `status`.
Never end your turn while an async `assign`/`member`/`clear` is still running: wait for its result (harness wait/job
tool) and report it. In headless `omp -p` the process exits after the final reply and kills pending jobs (the task
then shows as `failed`: "wrapper process … died").

## After `init`: every user command goes to workers

The main session is manager only: no implementation, no project edits, no running the assigned work itself.

1. Read only what is needed to split the command. Split into independent slices with **non-overlapping file ownership**; indivisible → one slice.
2. One slice → one **sync** bash call, `timeout: 0` (returns the result in the same turn). Several slices → one bash
   call each with `async: true`, `timeout: 0`, all in the same turn, then `wait` for them:
   ```
   python3 $H assign [--worker wN] <<'EOF'
   Goal / files you own (only these) / constraints / acceptance check to run
   EOF
   ```
   No `--worker` = any idle worker; if none is idle the call queues inside the helper until one frees (no polling needed).
   Follow-up to earlier work → `--worker wN` (that worker keeps its session context).
3. The helper sends the brief to the worker's terminal and waits for its `results/tNNN.json`; helper exit is the
   return signal and the harness injects stdout. Output = one human line + JSON:
   `status` (succeeded|failed|blocked), `summary`, `files_changed`, `verification`, `blockers`, plus
   `model`, `team`, `worker`, `task`, `duration_s`, `log`. Timeout (`--timeout S`, default 3600; closes the
   worker terminal, next assign reopens its session), model error, terminal exit, invalid result file, signal → `failed` result. A bash result with no JSON counts as `failed`; check `status`.
4. `blocked` → answer from context, or ask the user, then send the answer as a follow-up to the same worker.
5. Review each result against its acceptance check, integrate, report to the user. While slices run, do other
   useful work; once nothing is left, call the harness `wait` tool (omp: `wait`) for the pending jobs — never send the
   final reply with an assign still running. No sleep/poll loops.

## Worker contract (injected by the helper via `--append-system-prompt` on the worker's omp)

Workers implement directly, never ask the user (blocked → `blocked` result with the exact need), touch only their
slice's files, never run team-building or spawn teams (the helper also refuses `init/member/assign/clear` when
`TEAM_BUILDING_WORKER` is set), never git push / upload / publish, never delete files, and write the result JSON to the
`results/tNNN.json` path named in the brief.

## Limits

- Workers are visible live in their Orca tabs (omp retitles them `OMP - <dir>`; `status`/team.json hold the handle). Do not type into a busy worker tab.
- One assignment at a time per worker; a follow-up to a busy worker queues behind its current task.
- Safety rules for workers are prompt-level; with `approvalMode: yolo` nothing blocks a disobedient tool call.
- `clear` waits for busy workers to finish their current task before their wrap-up.
- omp keeps prompt history in its own DBs (`~/.omp/agent/*.db`); `clear` removes only sessions and team state.
- A helper killed with SIGKILL is noticed (failed result) only on the next helper call; the worker terminal keeps running; PID reuse can hide it.
