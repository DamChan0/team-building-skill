#!/usr/bin/env python3
"""team-building helper: persistent omp worker sessions driven by one manager session.

Transport: each worker wN is its own Orca terminal in the team cwd running
interactive `omp` (own --session-dir; -c on restart, so context persists).
`assign` writes the brief to briefs/tNNN.md, sends one line pointing at it, and
waits for the worker to write results/tNNN.json. It always prints one result
(human line + JSON), even on crash, timeout, bad model or signal. No Orca = exit 4.

Usage: team.py init [--model M] | member N [--model M] | status
       | assign [--worker wN] [--timeout S] [PROMPT|-] | clear      (all take --team ID)
"""
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

STATE_ROOT = Path.home() / ".local/state/team-building"
NOTES_DIR = Path.home() / "work-notes/team-building"
OMP_SESSION_POINTERS = Path.home() / ".omp/agent/custom-session-files"
DEFAULT_WORKERS, MAX_WORKERS, WARN_WORKERS = 3, 8, 4
DEFAULT_TIMEOUT = 3600
WORKER_ENV = "TEAM_BUILDING_WORKER"
STATUSES = ("succeeded", "failed", "blocked")
ORCA = os.environ.get("ORCA_CLI_COMMAND") or "orca-ide"  # never bare `orca`: on Linux that is the GNOME screen reader
POLL_S, ALIVE_EVERY_S = 2, 15

CONTRACT = """You are team-building worker {wid} of team {team}. A manager (main) session assigns you work by sending one line that points to a brief file; you report by writing the result file the brief names (the manager reads only that file). Your context persists across assignments in this team, so later assignments may be follow-ups.
Rules:
- Do the assigned work yourself, directly. Manager/orchestrator-only rules in your context files apply to the main session, not to you. Plain subagents for your own slice are fine.
- Never run team-building init/member/assign/clear and never create another team or worker session (no recursion).
- You cannot ask the user anything. When blocked (missing info, approval, conflict, a decision), stop and return status "blocked" with the exact need in blockers.
- Touch only the files/areas the assignment gives you.
- Never git push, upload, publish, share, or send anything off this machine. Never delete files; if a deletion is needed, list it in blockers.
- When the assignment is done (or blocked/failed), write exactly one JSON object to the result path given in the brief (write `<path>.tmp`, then rename it to `<path>`), nothing else in that file:
{{"status": "succeeded|failed|blocked", "summary": "...", "files_changed": ["path"], "verification": "what you ran and what you saw", "blockers": ["..."]}}"""

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


def new_worker(team_dir, data):
    wid = f"w{data['next_worker']}"  # monotonic: a retired id is never reused, so its final report is kept
    data["next_worker"] += 1
    data["workers"][wid] = {
        "id": wid, "model": data["model"], "resolved_model": None, "state": "idle", "task": None,
        "task_prompt": None, "pid": None, "retiring": False, "assignments": 0,
        "session_dir": str(team_dir / "sessions" / wid), "log": str(team_dir / "logs" / f"{wid}.log"),
    }


def worker_index(wid):
    return int(wid[1:])


def has_session(worker):
    return any(Path(worker["session_dir"]).glob("*.jsonl"))


def write_result(team_dir, result):
    (team_dir / "results" / f"{result['task']}.json").write_text(json.dumps(result, indent=2, ensure_ascii=False))


def failed(summary, blockers=()):
    return {"status": "failed", "summary": summary, "files_changed": [], "verification": "", "blockers": list(blockers)}


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
            return {"status": obj["status"], "summary": str(obj.get("summary", "")).strip(),
                    "files_changed": as_list(obj.get("files_changed")),
                    "verification": "; ".join(map(str, ver)) if isinstance(ver, list) else str(ver or ""),
                    "blockers": as_list(obj.get("blockers"))}
    return None


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


def ensure_terminal(team_dir, team, worker, cwd):
    """Reuse wN's live Orca terminal, or open one running interactive omp for it; returns the handle."""
    if terminal_alive(worker.get("terminal")):
        return worker["terminal"]
    Path(worker["session_dir"]).mkdir(parents=True, exist_ok=True)
    cmd = ["env", f"{WORKER_ENV}={team}/{worker['id']}", "omp", "--no-title", "--session-dir", worker["session_dir"],
           "--append-system-prompt", CONTRACT.format(wid=worker["id"], team=team)]
    if has_session(worker):
        cmd.append("-c")
    if worker["model"]:
        cmd += ["--model", worker["model"]]
    res = orca("terminal", "create", "--worktree", f"path:{cwd}", "--title", f"{team} {worker['id']}",
               "--command", f"cd {shlex.quote(cwd)} && exec {shlex.join(cmd)}")
    handle = (res.get("terminal") or res)["handle"]
    with contextlib.suppress(OrcaError):  # agent TUIs drop input sent before they are ready
        orca("terminal", "wait", "--terminal", handle, "--for", "tui-idle", "--timeout-ms", "90000", timeout=100)
    with locked(team_dir):
        d = load(team_dir)
        if worker["id"] in d["workers"]:
            d["workers"][worker["id"]]["terminal"] = handle
            save(team_dir, d)
    worker["terminal"] = handle
    return handle


def last_assistant(worker):
    """Last assistant message in the worker's newest session file (omp session jsonl), or None."""
    files = sorted(Path(worker["session_dir"]).glob("*.jsonl"), key=lambda p: p.stat().st_mtime)
    for line in reversed(files[-1].read_text(errors="replace").splitlines() if files else []):
        with contextlib.suppress(ValueError, AttributeError):
            m = json.loads(line).get("message") or {}
            if m.get("role") == "assistant":
                return m
    return None


def session_model(worker):
    m = last_assistant(worker)
    return f"{m.get('provider')}/{m['model']}" if m and m.get("model") else None


def run_terminal(team_dir, worker, cwd, task_id, prompt, timeout, log):
    """Run one assignment in wN's Orca terminal; returns (result, model_used)."""
    team = team_dir.name
    out = team_dir / "results" / f"{task_id}.json"
    brief = team_dir / "briefs" / f"{task_id}.md"
    brief.parent.mkdir(exist_ok=True)
    brief.write_text(f"# [team {team} / {worker['id']} / {task_id}]\n\n{prompt}\n\n---\n"
                     f"When finished, write the result JSON object (worker contract) to `{out}` "
                     f"(write `{out}.tmp`, then rename). That file is the only thing the manager reads.\n")
    handle = ensure_terminal(team_dir, team, worker, cwd)
    log.write(f"[terminal {handle}] brief {brief}\n")
    with contextlib.suppress(OrcaError):  # a previous reply may still be streaming
        orca("terminal", "wait", "--terminal", handle, "--for", "tui-idle", "--timeout-ms", "30000", timeout=40)
    sent = time.time()
    orca("terminal", "send", "--terminal", handle, "--text", f"Assignment {task_id}: read {brief} and do it.", "--enter")
    deadline, next_alive = time.time() + timeout, time.time() + ALIVE_EVERY_S
    while True:
        if out.exists():
            text = out.read_text(errors="replace")
            res = parse_result(text)
            if res is not None:
                return res, session_model(worker)
            if time.time() - out.stat().st_mtime > 5:
                return failed("worker wrote an invalid result file", [f"result file tail: {text[-800:]}"]), session_model(worker)
        now_t = time.time()
        if now_t >= deadline:
            close_terminal(handle)  # interrupts the run; the next assign reopens the session with -c
            return failed(f"timeout after {timeout}s; worker terminal closed"), session_model(worker)
        if now_t >= next_alive:
            next_alive = now_t + ALIVE_EVERY_S
            if not terminal_alive(handle):
                return failed("worker terminal exited before writing a result (bad model, crash, or closed tab)"), session_model(worker)
            m = last_assistant(worker)
            if m and m.get("timestamp", 0) / 1000 >= sent and m.get("stopReason") in ("error", "aborted"):
                return failed(f"model run {m['stopReason']}: {m.get('errorMessage', '')}"[:500]), session_model(worker)
        time.sleep(POLL_S)


def run_assignment(team_dir, pref, prompt, timeout, kind="task"):
    """Queue, wait for a worker, run, record. Never raises; always returns a result dict."""
    started = time.time()
    team = team_dir.name
    task_id = wid = None
    result = None
    try:
        with locked(team_dir):
            data = load(team_dir)
            task_id = f"t{data['next_task']:03d}"
            data["next_task"] += 1
            data["queue"].append({"task": task_id, "worker": pref, "kind": kind, "prompt": prompt[:120], "queued": now(),
                                  "pid": os.getpid()})
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
                    data["workers"][wid].update(state="busy", task=task_id, task_prompt=prompt[:120], pid=os.getpid())
                    worker, cwd = dict(data["workers"][wid]), data["cwd"]
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
                result, model = run_terminal(team_dir, worker, cwd, task_id, prompt, timeout, log)
                result["model"] = model or worker["model"]
                log.write(f"=== {task_id} {result['status']} {now()}: {result['summary'][:300]} ===\n")
    except BaseException as exc:  # crash, SIGTERM, Ctrl-C: still a result
        result = failed(f"helper crashed or was interrupted: {exc!r}")
    # Finalisation must not be interrupted, or the caller would get no JSON; late SIGTERM/SIGHUP stay pending.
    signal.pthread_sigmask(signal.SIG_BLOCK, {signal.SIGTERM, signal.SIGHUP})
    if task_id:  # free the worker and drop our queue entry, whatever happened
        with contextlib.suppress(Exception), locked(team_dir):
            data = load(team_dir)
            data["queue"] = [q for q in data["queue"] if q["task"] != task_id]
            w = data["workers"].get(wid) if wid else None
            if w and w["task"] == task_id:
                w.update(state="idle", task=None, task_prompt=None, pid=None, child=None)
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


def retire(team_dir, wids, timeout):
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
                finals[wid] = run_assignment(team_dir, wid, WRAPUP, timeout, kind="final")
            else:
                finals[wid] = {"status": "succeeded", "summary": "no assignments; nothing to summarise", "files_changed": [],
                               "verification": "", "blockers": [], "team": team_dir.name, "worker": wid, "kind": "final"}
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
            session = team_dir / "sessions" / wid  # rebuilt, never trusted from team.json
            if re.fullmatch(r"w\d+", wid):
                drop_session_pointers(session)
                shutil.rmtree(session, ignore_errors=True)
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


def cmd_init(args):
    forbid_in_worker()
    mode = subprocess.run(["omp", "config", "get", "tools.approvalMode"], capture_output=True, text=True).stdout.strip()
    if mode != "yolo":
        die(f"tools.approvalMode is {mode!r}. Headless workers cannot answer approval prompts, so they would need "
            f"--auto-approve/--approval-mode yolo, which is broader than your setting. Decision for the user: "
            f"change tools.approvalMode, or do not use team-building.", 3)
    teams = active_teams()
    if teams and not args.new:  # re-adopt: a restarted main session keeps the existing team, workers and sessions
        if args.team is None and len(teams) > 1:
            cmd_status(args)
            print("several teams active: rerun `init --team <id>` to adopt one, or `init --new` for a new team")
            return
        team_dir = resolve_team(args.team)
        print(f"adopted existing team {team_dir.name} (no new team; `init --new` creates one)")
        if args.member or args.model:
            n = args.member or len(load(team_dir)["workers"])
            cmd_member(argparse.Namespace(n=n, model=args.model, team=team_dir.name, timeout=args.timeout))
        else:
            show_status(team_dir)
        return
    if args.member and not 1 <= args.member <= MAX_WORKERS:
        die(f"member must be 1..{MAX_WORKERS} (task.maxConcurrency)")
    team = datetime.datetime.now().strftime("tb-%m%d-%H%M%S")
    team_dir = STATE_ROOT / team
    for sub in ("sessions", "logs", "results"):
        (team_dir / sub).mkdir(parents=True)
    data = {"id": team, "created": now(), "cwd": os.getcwd(), "model": args.model, "approval_mode": mode,
            "next_task": 1, "next_worker": 1, "closing": False, "workers": {}, "queue": []}
    count = args.member or DEFAULT_WORKERS
    if count > WARN_WORKERS:
        print(f"WARNING: {count} workers > {WARN_WORKERS} (soft cap): each worker is a full omp session.")
    for _ in range(count):
        new_worker(team_dir, data)
    save(team_dir, data)
    print(f"team {team} ready: {count} workers, model={args.model or 'omp default'}, cwd={data['cwd']}")
    show_status(team_dir)


def cmd_member(args):
    forbid_in_worker()
    if not 1 <= args.n <= MAX_WORKERS:
        die(f"member must be 1..{MAX_WORKERS} (task.maxConcurrency)")
    if args.n > WARN_WORKERS:
        print(f"WARNING: {args.n} workers > {WARN_WORKERS} (soft cap): each worker is a full omp session.")
    team_dir = resolve_team(args.team)
    with locked(team_dir):
        data = load(team_dir)
        if data["closing"]:
            die("team is being cleared")
        if args.model:
            data["model"] = args.model  # new workers pick it up in new_worker()
        live = sorted((w for w in data["workers"].values() if not w["retiring"]), key=lambda w: worker_index(w["id"]))
        retirees = []
        if args.n > len(live):
            for _ in range(args.n - len(live)):
                new_worker(team_dir, data)
        elif args.n < len(live):
            order = sorted(live, key=lambda w: (w["state"] != "idle", -worker_index(w["id"])))  # idle first
            retirees = [w["id"] for w in order[: len(live) - args.n]]
        if args.model:  # survivors switch at their next assignment; retirees wrap up on their old model
            for w in live:
                if w["id"] not in retirees:
                    w["model"] = args.model
        save(team_dir, data)
    if retirees:
        print(f"retiring {', '.join(retirees)} (collecting wrap-up summaries first)")
        for wid, res in retire(team_dir, retirees, args.timeout).items():
            print(f"  {wid} final {res['status']}: {res['summary'][:200]}")
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
        print(f"  {w['id']:<4} {state:<14} model={model}  assignments={w['assignments']}  task={task}  log={w['log']}")
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
    require_orca()
    print_result(run_assignment(team_dir, args.worker, prompt, args.timeout))


def cell(s):
    return str(s).replace("|", "\\|").replace("\n", " ")


def cmd_clear(args):
    forbid_in_worker()
    team_dir = resolve_team(args.team)
    with locked(team_dir):  # closing: `member` refuses, so no worker can appear after the wrap-up list is taken
        data = load(team_dir)
        data["closing"] = True
        save(team_dir, data)
    finals = retire(team_dir, list(data["workers"]), args.timeout)
    for p in sorted((team_dir / "results").glob("w*-final.json")):  # includes workers retired earlier by `member`
        finals.setdefault(p.stem[: -len("-final")], json.loads(p.read_text()))
    history = [json.loads(p.read_text()) for p in sorted((team_dir / "results").glob("t*.json"))]
    lines = [f"# team-building {data['id']} — final summary", "",
             f"- created: {data['created']}  cleared: {now()}", f"- cwd: `{data['cwd']}`",
             f"- model: {data['model'] or 'omp default'}", "", "## Worker final summaries", ""]
    for wid in sorted(finals, key=worker_index):
        r = finals[wid]
        lines += [f"### {wid} — {r['status']} ({r.get('model') or 'n/a'})", "", r["summary"] or "(empty)", ""]
        lines += [f"- files_changed: {', '.join(r['files_changed']) or '-'}", f"- verification: {r['verification'] or '-'}",
                  f"- blockers: {'; '.join(r['blockers']) or '-'}", ""]
    lines += ["## Assignment log", "", "|task|worker|kind|status|model|summary|files|blockers|", "|---|---|---|---|---|---|---|---|"]
    for r in history:
        lines.append("|" + "|".join(cell(x) for x in (r.get("task"), r.get("worker"), r.get("kind"), r["status"], r.get("model") or "-",
                                                          r["summary"], ", ".join(r["files_changed"]), "; ".join(r["blockers"]))) + "|")
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
    common.add_argument("--timeout", type=int, default=DEFAULT_TIMEOUT, help="seconds per assignment/wrap-up")
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("init", parents=[common], help="adopt the active team, or create one (3 workers, or --member N)")
    p.add_argument("--model", help="worker model (omp --model fuzzy match; default: omp default)")
    p.add_argument("--member", type=int, help="worker count (new team) or resize (adopted team)")
    p.add_argument("--new", action="store_true", help="create a new team even if one is active")
    p.set_defaults(fn=cmd_init)
    p = sub.add_parser("member", parents=[common], help="resize to N workers (1-8)")
    p.add_argument("n", type=int)
    p.add_argument("--model")
    p.set_defaults(fn=cmd_member)
    sub.add_parser("status", parents=[common]).set_defaults(fn=cmd_status)
    p = sub.add_parser("assign", parents=[common], help="run one assignment; prints the result")
    p.add_argument("--worker", help="wN for a follow-up to that worker; default: any idle worker (queues if none)")
    p.add_argument("prompt", nargs="?", help="assignment text, or - / omitted to read stdin")
    p.set_defaults(fn=cmd_assign)
    sub.add_parser("clear", parents=[common], help="collect final summaries, write report, remove team").set_defaults(fn=cmd_clear)
    args = ap.parse_args()
    STATE_ROOT.mkdir(parents=True, exist_ok=True)
    args.fn(args)


if __name__ == "__main__":
    main()
