---
name: team-building
description: >
  Cost-aware work router plus persistent AI-worker teams (Rust broker). Picks the lightest executor
  that fits: do it inline, one-shot subagent, small team, or parallel team. Use for team init/status/
  clear/member, explicit worker assignments such as “w1에게 …”, Korean requests containing 팀, 작업자,
  워커, or wN, or any task where weight vs. cost needs a decision. Workers may use OMP, Claude Code, or Codex.
argument-hint: <task> | init claude --member 3 | member 4 | status | clear | assign --worker w1 <task>
---

# team-building

`TB="node ~/.agents/skills/team-building/src/main.mjs"`. The CLI is the whole interface: run it directly. Do not read `src/`, `supervisor/`, or `README.md`; `$TB --help` prints usage, errors state the fix.

## Route first (pick the lightest tier that holds)

Judge from the task, not its length. No classifier call needed for tier 0/1.

| Tier | Fits | Execute | Team? |
|---|---|---|---|
| **0 trivial** | 1–2 line edit, lookup, known file, answer from context | Do it yourself | no |
| **1 simple** | Bounded edit/review, one concern, clear acceptance, ≤3 files | One host subagent (OMP `task`, Claude Code Agent, Codex subagent), one-shot | no |
| **2 moderate** | Familiar multi-file integration, needs design judgment, 1–2 slices | `init --member 2` (reuse existing) → `assign` | yes, 1–2 workers |
| **3 heavy** | Security, concurrency, architecture, root cause, or ≥3 independent slices | `init --member N` (N = independent slices, ≤4) → parallel `assign --worker wK` | yes, N workers |

- Team exists already (`status`) → reuse it for tier 2/3; never `init` for tier 0/1.
- Measured cost (OMP workers): `init` ≈1.3s warm / 3.8s cold model catalog; idle team ≈10MB; each *running* worker ≈500MB RSS and ≥6s per task; `clear --fast` ≈1s vs ≈9s with model wrap-up. Pass `--fast` unless final summaries are needed.
- **Escalate, don't over-provision.** Start at the lowest plausible tier; if the result is `blocked`, fails its Verify, or shows unexpected scope, re-route one tier up (tier 1 → tier 2; same worker `--difficulty complex|extreme` for model strength). **De-escalate** when a team sits idle: `dismiss` surplus workers, `clear` when done.
- Model strength is separate from team size: `--difficulty simple|moderate|complex|extreme` picks the model tier (routed OMP teams only; native Claude/Codex teams ignore routing); omit it and Jev (~0.2s, needs `TYPESAFE_API_KEY`) or the OMP classifier (~5s) decides. Jev sends the brief text to api.typesafe.ai: with sensitive briefs pass `--difficulty` or set `TYPESAFE_API_KEY=` empty. GPT: Luna Max / Terra / Sol / Astra; Claude: Sonnet / Sonnet / Opus / Opus xhigh.

## Commands (tier 2/3 only)

| Request | Command |
|---|---|
| `init [gpt\|claude] [--member N] [--model M] [--harness omp\|claude\|codex] [--allow-bypass] [--isolate] [--clear-previous\|--keep-previous]` | Defaults: 3 OMP workers, GPT routing. Adopts this path's team. Exit 3 = teams at other paths: ask user, rerun with `--clear-previous` or `--keep-previous`. Pass `--member` explicitly; do not accept the default 3 for tier 2. |
| `member N` / `dismiss --worker wN[,wM]` | Resize / retire idle workers; `member` restores missing tabs. |
| `status [--team ID]` | Workers, state, queue. Run first in a new manager session, then `init` to adopt. |
| `assign [--worker wN] [--difficulty TIER] [--model M] [--approval tNNN] PROMPT` | Blocks until structured result; busy worker queues. |
| `approve --worker wN --task tNNN -- COMMAND...` | Record a user-approved gated command. |
| `stop --worker wN` | Recover an `unknown` worker, then resubmit. |
| `clear [--team ID] [--fast]` | Wrap up and remove the team; `--fast` uses each worker's latest recorded task result instead of a model wrap-up turn. |

Requirements: OMP workers need `tools.approvalMode=yolo`; `--harness claude|codex` needs `--allow-bypass`. Orca tabs are read-only observers; closing one does not stop the worker (`member <current N>` reopens).

## Dispatch

1. Split into independent slices with non-overlapping files; indivisible = one worker. Follow-ups go to the same worker (`--worker wN`) to keep its session.
2. Brief = `# Context / # Goal / # Files / # Constraints / # Verify / # Report`. Tier 1 may shrink to Goal + Files + Verify. The worker reads files itself.
3. Run each `assign` as a background job (bash `async: true`); wait for notifications. No sleep/poll loops; no final reply while an assignment is pending.
4. Review each result (`status`, `summary`, `files_changed`, `verification`, `blockers`, `approval_requests`) against its acceptance check before reporting.

## Safety

- Workers touch only assigned files, never push, never ask the user; blocked work returns `blocked` with the exact need.
- Gated commands: `git push`, `ssh`, `scp`, `rsync`, `sftp`, `gh`, `docker push`. On `approval_requests`, ask the user; after approval run `approve`, then same-worker `assign --approval tNNN`.
- Backend: herdr when the manager runs inside a herdr pane (`HERDR_ENV=1`), Orca otherwise. A team stays bound to the backend it was created under; commands from the other backend exit 4, and `status`/`init` list only this backend's teams.
- `--isolate`: one worktree per worker (Orca or herdr); ask for a local commit, then merge/cherry-pick in the manager worktree.
- `unknown` worker state: do not submit, clear, or clean up until `stop --worker wN` succeeds.
