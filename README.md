# team-building

- **Release:** [v0.3.0](https://github.com/DamChan0/team-building-skill/releases/tag/v0.3.0)
- Persistent AI-worker teams managed from one session.
- **Manager hosts:** OMP, Claude Code, and Codex. The `SKILL.md` uses the Agent Skills format supported by [Claude Code](https://code.claude.com/docs/en/skills) and [Codex](https://developers.openai.com/codex/skills).
- **OMP is not needed when Claude Code or Codex is the manager and you select native workers.** OMP remains the default worker backend.
- **Orca remains required in every mode:** run the Orca app and CLI with the active worktree registered.

![team-building concept: the manager splits a user command into briefs, native worker sessions execute them, Orca observer terminals show typed UI messages, and the manager reviews results](concept.webp)

## Weight routing

`SKILL.md` makes the manager pick the lightest executor first: tier 0 inline, tier 1 one-shot host subagent (no team), tier 2 a 1–2 worker team, tier 3 a parallel team sized to the independent slices (≤4). Failed or blocked results escalate one tier; idle workers are dismissed. `--difficulty` chooses model strength independently of team size.

## Execution model

![Rust supervisor architecture: Node manager submits tasks to the Rust daemon, which starts worker CLIs, persists tasks in SQLite, and appends UI records read by the Orca observer.](.archify/architecture-rust-supervisor-20261013-180850/rust-supervisor.png)
[Interactive, source-linked diagram](.archify/architecture-rust-supervisor-20261013-180850/rust-supervisor.html) · [Editable Archify candidate](.archify/architecture-rust-supervisor-20261013-180850/candidate.json).

```mermaid
sequenceDiagram
    participant M as Node manager
    participant S as Rust supervisor
    participant W as Native worker
    participant O as Orca observer
    M->>S: versioned object IPC
    S->>W: private native structured protocol
    W-->>S: validated result + exact session identity
    S-->>M: durable task state/events
    O->>S: view typed UI log
```

- **Manager:** Node.js handles team metadata, model routing, and task submission.
- **Supervisor:** one Rust process owns native worker processes, scheduling, sessions, and durable task state.
- **Worker backends:**
  - `omp` uses OMP RPC and is the default.
  - `claude` launches the native Claude Code CLI with `stream-json`.
  - `codex` launches the native Codex CLI through `app-server` JSON-RPC.
- **Orca:** provides the active worktree and read-only worker tabs. OMP worker tabs redraw the worker's live session transcript with `omp render` whenever the session file grows. Claude/Codex tabs show one typed UI summary line per finished task. Tabs never receive native protocol traffic or `TaskResult` JSON.
- Closing an observer tab does not stop its supervisor-owned worker. To restore closed or missing observers, run `member` with the team's current worker count from the manager, for example `node ~/.agents/skills/team-building/src/main.mjs member 3 --team <team-id>`. Connected observers are reused; native sessions are unchanged. Re-adopting the same team with `init` also restores observers. A live observer without an Orca pane produces a warning instead of launching another viewer; use `orca-ide terminal switch --terminal <handle>` to reveal it.
- Tab titles are `<team-id> <worker-id> session` (OMP) or `<team-id> <worker-id> observer` (Claude/Codex). The launch command restores this title with OSC 0 after shell preexec hooks run. Re-adoption or the next assignment replaces an incorrectly titled viewer (including `exec` or an older log-only OMP tab) without restarting its native worker session.
- **Local IPC:** every request uses an object envelope such as `{ "version": 1, "id": "<uuid>", "type": "<command>", "payload": { ... } }`.
  - Envelopes and payloads must be objects; scalar requests are rejected.
  - Responses and events are correlated objects.
- **Disconnects and retries:**
  - Manager EOF never cancels accepted work.
  - `running` records scheduler dispatch; `started` confirms native prompt acceptance. Integration fixtures wait for `started` before requesting completion.
  - Retrying the same `--request-id` with the identical assignment replays it; a changed assignment conflicts.
  - Queues are FIFO per worker.
- **Restart recovery:**
  - A running task becomes `unknown`, never a synthetic success or failure.
  - It stays fenced until the broker proves its recorded process group stopped.
  - Recovery blocks queued successors and preserves the exact native session.
- **Session resume:**
  - OMP requires its native session file.
  - Claude and Codex resume their exact broker-recorded IDs.
  - Never recover with `latest`, `continue`, or a fresh session.
- **Resource limits:** current-thread Tokio runtime; 32 IPC clients; 4 active workers; 1 MiB protocol frames; 1024 queued tasks; bounded, rotated worker logs; 512 KiB SQLite cache with mmap disabled.

## Requirements and installation

- **Setup prerequisites:** Node.js 20+, npm, Rust/Cargo.
- **Runtime prerequisites:**
  - Node.js 20+.
  - A running Orca app and CLI (`orca-ide`) with the current worktree registered.
  - The selected worker CLI in `PATH` (`omp`, `claude`, or `codex`).
- On Linux, do not use bare `orca`; it is the GNOME screen reader.
- Set `ORCA_CLI_COMMAND` if the Orca CLI binary has another name.
- **Install the skill for Claude Code and Codex** using the [Skills CLI](https://github.com/vercel-labs/skills):

  ```sh
  npx --yes skills add DamChan0/team-building-skill \
    --skill team-building --yes -g \
    -a codex -a claude-code && \
    node ~/.agents/skills/team-building/install.mjs
  ```

  - Claude Code can invoke `/team-building`; Codex can invoke `$team-building` or find it with `/skills`.
  - Start a new manager session after installation if the skill is not yet listed.
- **Update an existing global installation** and rebuild its runtime setup:

  ```sh
  npx --yes skills update team-building --global --yes && \
    node ~/.agents/skills/team-building/install.mjs
  ```

- **The setup script** installs Node dependencies and builds `supervisor/` with `cargo build --release --locked`.
  - The first supervisor use performs the same locked build if the binary is absent.
  - There is no Node transport fallback.
- OMP is not a hard install requirement. If it is missing, setup still installs the skill and prints the OMP install suggestion.
  - Setup also writes an OMP-specific `/team-building` command alias; Claude Code and Codex use the installed `SKILL.md` instead.
- **OMP backend only:** install OMP and set `tools.approvalMode=yolo`; workers cannot answer approval prompts.

  ```sh
  curl -fsSL https://omp.sh/install | sh
  ```

  - See the [OMP quickstart](https://omp.sh/docs/quickstart).


## OMP role badge

- Setup installs an OMP extension that shows a blue `🔧 Role: worker` badge for workers and a bold purple `👑 Role: manager` badge for the active manager session.
- `init` records the manager session, so only that session receives the manager badge for its active team at the current path.
- Restart OMP after installation before the extension loads.

## Choose a worker backend

- `init` defaults to OMP.
- Use `--harness claude` or `--harness codex` for native workers; those worker backends do not need the OMP binary. If OMP is the manager host, OMP is still needed to run that host.
- Native Claude workers require the `claude` CLI. Native Codex workers require the `codex` CLI.
- **Native permissions warning:** `--allow-bypass` is required.
  - Claude Code receives `--dangerously-skip-permissions`.
  - Codex runs with `approval_policy="never"` and `sandbox_mode="danger-full-access"`.
  - These settings disable the native approval/sandbox protections. Use only with trusted tasks and worktrees.
- **Routing distinction:**
  - `init claude` selects Claude models through OMP; it does not select the native Claude Code CLI.
  - Native Claude workers use `init --harness claude --allow-bypass`.
  - GPT/Claude family routing and `assign --difficulty` require OMP workers. Native workers do not use the OMP classifier.

```sh
# OMP workers (default)
node ~/.agents/skills/team-building/src/main.mjs init --member 3

# Native Claude Code workers; no OMP worker
node ~/.agents/skills/team-building/src/main.mjs init --harness claude --allow-bypass --member 3

# Native Codex workers; no OMP worker
node ~/.agents/skills/team-building/src/main.mjs init --harness codex --allow-bypass --member 3
```

## OMP model routing

- Pin the GPT-family map from OMP's cached model catalog (`omp models <provider>`; `omp models refresh` runs only when the cache lacks a role), then let the classifier route each brief:

  ```sh
  node ~/.agents/skills/team-building/src/main.mjs init --member 3
  node ~/.agents/skills/team-building/src/main.mjs assign "Fix the failing parser test"
  ```

- Select the Claude model family for an OMP team with `init claude`:

  ```sh
  node ~/.agents/skills/team-building/src/main.mjs init claude --member 3
  node ~/.agents/skills/team-building/src/main.mjs assign "Review this concurrent cache change"
  ```

- Plain `init` / `init gpt` selects the GPT family.
- An exact `init --model <selector>` creates a fixed-model team and disables automatic routing.
- **GPT tiers:** simple Luna Max, moderate Terra, complex Sol, extreme Astra.
- **Claude tiers:** simple/moderate Sonnet, complex Opus, extreme Opus with `thinking=xhigh`; Haiku is only the lightweight classifier.
- Initialization fails rather than downgrading if the required model or effort is unavailable.
- The saved model map stays stable until the next `init` adoption.
- `assign --difficulty simple|moderate|complex|extreme` uses a saved tier without classification; `assign --model <selector>` overrides the model for one task.
- **Classifier:** with `TYPESAFE_API_KEY` set (environment, or a `TYPESAFE_API_KEY=` line in `~/.env`), a TypeSafe Jev Choice picks the tier in ~0.2s instead of a ~5s `omp -p` call; the brief text is sent to `api.typesafe.ai`. HTTP, timeout (5s), or invalid-answer failures warn and fall back to the OMP classifier. `TYPESAFE_API_KEY=` (empty) disables Jev.
- Invalid classifier output, routing errors, or a changed map fail closed.
- OMP resume reapplies its configured `defaultThinkingLevel`; an earlier extreme task's `xhigh` cannot leak into ordinary work.

## Commands and recovery

```sh
node ~/.agents/skills/team-building/src/main.mjs init [gpt|claude] [--member N] [--model M] [--harness omp|claude|codex] [--allow-bypass] [--isolate] [--clear-previous|--keep-previous]
node ~/.agents/skills/team-building/src/main.mjs member N [--model M] [--harness H] [--allow-bypass]
node ~/.agents/skills/team-building/src/main.mjs dismiss --worker wN[,wM...]
node ~/.agents/skills/team-building/src/main.mjs status [--team ID]
node ~/.agents/skills/team-building/src/main.mjs assign [--worker wN] [--approval tNNN] [--request-id UUID] [--model M] [--difficulty TIER] PROMPT
node ~/.agents/skills/team-building/src/main.mjs approve --worker wN --task tNNN -- COMMAND...
node ~/.agents/skills/team-building/src/main.mjs stop --worker wN [--team ID]
node ~/.agents/skills/team-building/src/main.mjs clear [--team ID] [--fast]
```

- One team per absolute manager path. `init` adopts the current path's team; teams only at other paths make `init` exit 3 until rerun with `--clear-previous` or `--keep-previous`.
- Without `--team`, commands select the current path's team.
- `--timeout` is the idle timeout (default 1200 seconds); `--max` is the absolute cap (default 14400 seconds).
- A 60-second supervisor wait checkpoint is not a worker failure.
- Workers receive `PWD` matching their configured cwd; OMP also receives `--cwd` so launches from the home directory do not relocate to `/tmp`.
- Retry an interrupted submission with the same `--request-id` and identical assignment.
  - A changed prompt, team, worker, model, thinking, difficulty, or approval conflicts rather than rerouting.
  - `assign --approval tNNN` keeps the approved source task and worker bound in the PATH shim.
- **Recover an `unknown` worker:** run `stop --team <id> --worker wN`.
  - The broker verifies native process ownership, blocks queued tasks instead of replaying them, and preserves the exact session.
  - Resubmit follow-up work afterward.
  - A legacy live terminal has no broker-owned process identity and stays blocked.
  - Closing an Orca tab is not proof that its process stopped.

## Worktrees and permissions

- Shared teams bind to the active Orca worktree.
  - Every assignment checks that the team worktree still matches and the selected worker's cwd stays inside it.
- `--isolate` creates a separate Orca worktree per worker.
  - Uncommitted manager changes are not copied into isolated worktrees.
  - Review isolated commits in the manager worktree and merge or cherry-pick locally.
  - Workers never push.
- `clear` removes only clean, merged isolated worktrees; dirty or unmerged worktrees stay in place.
- **Gated external commands:** `git push`, `ssh`, `scp`, `rsync`, `sftp`, `gh`, and `docker push`, plus `TEAM_BUILDING_GATED_EXTRA`.
  - Approval is exact and bound to one worker and source task.
  - Even read-only `ssh` requires approval.
  - PATH shims deter mistakes, not malicious workers; absolute paths and harness-native remote tools can bypass them.

## Runtime files and uninstall

- `~/.local/state/team-building/<team-id>/` — team metadata, approvals, results, worker logs, and session references; `clear` removes this only after verified recovery or retirement.
- `~/.local/state/team-building/supervisor/` — singleton supervisor SQLite database and lock.
  - Tests own their temporary supervisor processes, request `shutdown`, and wait for exit before removing temporary state. Team cleanup does not shut down the shared production supervisor.
- `~/work-notes/team-building/<date>-<team-id>.md` — summary written by `clear`.
- `~/.omp/agent/commands/team-building.md` — generated OMP command alias. `PI_CONFIG_DIR` and `OMP_PROFILE`/`PI_PROFILE` select its config/profile directory. Setup leaves conflicting user-owned aliases unchanged.
- **Uninstall:** run `team clear` first, then `npx skills remove -g team-building`.
  - Remove the generated OMP alias from the commands directory reported by setup.
  - Leave user-owned aliases untouched.
