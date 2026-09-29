---
name: team-building
description: >
  Persistent AI-worker teams in Orca terminals. Use for `team init`, `team status`, `team clear`,
  `team member N`, explicit worker assignments such as "w1에게 …", or Korean requests containing
  팀, 작업자, 워커, or wN. Workers may use omp, Claude Code, or Codex.
---

# team-building

`$H` below = `~/.agents/skills/team-building/team.py` (Python stdlib; write the full path in each command). State: `~/.local/state/team-building/<team-id>/`
(team.json, `logs/wN.log`, `briefs/tNNN.md`, `results/*.json`, `sessions/wN/` for omp; Claude Code and Codex use their native session roots). Each worker wN is an Orca terminal
running its selected harness in the team cwd: opened on first assignment, reused afterwards, closed by `clear`/shrink/timeout.
Needs Orca running: without it `assign` exits 4 (no headless fallback) — tell the user to start Orca.

## Commands (user says → main session runs)

| User | Run (bash tool) |
|---|---|
| `init [--member N] [--model M] [--harness omp\|claude\|codex] [--isolate]` | `python3 $H init [--member N] [--model M] [--harness H] [--allow-bypass] [--isolate]` — sync. Active team exists → **adopts it**; `--new` forces another team only when asked. Claude Code/Codex require explicit `--allow-bypass`; omp requires `tools.approvalMode=yolo`. `--isolate` creates one Orca worktree per worker. |
| `team member <N> [--model M] [--harness H]` | `python3 $H member N [--model M] [--harness H] [--allow-bypass]` — async; omitted `--harness` retains the team harness. |
| `team status` | `python3 $H status` — workers, harness, model (requested → resolved), state, current task, queue, log path. |
| `team clear` | `python3 $H clear` — async; wrap-up uses the same idle/absolute budget, closes terminals, writes a report, and removes only that team's sessions. |

Model uses the selected harness's `--model`; omitted = its default. Several teams active → `team status` lists them all; pass `--team <id>` to every other command (and `init --team <id>` to adopt one).

`--timeout` is idle time (default 1200 seconds); `--max` is the absolute cap (default 14400 seconds). Choose `--max` from the brief: default for edits, longer for full builds or long tests. On `idle`, first send a follow-up to the same worker.

With `--isolate`, each worker owns its worktree: it must make a local commit and report `branch` and `commit`; never push. Review then run `git merge`/`git cherry-pick` in the manager cwd. Report conflicts. Uncommitted manager changes do not carry into worker worktrees.

## Session start / restart

A new or restarted main session with an explicit team command runs `python3 $H status` first. Active team → adopt it with
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
2. One slice → one **sync** bash call, `timeout: 0` (returns the result in the same turn). Several slices → one bash
   call each with `async: true`, `timeout: 0`, all in the same turn, then `wait` for them:
   ```
   python3 $H assign [--worker wN] <<'EOF'
   Goal / files you own (only these) / constraints / acceptance check / May delete: path-or-none
   EOF
   ```
   No `--worker` = any idle worker; if none is idle the call queues inside the helper until one frees (no polling needed).
   Follow-up to earlier work → `--worker wN` (that worker keeps its session context).
3. The helper sends the brief to the worker's terminal and waits for its `results/tNNN.json`; helper exit is the
   return signal and the harness injects stdout. Output = one human line + JSON:
   `status` (succeeded|failed|blocked), `summary`, `files_changed`, `files_deleted`, `verification`, `blockers`,
   `approval_requests`, and isolated-worktree `branch`/`commit`, plus `model`, `team`, `worker`, `task`, `duration_s`, `log`.
   Timeout, model error, terminal exit, invalid result file, signal → `failed`. For a generic `blocked` result, answer from context or ask the user, then follow up with the same worker. Approval requests are separate: obtain explicit user approval, run `approve`, then same-worker `assign --approval tNNN`.
4. Review each result against its acceptance check, integrate, report to the user. While slices run, do other useful work; once nothing is left, call the harness's background wait tool for pending jobs — never send the final reply with an assignment still running. No sleep/poll loops.

## Worker contract (injected by the helper)

Workers implement directly, never ask the user (blocked → `blocked` result with the exact need), touch only their slice's files,
never run team-building or spawn teams (the helper also refuses `init/member/assign/clear` when `TEAM_BUILDING_WORKER` is set),
and may delete only brief-listed `May delete:` paths or files they created for the assignment. Gated external work is not forbidden:
return `blocked` with exact `approval_requests`; after the user approves, the manager records it with `approve` and sends a same-worker
follow-up with `--approval tNNN`. They write `files_deleted` in the result JSON at the named `results/tNNN.json` path.

## Limits

- Workers are visible live in their Orca tabs; `status`/team.json hold the handle. Do not type into a busy worker tab.
- One assignment at a time per worker; a follow-up to a busy worker queues behind its current task.
- Permission bypass for Claude Code/Codex is opt-in; omp requires its existing yolo setting.
- `clear` waits for busy workers to finish their current task before their wrap-up and removes only the recorded worker sessions.
- Claude Code and omp expose session errors/models in their JSONL records. Codex's local session record is used for resume and cleanup; if it has no reliable error event, timeout remains the fallback.
- Gated commands are `git push`, `ssh`, `scp`, `rsync`, `sftp`, `gh`, and `docker push` (plus `TEAM_BUILDING_GATED_EXTRA`). PATH shims deter mistakes, not malicious workers: absolute paths and harness-native remote tools (such as `ssh://` URIs) can bypass them; even read-only `ssh` needs approval.
- A helper killed with SIGKILL is noticed (failed result) only on the next helper call; the worker terminal keeps running; PID reuse can hide it.
