---
name: team-building
description: >
  Cost-aware work router plus persistent AI-worker teams (Rust broker). Picks the lightest executor
  that fits: do it inline, use one persistent worker, a parallel team, or sub-managers coordinating
  multiple teams. Use for team init/status/clear/member, explicit worker assignments such as “w1에게 …”, Korean requests containing 팀, 작업자,
  워커, or wN, or any task where weight vs. cost needs a decision. Workers may use OMP, Claude Code, or Codex.
argument-hint: <task> | init claude --member 3 | member 4 | status | clear | assign --team NAME --worker w1 <task>
---

# team-building

`TB="node ~/.agents/skills/team-building/src/main.mjs"`. The CLI is the whole interface: run it directly. Do not read `src/`, `supervisor/`, or `README.md`; `$TB --help` prints usage, errors state the fix.

## Enforced team routing

Once this skill is invoked or this session manages an active team, delegate only through the team-building CLI. Never replace a team worker with OMP `task`, eval `agent()`/workpool, Claude Code Agent, Codex subagents, or a separately launched helper agent. This rule also covers short tasks: do them inline or assign a persistent worker.

OMP/Pi manager extensions reapply routing instructions each prompt/model turn and reject known host spawn tools before execution. Manager `eval` is also blocked: older OMP releases do not emit the spawn hook for eval/workpool. Use bash for inline calculations or assign eval work to a persistent worker; workers are unaffected. OMP additionally registers `before_subagent_spawn` for runtimes supporting it. `/team-building-mode on` locks routing before a team exists; `off` explicitly releases the lock; `auto` follows active-team ownership. The explicit lock persists through session resume and compaction. Tool output cannot change it.

After Orca Sleep/resume, keep the manager role and team-only delegation. The runtime restores durable session-scoped mode before the first tool; an empty startup branch is not permission to spawn host subagents. Explicit user `off` remains off across resume. Reload/restart an already running manager after setup to load updated hooks.

If the CLI is blocked or a higher-priority rule conflicts, report the blocker instead of switching executors. This does not override system safety rules. Native Claude Code/Codex managers have prompt guidance only: use an OMP/Pi manager for the installed runtime guard. Arbitrary shell execution and third-party extensions are not sandboxed.

## Route first (pick the lightest executor that fits)

Judge scope and execution lifetime separately. Long-running, multi-step, resumable, or explicitly worker-directed work MUST use a persistent team worker even when the code change is otherwise simple. Do not leave it in a one-shot host subagent or an opaque background subagent job. Task complexity still selects model strength; duration selects whether execution needs a persistent worker.

| Tier | Fits | Execute | Team? |
|---|---|---|---|
| **0 trivial** | 1–2 line edit, lookup, known file, answer from context | Do it yourself | no |
| **1 simple** | Short bounded edit/review, one concern, clear acceptance, ≤3 files | Inline, or `assign` to one persistent worker | only if delegated |
| **2 moderate** | Familiar multi-file integration, design judgment, 1–2 slices; or any long-running/resumable task | `init --member 1` for one slice → `assign` (use `--detach` when continuing without blocking) | yes |
| **3 heavy** | Security, concurrency, architecture, root cause, or ≥3 independent slices | `init --member N` (N = independent slices, ≤4) → parallel `assign --worker wK` | yes, N workers |

- Long-running means work expected to take multiple phases, require later follow-up/verification, or remain active while the manager handles other work. If uncertain, prefer the persistent worker; do not classify by file count alone.
- Team exists already (`status`) → reuse it for delegated work, including tier 1. Do not create a team for inline tier 0/1 work.
- Multiple same-path teams: run `status --team NAME` and pass the same `--team NAME` to `assign`; never rely on implicit selection.
- Measured cost (OMP workers): `init` ≈1.3s warm / 3.8s cold model catalog; idle team ≈10MB; each *running* worker ≈500MB RSS and ≥6s per task; `clear --fast` ≈1s vs ≈9s with model wrap-up. Pass `--fast` unless final summaries are needed.
- **Escalate, don't over-provision.** Start at the lowest plausible tier; if the result is `blocked`, fails its Verify, or shows unexpected scope, re-route one tier up (tier 1 → tier 2; same worker `--difficulty complex|extreme` for model strength). **De-escalate** when a team sits idle: `dismiss` surplus workers, `clear` when done.
- Model strength is separate from team size: `--difficulty simple|moderate|complex|extreme` picks the model tier (routed OMP teams only; native Claude/Codex teams ignore routing); omit it and Jev (~0.2s, needs `TYPESAFE_API_KEY`) or the OMP classifier (~5s) decides. Jev sends the brief text to api.typesafe.ai: with sensitive briefs pass `--difficulty` or set `TYPESAFE_API_KEY=` empty. GPT: Luna Max / Terra / Sol / Astra; Claude: Sonnet / Sonnet / Opus / Opus xhigh.

## Multi-team mode

When the user asks for sub-managers or independent teams under one manager, run `init --name NAME --mode multi-team --member N`. Here N counts persistent OMP sub-managers, not implementation workers. Start with the number of independent team goals, usually 2; do not enable this mode for ordinary parallel slices.

- The main manager assigns one goal to each sub-manager with `assign --team NAME --worker wN --detach`, then collects both with `wait --team NAME --all`. Follow-up goals use the same sub-manager.
- Each sub-manager uses `init --member N` to create or adopt its own single child team, then uses the ordinary `assign`/`wait` flow to delegate implementation. Do not do implementation in the sub-manager session.
- A sub-manager can manage only its own child team. Parent/sibling teams, deeper sub-managers, `--clear-previous`, and self-issued `approve` are forbidden. Escalate approval requests to the main manager.
- Parent `status` shows sub-manager/child associations. Parent retirement and `clear --fast` clean up owned child teams before removing the parent. Do not bypass failed cleanup.
- Team mode cannot be changed on adoption. Create a separately named team to switch modes. Sub-managers require OMP; their child implementation workers may use any supported harness. Their routing guard cannot be disabled from the sub-manager session.


## Team commands

| Request | Command |
|---|---|
| `init [gpt|claude] [--name NAME] [--team ID|NAME] [--mode single-team|multi-team] [--member N] [--idle-stop 15m|0] [--model M] [--harness omp|claude|codex] [--allow-bypass] [--isolate] [--clear-previous|--keep-previous]` | Creates another team with `--name` even at this path; repeating a name adopts it. Default `single-team` creates workers; `multi-team` creates sub-managers. Without a selector, adopts the only root team at this path. Teams at other paths still require `--clear-previous` or `--keep-previous`. |
| `member N` / `dismiss --worker wN[,wM...]` | Resize / retire idle workers; `member` restores missing tabs and eagerly starts stopped workers. |
| `status [--team ID\|NAME]` | Workers, state, queue. Run first in a new manager session, then `init` to adopt. |
| `assign [--team ID\|NAME] [--detach] [--worker wN] [--difficulty TIER] [--model M] [--approval tNNN] PROMPT` | Blocks until a structured result by default; `--detach` submits durable work and prints only its task ID. |
| `approve --worker wN --task tNNN -- COMMAND...` | Record a user-approved gated command. |
| `wait [--task tNNN[,tMMM]] [--worker wN] [--all\|--any] [--timeout S]` | Wait for detached work (all by default) and print one compact JSON result per completed task. |
| `clear [--team ID\|NAME] [--fast]` | Wrap up and remove the team; `--fast` uses each worker's latest recorded task result instead of a model wrap-up turn. |

Team names are lowercase slugs (`a-z`, digits, `_`, `-`), unique among active teams on the current backend; values matching generated team IDs are reserved. All team-scoped commands accept `--team ID|NAME`; without it, the current path must have exactly one team.

Requirements: OMP workers need `tools.approvalMode=yolo`; `--harness claude|codex` needs `--allow-bypass`. Workers live in Orca tabs, herdr TUI tabs (`HERDR_ENV=1`), or labeled herdr-app (`hc`) child terminals (`HC_TERMINAL_ID` and `HC_TERMINAL_SOCKET`); teams stay bound to their creating backend (other backend: exit 4; `status`/`init` list only current-backend teams). OMP tabs are live sessions; closing one ends the worker, and `member <current N>` eagerly restarts stopped workers while `assign` resumes them on demand. `init` adoption leaves idle OMP workers stopped. Claude/Codex observers are read-only; closing one does not stop the worker.
`init claude` selects Claude-family models on the interactive OMP harness; `init --harness claude --allow-bypass` uses native Claude Code with a read-only activity observer. Native Codex works the same way.
Idle OMP sessions stop after 15 minutes without a task result by default; `init --idle-stop Nm` configures the timeout and `0` disables it. Idle age is based on the last task result, not terminal activity; `member N` gives restarted workers a fresh interval. `status` shows stopped workers and their idle age.

- In Orca, `init` binds to the manager terminal's `ORCA_WORKTREE_ID`; it exits 4 if `cwd` is outside that worktree or its git top-level differs. Register sibling git worktrees with Orca or run `init` from the manager's worktree. Folder workspaces (`folder:<id>`, e.g. Orca bots) bind to `ORCA_WORKSPACE_ROOT` without the git check; `--isolate` is rejected there.

## Dispatch

1. Split into independent slices with non-overlapping files; indivisible = one worker. Follow-ups go to the same worker (`--worker wN`) to keep its session.
2. Brief = `# Context / # Goal / # Files / # Constraints / # Verify / # Report`. Tier 1 may shrink to Goal + Files + Verify. The worker reads files itself.
3. When the manager can use background bash jobs, run each blocking `assign` as one and wait for notifications. In blocking-only bash, use `assign --detach` once per slice, record each printed task ID, then run one `wait --all`; never add sleep/poll loops.
4. `wait` defaults to all selected detached tasks; select with `--task` and/or `--worker`, or use `--any` to return after the first completion (its status controls the exit code). It exits nonzero for failed, blocked, unknown, or timed-out work; unfinished task IDs remain available for a later `wait`.
5. Review each result (`status`, `summary`, `files_changed`, `verification`, `blockers`, `approval_requests`, `tool_session_cleanup_errors`) against its acceptance check. Cleanup errors mean helper tabs remain open; detached mappings stay retryable.

## Safety

- Workers touch only assigned files, never push, never ask the user; blocked work returns `blocked` with the exact need.
- Gated commands: `git push`, `ssh`, `scp`, `rsync`, `sftp`, `gh`, `docker push`. On `approval_requests`, ask the user; after approval run `approve`, then same-worker `assign --approval tNNN`.
- `--isolate`: one worktree per worker (Orca or herdr TUI); herdr-app (`hc`) supports shared worktrees only.
- `unknown` worker state: do not submit, clear, or clean up until `stop --worker wN` succeeds.
