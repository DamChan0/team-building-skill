---
name: team-building
description: >
  Persistent AI-worker teams in Orca terminals. Use for `team init`, `team status`, `team clear`,
  `team member N`, explicit worker assignments such as "w1에게 …", or Korean requests containing
  팀, 작업자, 워커, or wN. Workers may use omp, Claude Code, or Codex.
---

# team-building

All commands below use `node ~/.agents/skills/team-building/src/main.mjs`. State: `~/.local/state/team-building/<team-id>/`
(team.json, `logs/wN.log`, `briefs/tNNN.md`, `results/*.json`, `sessions/wN/` for omp; Claude Code and Codex use their native session roots). Each worker opens an Orca terminal on its first assignment and pins its native session ID/file plus PTY/pane identity in `team.json`.
Later assignments reuse that terminal. Stale handles are reacquired by the saved identity, never by title or “latest session”. Confirmed exit resumes the exact conversation in noninteractive mode without another tab. Disconnection or missing/ambiguous identity does not prove exit: fail closed instead of starting a concurrent session.
Orca must be running for worktree validation and terminal discovery. Do not bypass a failed gate with `init --new`, `terminal create`, `--continue`, `--last`, or a fresh harness launch.

New shared-team `init` binds workers to the Orca worktree resolved from manager cwd and rejects a cwd outside it. Each launch rejects a change from the team's recorded worktree; legacy state without a recorded worktree is backfilled from the current Orca worktree only when its saved worker cwd is inside it. Isolated workers use only their recorded worktrees.

## Commands (user says → main session runs)

| User | Run (bash tool) |
|---|---|
| `init [--member N] [--model M] [--harness omp\|claude\|codex] [--isolate]` | `node ~/.agents/skills/team-building/src/main.mjs init [--member N] [--model M] [--harness H] [--allow-bypass] [--isolate]` — sync. Active team exists → **adopts it**; `--new` forces another team only when asked. Claude Code/Codex require explicit `--allow-bypass`; omp requires `tools.approvalMode=yolo`. `--isolate` creates one Orca worktree per worker. |
| `team member <N> [--model M] [--harness H]` | `node ~/.agents/skills/team-building/src/main.mjs member N [--model M] [--harness H] [--allow-bypass]` — async; omitted `--harness` retains the team harness. |
| `team status` | `node ~/.agents/skills/team-building/src/main.mjs status` — workers, harness, model (requested → resolved), state, current task, queue, log path. |
| `team clear` | `node ~/.agents/skills/team-building/src/main.mjs clear` — async; wrap-up uses the same idle/absolute budget, closes terminals, writes a report, and removes only that team's sessions. |

`assign --difficulty simple|moderate|complex` routes OMP work only: simple → Luna with `--thinking max`, moderate → Terra, complex → Sol. The manager classifies the brief; do not make a separate model/API classifier call. `assign --model M` is a per-task manual override and wins over `--difficulty`. `init --model M` is a fixed team-wide override, so `--difficulty` fails for that team; use `assign --model` or omit it. Routing without `--worker` requires every eligible worker to be OMP; for mixed teams, select a known OMP worker explicitly. A changed route confirms the existing idle terminal was stopped, then resumes its pinned session with the selected model without opening another tab.

Difficulty rubric: **simple** for bounded edits, known-file fixes, and straightforward tests; **moderate** for multi-file integration or familiar feature work; **complex** only for security, concurrency, architecture, root-cause investigations, or genuinely difficult reasoning.

Model uses the selected harness's `--model`; omitted = its default. Several teams active → `team status` lists them all; pass `--team <id>` to every other command (and `init --team <id>` to adopt one).

`--timeout` is idle time (default 1200 seconds); `--max` is the absolute cap (default 14400 seconds). Choose `--max` from the brief: default for edits, longer for full builds or long tests. On `idle`, first send a follow-up to the same worker.

With `--isolate`, each worker owns its worktree: it must make a local commit and report `branch` and `commit`; never push. Review then run `git merge`/`git cherry-pick` in the manager cwd. Report conflicts. Uncommitted manager changes do not carry into worker worktrees.

## Session start / restart

A new or restarted main session with an explicit team command runs `node ~/.agents/skills/team-building/src/main.mjs status` first. Active team → adopt it with
`init` (never `--new` unless asked). Worker sessions and context survive the main session dying.

## Announced = executed

Every helper command you announce ("w4를 추가합니다", "clear 하겠습니다") must actually run and its output be
checked before your final reply. Never end a turn on an announced but unrun command; verify counts with `team status`.
Never end your turn while an async `assign`/`member`/`clear` is still running: wait for its result with the harness's
background wait/job tool and report it.

## After `init`: dispatch work deliberately

Split independent work into worker briefs. Exception: handle it directly in the main session when it is one already-read file,
about 10 lines or less, and needs no build or long test; say so in one line. “직접 해” means main; “워커에게” means worker first.

1. Read only what is needed to split the command. Split into independent slices with **non-overlapping file ownership**; indivisible → one slice.
2. For every OMP slice, classify the brief with the rubric and include `--difficulty <simple|moderate|complex>` in `assign`. Omit it only for an explicit fixed team `init --model`, or when deliberately supplying a per-task `assign --model`; no external classifier call.
3. One slice → one **sync** bash call, `timeout: 0` (returns the result in the same turn). Several slices → one bash
   call each with `async: true`, `timeout: 0`, all in the same turn, then `wait` for them:
   ```
   node ~/.agents/skills/team-building/src/main.mjs assign [--worker wN] --difficulty <tier> <<'EOF'
   Goal / files you own (only these) / constraints / acceptance check / May delete: path-or-none
   EOF
   ```
   No `--worker` = any idle worker; if none is idle the call queues inside the helper until one frees (no polling needed).
   Follow-up to earlier work → `--worker wN` (that worker keeps its session context).
4. The helper sends the brief to the worker's terminal and waits for its `results/tNNN.json`; helper exit is the
   return signal and the harness injects stdout. Output = one human line + JSON:
   `status` (succeeded|failed|blocked), `summary`, `files_changed`, `files_deleted`, `verification`, `blockers`,
   `approval_requests`, and isolated-worktree `branch`/`commit`, plus `model`, `team`, `worker`, `task`, `duration_s`, `log`.
   Timeout, model error, terminal exit, invalid result file, signal → `failed`. For a generic `blocked` result, answer from context or ask the user, then follow up with the same worker. Approval requests are separate: obtain explicit user approval, run `approve`, then same-worker `assign --approval tNNN`.
5. Review each result against its acceptance check, integrate, report to the user. While slices run, do other useful work; once nothing is left, call the harness's background wait tool for pending jobs — never send the final reply with an assignment still running. No sleep/poll loops.

## Worker contract (injected by the helper)

Workers implement directly, never ask the user (blocked → `blocked` result with the exact need), touch only their slice's files,
never run team-building or spawn teams (the helper also refuses `init/member/assign/clear` when `TEAM_BUILDING_WORKER` is set),
and may delete only brief-listed `May delete:` paths or files they created for the assignment. Gated external work is not forbidden:
return `blocked` with exact `approval_requests`; after the user approves, the manager records it with `approve` and sends a same-worker
follow-up with `--approval tNNN`. They write `files_deleted` in the result JSON at the named `results/tNNN.json` path.

## Limits

- Workers begin in Orca tabs. After confirmed exit or model change, assignments resume headlessly; `status` shows the pinned session/terminal and transport, and output remains in the worker log. Do not type into a busy worker tab.
- One assignment at a time per worker; a follow-up to a busy worker queues behind its current task.
- Permission bypass for Claude Code/Codex is opt-in; omp requires its existing yolo setting.
- `clear` waits for busy workers to finish their current task before their wrap-up and removes only the recorded worker sessions.
- Claude Code and omp expose session errors/models in their JSONL records. Codex's local session record is used for resume and cleanup; if it has no reliable error event, timeout remains the fallback.
- Gated commands are `git push`, `ssh`, `scp`, `rsync`, `sftp`, `gh`, and `docker push` (plus `TEAM_BUILDING_GATED_EXTRA`). PATH shims deter mistakes, not malicious workers: absolute paths and harness-native remote tools (such as `ssh://` URIs) can bypass them; even read-only `ssh` needs approval.
- A SIGKILLed helper is noticed on the next call. A still-live resumed child keeps its worker busy; an uncertain launch marker blocks another resume. Missing identity or an unconfirmed stopped process requires recovery of the original owner, not a fresh session. PID reuse can still hide process death.
