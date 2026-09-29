#!/usr/bin/env python3
"""team-building helper: persistent harness-neutral workers driven by one manager session."""
import argparse
import contextlib
import datetime
import fcntl
import json
import os
import re
import shlex
import shutil
import signal
import subprocess
import sys
import threading
import time
from pathlib import Path
import uuid

STATE_ROOT = Path.home() / ".local/state/team-building"
NOTES_DIR = Path.home() / "work-notes/team-building"
OMP_SESSION_POINTERS = Path.home() / ".omp/agent/custom-session-files"
DEFAULT_WORKERS, MAX_WORKERS, WARN_WORKERS = 3, 8, 4
DEFAULT_TIMEOUT, DEFAULT_MAX = 1200, 14400
WORKER_ENV = "TEAM_BUILDING_WORKER"
STATUSES = ("succeeded", "failed", "blocked")
ORCA = os.environ.get("ORCA_CLI_COMMAND") or "orca-ide"  # never bare `orca`: on Linux that is the GNOME screen reader
POLL_S, ALIVE_EVERY_S = 2, 15
GATED = ("git", "ssh", "scp", "rsync", "sftp", "gh", "docker")

CONTRACT = """You are team-building worker {wid} of team {team}. A manager assigns work by sending one line that points to a brief file; write the result file named in that brief. Your context persists across assignments in this team.
Rules:
- Do the assigned work directly. Never run team-building init/member/assign/approve/clear or create another team or worker session.
- You cannot ask the user. When blocked, write status "blocked", including approval_requests with exact command argv string, target, and why.
- Touch only assigned files. You MAY delete only paths explicitly listed after `May delete:` in the brief, or files you created for this assignment. Never remove a directory wholesale or change git history.
- Remote/external commands require manager approval. For an unapproved gated command, do not retry it: return blocked with approval_requests. Local work needs no approval.
- In an isolated worktree, make a local commit and report its branch and commit.
- Write exactly one JSON object to the result path (via .tmp then rename):
{{"status":"succeeded|failed|blocked","summary":"...","files_changed":["path"],"files_deleted":["path"],"verification":"...","blockers":[],"approval_requests":[],"branch":"","commit":""}}"""

WRAPUP = ("Wrap-up: this worker is being shut down. Do not start new work. Return a final summary of ALL work you did "
          "across every assignment in this team (what was done, files changed, verification, open issues) in the required "
          "JSON block. Use status succeeded unless something you were given is unfinished (then blocked or failed).")


def die(msg, code=2):
    print(f"team-building: {msg}", file=sys.stderr)
    sys.exit(code)


def now():
    return datetime.datetime.now().isoformat(timespec="seconds")


@contextlib.contextmanager
def locked(team_dir):
    with open(team_dir / "lock", "a") as fh:
        fcntl.flock(fh, fcntl.LOCK_EX)
        yield


def load(team_dir):
    return json.loads((team_dir / "team.json").read_text())


def save(team_dir, data):
    tmp = team_dir / "team.json.tmp"
    tmp.write_text(json.dumps(data, indent=2, ensure_ascii=False))
    tmp.replace(team_dir / "team.json")


def resolve_team(team_id):
    if team_id:
        if not re.fullmatch(r"tb-\d{4}-\d{6}", team_id):  # never let --team point outside STATE_ROOT
            die(f"bad team id {team_id!r} (expected tb-MMDD-HHMMSS)")
        team_dir = STATE_ROOT / team_id
        if not (team_dir / "team.json").exists():
            die(f"no team {team_id!r} under {STATE_ROOT}")
        return team_dir
    teams = active_teams()
    if not teams:
        die("no active team; run `team.py init` first")
    if len(teams) > 1:
        die("several teams active, pass --team: " + ", ".join(p.name for p in teams))
    return teams[0]


def forbid_in_worker():
    if os.environ.get(WORKER_ENV):
        die(f"refused: running inside worker {os.environ[WORKER_ENV]}; workers cannot manage teams (no recursion)")


def pid_alive(pid):
    try:
        os.kill(pid, 0)
        return True
    except (OSError, TypeError):
        return False


def new_worker(team_dir, data, harness=None, cwd=None):
    wid = f"w{data['next_worker']}"  # monotonic: a retired id is never reused, so its final report is kept
    data["next_worker"] += 1
    harness = harness or data.get("harness", "omp")
    data["workers"][wid] = {
        "id": wid, "model": data.get("model"), "resolved_model": None, "state": "idle", "task": None,
        "task_prompt": None, "pid": None, "retiring": False, "assignments": 0,
        "session_dir": str(team_dir / "sessions" / wid), "log": str(team_dir / "logs" / f"{wid}.log"),
        "harness": harness, "session_id": HARNESSES[harness]["session_id"](), "session_file": None,
        "cwd": cwd or data.get("cwd"), "worktree": None, "approval_task": None,
    }


def worker_index(wid):
    return int(wid[1:])


def harness_files(worker):
    config = HARNESSES[worker.get("harness", "omp")]
    return config["files"](config, worker)


def has_session(worker):
    return bool(harness_files(worker))


def write_result(team_dir, result):
    (team_dir / "results" / f"{result['task']}.json").write_text(json.dumps(result, indent=2, ensure_ascii=False))


def failed(summary, blockers=()):
    return {"status": "failed", "summary": summary, "files_changed": [], "files_deleted": [],
            "verification": "", "blockers": list(blockers), "approval_requests": []}


def reap_stale(team_dir, data):
    """Free work owned by dead wrapper processes (e.g. SIGKILL): kill the orphaned omp, write a failed result,
    and drop queue entries whose waiting wrapper is gone so they cannot block the queue."""
    data["queue"] = [q for q in data["queue"] if pid_alive(q.get("pid"))]
    for w in data["workers"].values():
        if w["state"] == "busy" and not pid_alive(w["pid"]):
            res = failed(f"wrapper process {w['pid']} died before returning a result")
            res.update(team=data["id"], worker=w["id"], task=w["task"], kind="task", finished=now())
            write_result(team_dir, res)
            with contextlib.suppress(OSError, TypeError):
                os.killpg(w.get("child"), signal.SIGKILL)
            w.update(state="idle", task=None, task_prompt=None, pid=None, child=None)


def choose(data, task_id, kind):
    """-> ("take", wid) | ("wait", None) | ("fail", reason). Queue order, pinned (--worker) entries first."""
    workers = data["workers"]
    taken = set()
    for entry in sorted(data["queue"], key=lambda e: e["worker"] is None):  # pinned follow-ups claim first
        pref = entry["worker"]
        if pref:
            w = workers.get(pref)
            if w is None:
                cand, reason = None, f"worker {pref} does not exist (retired or never spawned)"
            elif w["retiring"] and entry["kind"] != "final":
                cand, reason = None, f"worker {pref} is being retired"
            else:
                cand, reason = (pref if w["state"] == "idle" and pref not in taken else None), None
        else:
            live = [w for w in workers.values() if not w["retiring"]]
            reason = None if live else "no active workers left (team is closing or shrunk to zero)"
            idle = sorted((w for w in live if w["state"] == "idle" and w["id"] not in taken),
                          key=lambda w: (w["assignments"], worker_index(w["id"])))
            cand = idle[0]["id"] if idle else None
        if entry["task"] == task_id:
            if reason:
                return "fail", reason
            return ("take", cand) if cand else ("wait", None)
        if cand:
            taken.add(cand)
    return "fail", "task vanished from queue"


def parse_result(text):
    """Last JSON object in the final message (fenced block preferred) normalised to the result schema."""
    cands = [m.group(1) for m in re.finditer(r"```(?:json)?\s*(\{.*?\})\s*```", text, re.S)][::-1]
    cands += [text[m.start():] for m in re.finditer(r"(?m)^\s*\{", text)][::-1]
    dec = json.JSONDecoder()
    for c in cands:
        try:
            obj, _ = dec.raw_decode(c.strip())
        except ValueError:
            continue
        if isinstance(obj, dict) and obj.get("status") in STATUSES:
            as_list = lambda v: [] if v in (None, "", []) else [str(x) for x in v] if isinstance(v, list) else [str(v)]
            ver = obj.get("verification", "")
            approvals = obj.get("approval_requests", [])
            return {"status": obj["status"], "summary": str(obj.get("summary", "")).strip(),
                    "files_changed": as_list(obj.get("files_changed")), "files_deleted": as_list(obj.get("files_deleted")),
                    "verification": "; ".join(map(str, ver)) if isinstance(ver, list) else str(ver or ""),
                    "blockers": as_list(obj.get("blockers")), "approval_requests": approvals if isinstance(approvals, list) else [],
                    "branch": str(obj.get("branch") or ""), "commit": str(obj.get("commit") or "")}
    return None


def write_shims(team_dir, data):
    shim = team_dir / "shim"
    shim.mkdir(exist_ok=True)
    extra = tuple(x for x in os.environ.get("TEAM_BUILDING_GATED_EXTRA", "").split() if x)
    data["gated"] = list(dict.fromkeys((*GATED, *extra)))
    script = """#!{python}
import json, os, shutil, sys
from pathlib import Path
team, wid = os.environ.get("TEAM_BUILDING_WORKER", "/").split("/", 1)
root = Path.home() / ".local/state/team-building" / team
name, argv = Path(sys.argv[0]).name, [Path(sys.argv[0]).name, *sys.argv[1:]]
def command_subcommand(args, values):
    i = 0
    while i < len(args):
        arg = args[i]
        if arg in values and i + 1 < len(args): i += 2
        elif any(arg.startswith(option + "=") for option in values) or arg.startswith("-"): i += 1
        else: return arg, i
    return "", i
def git_push(args):
    return command_subcommand(args, ("-C", "-c", "--git-dir", "--work-tree", "--namespace", "--super-prefix", "--config-env", "--exec-path"))[0] == "push"
def docker_push(args):
    command, command_i = command_subcommand(args, ("--context", "--host", "-H", "--config", "--log-level", "--tlscacert", "--tlscert", "--tlskey"))
    return command == "push" or (command == "image" and command_subcommand(args[command_i + 1:], ())[0] == "push")
gate = name not in ("git", "docker") or (git_push(argv[1:]) if name == "git" else docker_push(argv[1:]))
try:
    data = json.loads((root / "team.json").read_text()); worker = data["workers"][wid]
    task = worker.get("approval_task") or worker.get("task")
    approval = json.loads((root / "approvals" / (task + ".json")).read_text()) if task else {{}}
    approved = approval.get("commands", []) if approval.get("worker") == wid else []
except Exception: approved = []
if gate and argv not in approved:
    print("BLOCKED: needs approval — return blocked with approval_requests", file=sys.stderr)
    raise SystemExit(126)
shim = str(root / "shim")
path = os.pathsep.join(p for p in os.environ.get("PATH", "").split(os.pathsep) if os.path.abspath(p) != shim)
real = shutil.which(name, path=path)
if not real: raise SystemExit(127)
os.execvpe(real, argv, dict(os.environ, PATH=path))
""".format(python=sys.executable)
    (shim / "run.py").write_text(script)
    os.chmod(shim / "run.py", 0o755)
    for name in data["gated"]:
        link = shim / name
        if link.is_symlink() and os.readlink(link) == "run.py":
            continue
        tmp = shim / f".{name}.tmp"
        with contextlib.suppress(FileNotFoundError):
            tmp.unlink()
        tmp.symlink_to("run.py")
        tmp.replace(link)


class OrcaError(Exception):
    pass


def orca(*args, timeout=60):
    try:
        p = subprocess.run([ORCA, *args, "--json"], capture_output=True, text=True, timeout=timeout)
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise OrcaError(f"{ORCA} {' '.join(args[:2])}: {exc}") from None
    with contextlib.suppress(ValueError):
        out = json.loads(p.stdout)
        if p.returncode == 0 and out.get("ok"):
            return out["result"]
    raise OrcaError(f"{ORCA} {' '.join(args[:2])} failed: {(p.stderr or p.stdout).strip()[-300:]}")


def require_orca():
    try:
        st = orca("status")
        ok = st["app"]["running"] and st["runtime"]["reachable"]
    except (OrcaError, KeyError, TypeError) as exc:
        die(f"Orca is not available ({exc}); team workers run as Orca terminal sessions. Start Orca (`{ORCA} open`) and retry.", 4)
    if not ok:
        die(f"Orca is not running/reachable; start it (`{ORCA} open`) and retry.", 4)


def terminal_alive(handle):
    if not handle:
        return False
    try:
        term = orca("terminal", "show", "--terminal", handle).get("terminal", {})
    except OrcaError:
        return False
    return term.get("connected", True) and not term.get("exited") and term.get("exitCode") is None


def close_terminal(handle):
    if handle:
        with contextlib.suppress(OrcaError):
            orca("terminal", "close", "--terminal", handle, "--tab")


def omp_files(config, worker):
    return list(Path(worker["session_dir"]).glob("*.jsonl"))


def claude_files(config, worker):
    return list(config["session_root"].glob(f"**/{worker['session_id']}.jsonl")) if worker.get("session_id") else []


def codex_files(config, worker):
    return [Path(worker["session_file"])] if worker.get("session_file") else []


def omp_argv(config, worker, contract):
    Path(worker["session_dir"]).mkdir(parents=True, exist_ok=True)
    cmd = [config["command"], "--no-title", "--session-dir", worker["session_dir"], "--append-system-prompt", contract]
    return cmd + (["-c"] if config["files"](config, worker) else [])


def claude_argv(config, worker, contract):
    cmd = [config["command"], "--append-system-prompt", contract, config["bypass"]]
    return cmd + (["--resume", worker["session_id"]] if config["files"](config, worker) else ["--session-id", worker["session_id"]])


def codex_argv(config, worker, contract):
    cmd = [config["command"], "-c", f"developer_instructions={json.dumps(contract)}", config["bypass"]]
    return ([config["command"], "resume", "-c", f"developer_instructions={json.dumps(contract)}", config["bypass"], worker["session_id"]]
            if worker.get("session_id") else cmd)


def record_none(config, team_dir, worker, cwd, since):
    return None


def record_codex_session(config, team_dir, worker, cwd, since):
    if worker.get("session_id"):
        return
    files = sorted(config["session_root"].glob("**/rollout-*.jsonl"), key=lambda p: p.stat().st_mtime)
    for path in reversed(files):
        if path.stat().st_mtime < since:
            break
        with contextlib.suppress(OSError, ValueError, KeyError):
            meta = json.loads(path.open().readline())
            if meta["payload"]["cwd"] == cwd:
                worker["session_id"] = meta["payload"]["session_id"]
                worker["session_file"] = str(path)
                with locked(team_dir):
                    data = load(team_dir)
                    data["workers"][worker["id"]].update(session_id=worker["session_id"], session_file=worker["session_file"])
                    save(team_dir, data)
                return


def cleanup_omp(config, worker):
    session = Path(worker["session_dir"])
    drop_session_pointers(session)
    shutil.rmtree(session, ignore_errors=True)


def cleanup_recorded(config, worker):
    for path in config["files"](config, worker):
        with contextlib.suppress(OSError):
            path.unlink()


def normalize_omp(record):
    message = record.get("message") or record.get("payload") or {}
    return {"timestamp": message.get("timestamp", 0) / 1000, "model": message.get("model") or message.get("model_id"),
            "stopReason": message.get("stopReason"), "errorMessage": message.get("errorMessage", "")}


def normalize_claude(record):
    message = record.get("message") or {}
    stamp = record.get("timestamp") or message.get("timestamp") or ""
    with contextlib.suppress(ValueError):
        stamp = datetime.datetime.fromisoformat(stamp.replace("Z", "+00:00")).timestamp()
    return {"timestamp": stamp if isinstance(stamp, (int, float)) else 0, "model": message.get("model"),
            "stopReason": message.get("stop_reason"), "errorMessage": message.get("error", "")}


def normalize_codex(record):
    return {"timestamp": 0, "model": None, "stopReason": None, "errorMessage": ""}


HARNESSES = {
    "omp": {"command": "omp", "bypass": None, "files": omp_files, "argv": omp_argv, "record": record_none,
            "normalize": normalize_omp, "cleanup": cleanup_omp, "session_id": lambda: None},
    "claude": {"command": "claude", "bypass": "--dangerously-skip-permissions",
               "session_root": Path.home() / ".claude" / "projects", "files": claude_files, "argv": claude_argv,
               "record": record_none, "normalize": normalize_claude, "cleanup": cleanup_recorded,
               "session_id": lambda: str(uuid.uuid4())},
    "codex": {"command": "codex", "bypass": "--dangerously-bypass-approvals-and-sandbox",
              "session_root": Path(os.environ.get("CODEX_HOME", Path.home() / ".codex")) / "sessions", "files": codex_files, "argv": codex_argv,
              "record": record_codex_session, "normalize": normalize_codex, "cleanup": cleanup_recorded,
              "session_id": lambda: None},
}


def agent_command(team, worker):
    config = HARNESSES[worker.get("harness", "omp")]
    contract = CONTRACT.format(wid=worker["id"], team=team)
    cmd = config["argv"](config, worker, contract)
    if worker.get("model"):
        cmd += ["--model", worker["model"]]
    return ["env", f"{WORKER_ENV}={team}/{worker['id']}", f"PATH={STATE_ROOT / team / 'shim'}:{os.environ.get('PATH', '')}", *cmd]



def ensure_terminal(team_dir, team, worker, cwd, worktree):
    """Reuse wN's live terminal or start its selected harness."""
    if terminal_alive(worker.get("terminal")):
        return worker["terminal"]
    config = HARNESSES[worker.get("harness", "omp")]
    started = time.time()
    res = orca("terminal", "create", "--worktree", f"path:{worktree}", "--title", f"{team} {worker['id']}",
               "--command", f"cd {shlex.quote(cwd)} && exec {shlex.join(agent_command(team, worker))}")
    handle = (res.get("terminal") or res)["handle"]
    with contextlib.suppress(OrcaError):
        orca("terminal", "wait", "--terminal", handle, "--for", "tui-idle", "--timeout-ms", "90000", timeout=100)
    config["record"](config, team_dir, worker, cwd, started)
    with locked(team_dir):
        data = load(team_dir)
        if worker["id"] in data["workers"]:
            data["workers"][worker["id"]]["terminal"] = handle
            save(team_dir, data)
    worker["terminal"] = handle
    return handle


def last_assistant(worker):
    """Last harness session record normalized by its harness adapter."""
    files = sorted(harness_files(worker), key=lambda p: p.stat().st_mtime)
    for line in reversed(files[-1].read_text(errors="replace").splitlines() if files else []):
        with contextlib.suppress(ValueError, AttributeError):
            record = json.loads(line)
            message = record.get("message") or record.get("payload") or {}
            if message.get("role") == "assistant" or message.get("type") in ("agent_message", "error"):
                config = HARNESSES[worker.get("harness", "omp")]
                return config["normalize"](record)
    return None


def session_model(worker):
    return (last_assistant(worker) or {}).get("model")


def run_terminal(team_dir, worker, cwd, task_id, prompt, timeout, maximum, log):
    """Run one assignment in wN's Orca terminal; timeout is idle, maximum is absolute."""
    team = team_dir.name
    out = team_dir / "results" / f"{task_id}.json"
    brief = team_dir / "briefs" / f"{task_id}.md"
    brief.parent.mkdir(exist_ok=True)
    approval = worker.get("approval_task")
    approval_note = f"\nApproved source task: `{approval}`; exact approved argv are in `{team_dir / 'approvals' / (approval + '.json')}`.\n" if approval else ""
    brief.write_text(f"# [team {team} / {worker['id']} / {task_id}]\n\n{prompt}{approval_note}\n---\n"
                     f"When finished, write the result JSON object (worker contract) to `{out}` "
                     f"(write `{out}.tmp`, then rename). That file is the assignment-result channel.\n")
    handle = ensure_terminal(team_dir, team, worker, cwd, worker.get("worktree") or load(team_dir).get("worktree") or cwd)
    log.write(f"[terminal {handle}] brief {brief}\n")
    with contextlib.suppress(OrcaError):
        orca("terminal", "wait", "--terminal", handle, "--for", "tui-idle", "--timeout-ms", "30000", timeout=40)
    cursor = 0
    with contextlib.suppress(OrcaError, TypeError, ValueError):
        read = orca("terminal", "read", "--terminal", handle, "--cursor", "0")
        terminal = read.get("terminal", read)
        cursor = int(terminal.get("nextCursor", cursor))
    sent = last_activity = time.time()
    next_alive = sent + ALIVE_EVERY_S
    session_mtime = max((p.stat().st_mtime for p in harness_files(worker)), default=0)
    orca("terminal", "send", "--terminal", handle, "--text", f"Assignment {task_id}: read {brief} and do it.", "--enter")
    while True:
        if out.exists():
            text = out.read_text(errors="replace")
            res = parse_result(text)
            if res is not None:
                return res, session_model(worker)
            if time.time() - out.stat().st_mtime > 5:
                return failed("worker wrote an invalid result file", [f"result file tail: {text[-800:]}"]), session_model(worker)
        now_t = time.time()
        if now_t - sent >= maximum:
            close_terminal(handle)
            return failed(f"max timeout after {maximum}s; worker terminal closed"), session_model(worker)
        if now_t >= next_alive:
            next_alive = now_t + ALIVE_EVERY_S
            if not terminal_alive(handle):
                return failed("worker terminal exited before writing a result (bad model, crash, or closed tab)"), session_model(worker)
            activity = []
            with contextlib.suppress(OrcaError, TypeError, ValueError):
                read = orca("terminal", "read", "--terminal", handle, "--cursor", str(cursor))
                terminal = read.get("terminal", read)
                new_cursor = int(terminal.get("nextCursor", cursor))
                if new_cursor > cursor:
                    activity.append(f"cursor {cursor}->{new_cursor}")
                    cursor = new_cursor
            mtime = max((p.stat().st_mtime for p in harness_files(worker)), default=0)
            if mtime > session_mtime:
                activity.append(f"session mtime {session_mtime}->{mtime}")
                session_mtime = mtime
            if activity:
                last_activity = now_t
                log.write(f"[activity] {', '.join(activity)}\n")
            m = last_assistant(worker)
            if m and m.get("timestamp", 0) >= sent and m.get("stopReason") in ("error", "aborted"):
                return failed(f"model run {m['stopReason']}: {m.get('errorMessage', '')}"[:500]), session_model(worker)
        if now_t - last_activity >= timeout:
            close_terminal(handle)
            return failed(f"idle timeout after {timeout}s; worker terminal closed"), session_model(worker)
        time.sleep(POLL_S)


def run_assignment(team_dir, pref, prompt, timeout, maximum, kind="task", approval=None):
    """Queue, wait for a worker, run, record. Never raises; always returns a result dict."""
    started = time.time()
    team = team_dir.name
    task_id = wid = None
    result = None
    try:
        with locked(team_dir):
            data = load(team_dir)
            (team_dir / "approvals").mkdir(exist_ok=True)
            write_shims(team_dir, data)
            task_id = f"t{data['next_task']:03d}"
            data["next_task"] += 1
            data["queue"].append({"task": task_id, "worker": pref, "kind": kind, "prompt": prompt[:120], "queued": now(),
                                  "pid": os.getpid(), "approval": approval})
            save(team_dir, data)
        while True:
            with locked(team_dir):
                data = load(team_dir)
                reap_stale(team_dir, data)
                verdict, pick = choose(data, task_id, kind)
                if verdict != "wait":
                    data["queue"] = [q for q in data["queue"] if q["task"] != task_id]
                if verdict == "take":
                    wid = pick
                    data["workers"][wid].update(state="busy", task=task_id, task_prompt=prompt[:120], pid=os.getpid(),
                                                approval_task=approval)
                    worker, cwd = dict(data["workers"][wid]), data["workers"][wid].get("cwd") or data["cwd"]
                save(team_dir, data)
            if verdict == "fail":
                result = failed(f"not started: {pick}")
                break
            if verdict == "take":
                break
            time.sleep(1)
        if result is None:
            with open(worker["log"], "a", buffering=1) as log:
                log.write(f"\n=== {task_id} {kind} start {now()} model={worker['model'] or 'omp default'} ===\n{prompt}\n--- output ---\n")
                result, model = run_terminal(team_dir, worker, cwd, task_id, prompt, timeout, maximum, log)
                result["model"] = model or worker["model"]
                log.write(f"=== {task_id} {result['status']} {now()}: {result['summary'][:300]} ===\n")
    except OrcaError as exc:
        result = failed(f"orca: {str(exc).splitlines()[0]}")
    except BaseException as exc:
        result = failed(f"helper crashed or was interrupted: {exc!r}")
    signal.pthread_sigmask(signal.SIG_BLOCK, {signal.SIGTERM, signal.SIGHUP})
    if task_id:
        with contextlib.suppress(Exception), locked(team_dir):
            data = load(team_dir)
            data["queue"] = [q for q in data["queue"] if q["task"] != task_id]
            w = data["workers"].get(wid) if wid else None
            if w and w["task"] == task_id:
                w.update(state="idle", task=None, task_prompt=None, pid=None, child=None, approval_task=None)
                w["assignments"] += 1
                w["resolved_model"] = result.get("model") or w["resolved_model"]
            save(team_dir, data)
    result.update(team=team, worker=wid, task=task_id, kind=kind, duration_s=round(time.time() - started, 1), finished=now())
    if wid:
        result["log"] = str(team_dir / "logs" / f"{wid}.log")
    with contextlib.suppress(Exception):
        write_result(team_dir, result)
    return result


def print_result(res):
    print(f"[{res['team']}] {res.get('worker') or '-'} {res.get('task')} {res['status']} "
          f"({res.get('model') or 'model n/a'}, {res['duration_s']}s): {res['summary'][:200]}")
    print(json.dumps(res, indent=2, ensure_ascii=False))


def retire(team_dir, wids, timeout, maximum):
    """Wrap-up summary from each worker that is busy or has a session (in parallel), then drop its session."""
    with locked(team_dir):
        data = load(team_dir)
        for wid in wids:
            data["workers"][wid]["retiring"] = True
        save(team_dir, data)
        workers = {wid: dict(data["workers"][wid]) for wid in wids}
    finals = {}

    def one(wid):
        try:
            if workers[wid]["state"] == "busy" or has_session(workers[wid]):  # queues behind a running task
                finals[wid] = run_assignment(team_dir, wid, WRAPUP, timeout, maximum, kind="final")
            else:
                finals[wid] = {"status": "succeeded", "summary": "no assignments; nothing to summarise", "files_changed": [],
                               "files_deleted": [], "verification": "", "blockers": [], "team": team_dir.name, "worker": wid, "kind": "final"}
        except Exception as exc:
            finals[wid] = dict(failed(f"wrap-up crashed: {exc!r}"), team=team_dir.name, worker=wid, kind="final")
        with contextlib.suppress(OSError):  # finals stay in memory for the caller's report either way
            (team_dir / "results" / f"{wid}-final.json").write_text(json.dumps(finals[wid], indent=2, ensure_ascii=False))

    threads = [threading.Thread(target=one, args=(w,)) for w in wids]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    with locked(team_dir):
        data = load(team_dir)
        for wid in wids:
            cleanup_worker_session(workers[wid])
            close_terminal(data["workers"].get(wid, {}).get("terminal"))
            data["workers"].pop(wid, None)
        save(team_dir, data)
    return finals


def drop_session_pointers(prefix):
    """omp indexes custom --session-dir sessions in ~/.omp/agent/custom-session-files; drop ours only."""
    for p in OMP_SESSION_POINTERS.glob("*"):
        with contextlib.suppress(OSError, UnicodeDecodeError):
            if p.is_file() and p.read_text().strip().startswith(f"{prefix}/"):
                p.unlink()


def cleanup_worker_session(worker):
    config = HARNESSES[worker.get("harness", "omp")]
    config["cleanup"](config, worker)


def require_registered_cwd():
    try:
        current = subprocess.run([ORCA, "worktree", "current", "--json"], capture_output=True, text=True, timeout=30)
    except (OSError, subprocess.TimeoutExpired) as exc:
        die(f"Orca is not available ({exc}); start Orca (`{ORCA} open`) and retry.", 4)
    with contextlib.suppress(ValueError):
        response = json.loads(current.stdout)
        root = response.get("result", {}).get("worktree", {}).get("path") if response.get("ok") else None
        if root:
            return root
        if response.get("error", {}).get("code") == "selector_not_found":
            listing = subprocess.run([ORCA, "worktree", "list", "--json"], capture_output=True, text=True, timeout=30)
            paths = []
            with contextlib.suppress(ValueError):
                paths = [w["path"] for w in json.loads(listing.stdout).get("result", {}).get("worktrees", [])]
            die(f"cwd {os.getcwd()} is not an Orca-registered worktree; registered paths: {', '.join(paths) or '(none)'}", 4)
    die(f"Orca is not available; start Orca (`{ORCA} open`) and retry.", 4)


def git_output(*args, cwd=None):
    p = subprocess.run(["git", *args], cwd=cwd, capture_output=True, text=True)
    return p.returncode, p.stdout.strip()


def isolated_cwd(data, wid):
    code, root = git_output("rev-parse", "--show-toplevel", cwd=data["cwd"])
    if code:
        die("--isolate requires a git repository cwd", 2)
    code, base = git_output("rev-parse", "HEAD", cwd=data["cwd"])
    if code:
        die("--isolate requires a repository with HEAD", 2)
    rel = os.path.relpath(data["cwd"], root)
    created = orca("worktree", "create", "--repo", f"path:{data['cwd']}", "--name", f"{data['id']}-{wid}",
                   "--base-branch", base, "--setup", "skip", "--no-parent")
    paths = re.findall(r'"path"\s*:\s*"([^"]+)"', json.dumps(created))
    if not paths:
        raise OrcaError("orca worktree create returned no path")
    return paths[0], str(Path(paths[0]) / ("" if rel == "." else rel))


def remove_isolated(data, worker):
    root, cwd = worker.get("worktree"), worker.get("cwd")
    if not data.get("isolate") or not root or not cwd:
        return None
    code, dirty = git_output("status", "--porcelain", cwd=cwd)
    code2, branch = git_output("branch", "--show-current", cwd=cwd)
    ancestor = subprocess.run(["git", "merge-base", "--is-ancestor", branch, "HEAD"], cwd=data["cwd"]).returncode == 0 if branch else False
    if code == 0 and not dirty and code2 == 0 and ancestor:
        try:
            orca("worktree", "rm", "--worktree", f"path:{root}")
            return f"removed isolated worktree {root} ({branch})"
        except OrcaError as exc:
            return f"left isolated worktree {root} ({branch}): {exc}"
    return f"left isolated worktree {root} ({branch or 'unknown branch'}): not clean or not merged"

def cmd_init(args):
    forbid_in_worker()
    selected = args.harness or "omp"
    if selected != "omp" and not args.allow_bypass:
        die(f"--harness {selected} requires explicit --allow-bypass (it enables {HARNESSES[selected]['bypass']})", 3)
    mode = None
    if selected == "omp":
        mode = subprocess.run(["omp", "config", "get", "tools.approvalMode"], capture_output=True, text=True).stdout.strip()
        if mode != "yolo":
            die(f"tools.approvalMode is {mode!r}; omp workers need yolo because nobody can answer their prompts.", 3)
    teams = active_teams()
    if teams and not args.new:
        if args.team is None and len(teams) > 1:
            cmd_status(args)
            print("several teams active: rerun `init --team <id>` to adopt one, or `init --new` for a new team")
            return
        team_dir = resolve_team(args.team)
        print(f"adopted existing team {team_dir.name} (no new team; `init --new` creates one)")
        if args.member or args.model:
            n = args.member or len(load(team_dir)["workers"])
            cmd_member(argparse.Namespace(n=n, model=args.model, harness=args.harness, allow_bypass=args.allow_bypass,
                                          team=team_dir.name, timeout=args.timeout, max=args.max))
        else:
            show_status(team_dir)
        return
    if args.member and not 1 <= args.member <= MAX_WORKERS:
        die(f"member must be 1..{MAX_WORKERS} (task.maxConcurrency)")
    registered_cwd = require_registered_cwd()
    if args.isolate:
        code, _ = git_output("rev-parse", "--show-toplevel", cwd=os.getcwd())
        if code:
            die("--isolate requires a git repository cwd", 2)
        _, dirty = git_output("status", "--porcelain", cwd=os.getcwd())
        if dirty:
            print("WARNING: uncommitted changes will not carry into worker worktrees.")
    team = datetime.datetime.now().strftime("tb-%m%d-%H%M%S")
    team_dir = STATE_ROOT / team
    for sub in ("sessions", "logs", "results", "approvals"):
        (team_dir / sub).mkdir(parents=True)
    data = {"id": team, "created": now(), "cwd": os.getcwd(), "worktree": registered_cwd, "model": args.model, "harness": selected,
            "approval_mode": mode, "next_task": 1, "next_worker": 1, "closing": False, "workers": {}, "queue": [],
            "isolate": args.isolate}
    write_shims(team_dir, data)
    count = args.member or DEFAULT_WORKERS
    if count > WARN_WORKERS:
        print(f"WARNING: {count} workers > {WARN_WORKERS} (soft cap): each worker is a full harness session.")
    try:
        for _ in range(count):
            wid = f"w{data['next_worker']}"
            root, cwd = isolated_cwd(data, wid) if args.isolate else (None, None)
            new_worker(team_dir, data, cwd=cwd)
            data["workers"][wid]["worktree"] = root
    except OrcaError as exc:
        for worker in data["workers"].values():
            with contextlib.suppress(OrcaError):
                if worker.get("worktree"):
                    orca("worktree", "rm", "--worktree", f"path:{worker['worktree']}")
        shutil.rmtree(team_dir, ignore_errors=True)
        die(f"orca: {str(exc).splitlines()[0]}", 4)
    save(team_dir, data)
    print(f"team {team} ready: {count} workers, harness={selected}, model={args.model or 'default'}, cwd={data['cwd']}")
    show_status(team_dir)


def cmd_member(args):
    forbid_in_worker()
    if not 1 <= args.n <= MAX_WORKERS:
        die(f"member must be 1..{MAX_WORKERS} (task.maxConcurrency)")
    if args.harness and args.harness != "omp" and not args.allow_bypass:
        die(f"--harness {args.harness} requires explicit --allow-bypass (it enables {HARNESSES[args.harness]['bypass']})", 3)
    if args.n > WARN_WORKERS:
        print(f"WARNING: {args.n} workers > {WARN_WORKERS} (soft cap): each worker is a full harness session.")
    team_dir = resolve_team(args.team)
    removed = {}
    with locked(team_dir):
        data = load(team_dir)
        if data["closing"]:
            die("team is being cleared")
        effective = args.harness or data.get("harness", "omp")
        if args.n > len([w for w in data["workers"].values() if not w["retiring"]]) and effective != "omp" and not args.allow_bypass:
            die(f"--harness {effective} requires explicit --allow-bypass (it enables {HARNESSES[effective]['bypass']})", 3)
        if args.model:
            data["model"] = args.model
        live = sorted((w for w in data["workers"].values() if not w["retiring"]), key=lambda w: worker_index(w["id"]))
        retirees = []
        if args.n > len(live):
            for _ in range(args.n - len(live)):
                wid = f"w{data['next_worker']}"
                root, cwd = isolated_cwd(data, wid) if data.get("isolate") else (None, None)
                new_worker(team_dir, data, args.harness, cwd)
                data["workers"][wid]["worktree"] = root
        elif args.n < len(live):
            order = sorted(live, key=lambda w: (w["state"] != "idle", -worker_index(w["id"])))
            retirees = [w["id"] for w in order[: len(live) - args.n]]
            removed = {wid: dict(data["workers"][wid]) for wid in retirees}
        if args.model:
            for w in live:
                if w["id"] not in retirees:
                    w["model"] = args.model
        save(team_dir, data)
    if retirees:
        print(f"retiring {', '.join(retirees)} (collecting wrap-up summaries first)")
        for wid, res in retire(team_dir, retirees, args.timeout, args.max).items():
            print(f"  {wid} final {res['status']}: {res['summary'][:200]}")
            note = remove_isolated(data, removed[wid])
            if note:
                print(f"  {note}")
    show_status(team_dir)


def show_status(team_dir):
    with locked(team_dir):
        data = load(team_dir)
        reap_stale(team_dir, data)
        save(team_dir, data)
    print(f"team {data['id']}  cwd={data['cwd']}  model={data['model'] or 'omp default'}  state={team_dir}")
    for w in sorted(data["workers"].values(), key=lambda w: worker_index(w["id"])):
        state = w["state"] + (" retiring" if w["retiring"] else "")
        model = w["model"] or "omp default"
        if w["resolved_model"]:
            model += f" -> {w['resolved_model']}"
        task = f"{w['task']}: {w['task_prompt']!r}" if w["task"] else "-"
        print(f"  {w['id']:<4} {state:<14} harness={w.get('harness', 'omp')} model={model}  assignments={w['assignments']}  task={task}  log={w['log']}")
    for q in data["queue"]:
        print(f"  queued {q['task']} for {q['worker'] or 'any'}: {q['prompt']!r}")


def active_teams():
    return sorted(p.parent for p in STATE_ROOT.glob("*/team.json"))


def cmd_status(args):
    teams = active_teams()
    if args.team or len(teams) < 2:
        show_status(resolve_team(args.team))
        return
    print(f"{len(teams)} teams active; pass --team <id> to the other commands:")
    for team_dir in teams:
        show_status(team_dir)


def cmd_assign(args):
    forbid_in_worker()
    team_dir = resolve_team(args.team)
    prompt = args.prompt if args.prompt not in (None, "-") else sys.stdin.read()
    if not prompt.strip():
        die("empty prompt")
    if args.approval and not re.fullmatch(r"t\d{3}", args.approval):
        die("--approval must name a source task such as t001")
    if args.approval:
        with locked(team_dir):
            data = load(team_dir)
            path = team_dir / "approvals" / f"{args.approval}.json"
            if not path.exists():
                die(f"approval {args.approval} does not exist")
            approved_worker = json.loads(path.read_text()).get("worker")
            if approved_worker not in data["workers"]:
                die(f"approval {args.approval} belongs to unknown worker {approved_worker!r}")
            if args.worker and args.worker != approved_worker:
                die(f"approval {args.approval} belongs to {approved_worker}, not {args.worker}")
            args.worker = approved_worker
    require_orca()
    print_result(run_assignment(team_dir, args.worker, prompt, args.timeout, args.max, approval=args.approval))


def cmd_approve(args):
    forbid_in_worker()
    team_dir = resolve_team(args.team)
    if args.command[:1] == ["--"]:
        args.command = args.command[1:]
    if not re.fullmatch(r"w\d+", args.worker) or not re.fullmatch(r"t\d{3}", args.task) or not args.command:
        die("approve requires --worker wN --task tNNN -- <command...>")
    with locked(team_dir):
        data = load(team_dir)
        if args.worker not in data["workers"]:
            die(f"worker {args.worker} does not exist")
        (team_dir / "approvals").mkdir(exist_ok=True)
        write_shims(team_dir, data)
        path = team_dir / "approvals" / f"{args.task}.json"
        result = team_dir / "results" / f"{args.task}.json"
        if result.exists() and json.loads(result.read_text()).get("worker") != args.worker:
            die(f"task {args.task} belongs to another worker")
        prior = json.loads(path.read_text()) if path.exists() else {"task": args.task, "worker": args.worker, "commands": []}
        if prior.get("worker") != args.worker:
            die(f"task {args.task} approval belongs to {prior.get('worker')}")
        if args.command not in prior["commands"]:
            prior["commands"].append(args.command)
        tmp = path.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(prior, indent=2))
        tmp.replace(path)
        save(team_dir, data)
    print(f"approved {shlex.join(args.command)} for {args.worker} source task {args.task}: {path}")


def cell(s):
    return str(s).replace("|", "\\|").replace("\n", " ")


def cmd_clear(args):
    forbid_in_worker()
    team_dir = resolve_team(args.team)
    with locked(team_dir):  # closing: `member` refuses, so no worker can appear after the wrap-up list is taken
        data = load(team_dir)
        data["closing"] = True
        save(team_dir, data)
    finals = retire(team_dir, list(data["workers"]), args.timeout, args.max)
    worktrees = [note for worker in data["workers"].values() if (note := remove_isolated(data, worker))]
    for p in sorted((team_dir / "results").glob("w*-final.json")):  # includes workers retired earlier by `member`
        finals.setdefault(p.stem[: -len("-final")], json.loads(p.read_text()))
    history = [json.loads(p.read_text()) for p in sorted((team_dir / "results").glob("t*.json"))]
    lines = [f"# team-building {data['id']} — final summary", "",
             f"- created: {data['created']}  cleared: {now()}", f"- cwd: `{data['cwd']}`",
             f"- default harness: {data.get('harness', 'omp')}; model: {data.get('model') or 'harness default'}", "", "## Worktrees", *([f"- {x}" for x in worktrees] or ["- shared cwd"]), "",
             "## Worker final summaries", ""]
    for wid in sorted(finals, key=worker_index):
        r = finals[wid]
        lines += [f"### {wid} — {r['status']} ({r.get('model') or 'n/a'})", "", r["summary"] or "(empty)", ""]
        lines += [f"- files_changed: {', '.join(r.get('files_changed', [])) or '-'}",
                  f"- files_deleted: {', '.join(r.get('files_deleted', [])) or '-'}",
                  f"- verification: {r.get('verification') or '-'}", f"- blockers: {'; '.join(r.get('blockers', [])) or '-'}", ""]
    lines += ["## Assignment log", "", "|task|worker|kind|status|model|summary|files_changed|files_deleted|blockers|",
              "|---|---|---|---|---|---|---|---|---|"]
    for r in history:
        lines.append("|" + "|".join(cell(x) for x in (r.get("task"), r.get("worker"), r.get("kind"), r["status"], r.get("model") or "-",
                                                          r["summary"], ", ".join(r.get("files_changed", [])),
                                                          ", ".join(r.get("files_deleted", [])), "; ".join(r.get("blockers", [])))) + "|")
    NOTES_DIR.mkdir(parents=True, exist_ok=True)
    out = NOTES_DIR / f"{datetime.date.today()}-{data['id']}.md"
    out.write_text("\n".join(lines) + "\n")
    with locked(team_dir):
        drop_session_pointers(team_dir)
        shutil.rmtree(team_dir)
    for wid in sorted(finals, key=worker_index):
        print(f"  {wid} final {finals[wid]['status']}: {finals[wid]['summary'][:200]}")
    print(f"team {data['id']} cleared; state removed ({team_dir}); summary: {out}")


def main():
    signal.signal(signal.SIGTERM, lambda *_: (_ for _ in ()).throw(KeyboardInterrupt("SIGTERM")))
    signal.signal(signal.SIGHUP, lambda *_: (_ for _ in ()).throw(KeyboardInterrupt("SIGHUP")))
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--team", help="team id (needed only when several teams are active)")
    common.add_argument("--timeout", type=int, default=DEFAULT_TIMEOUT, help="idle seconds per assignment/wrap-up")
    common.add_argument("--max", type=int, default=DEFAULT_MAX, help="absolute seconds per assignment/wrap-up")
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("init", parents=[common], help="adopt the active team, or create one (3 workers, or --member N)")
    p.add_argument("--model", help="worker model (harness model name; default: harness default)")
    p.add_argument("--member", type=int, help="worker count (new team) or resize (adopted team)")
    p.add_argument("--harness", choices=HARNESSES, help="worker harness (default: omp)")
    p.add_argument("--allow-bypass", action="store_true", help="allow Claude/Codex permission bypass for this team")
    p.add_argument("--isolate", action="store_true", help="create an Orca worktree per worker")
    p.add_argument("--new", action="store_true", help="create a new team even if one is active")
    p.set_defaults(fn=cmd_init)
    p = sub.add_parser("member", parents=[common], help="resize to N workers (1-8)")
    p.add_argument("n", type=int)
    p.add_argument("--model")
    p.add_argument("--harness", choices=HARNESSES, help="harness for workers newly added by this command")
    p.add_argument("--allow-bypass", action="store_true", help="allow Claude/Codex permission bypass for new workers")
    p.set_defaults(fn=cmd_member)
    sub.add_parser("status", parents=[common]).set_defaults(fn=cmd_status)
    p = sub.add_parser("assign", parents=[common], help="run one assignment; prints the result")
    p.add_argument("--worker", help="wN for a follow-up to that worker; default: any idle worker (queues if none)")
    p.add_argument("--approval", help="source task approval to apply to this follow-up")
    p.add_argument("prompt", nargs="?", help="assignment text, or - / omitted to read stdin")
    p.set_defaults(fn=cmd_assign)
    p = sub.add_parser("approve", parents=[common], help="record one approved external command for a source task")
    p.add_argument("--worker", required=True)
    p.add_argument("--task", required=True)
    p.add_argument("command", nargs=argparse.REMAINDER)
    p.set_defaults(fn=cmd_approve)
    sub.add_parser("clear", parents=[common], help="collect final summaries, write report, remove team").set_defaults(fn=cmd_clear)
    args = ap.parse_args()
    STATE_ROOT.mkdir(parents=True, exist_ok=True)
    args.fn(args)


if __name__ == "__main__":
    main()
