"""Checks bin/run-tickets-setup, bin/run-tickets-finish and bin/run-tickets-status against
throwaway git repos.

    python3 tests/run-tickets-scripts.test.py

Each scenario builds a repo in a temp dir. tk is replaced by a fake that logs its
arguments and prints ids, and run-tickets-status by a fake archiver, so nothing
touches real tickets or ~/.claude/run-history. The run-tickets-status checks run
the real script with HOME pointed at a temp dir that holds the run's journal,
agent logs and finished-run metadata. Its report forms are compared with what the
script printed for the same records before --ticket, --watch and --find-ticket
were added.
"""

import contextlib
import difflib
import io
import json
import os
import signal
import subprocess
import tempfile
import threading
import time
from datetime import datetime, timedelta, timezone
from importlib.machinery import SourceFileLoader
from importlib.util import module_from_spec, spec_from_loader
from pathlib import Path

BIN = Path(__file__).resolve().parent.parent / "bin"
SETUP, FINISH = str(BIN / "run-tickets-setup"), str(BIN / "run-tickets-finish")

FAKE_TK = """#!/usr/bin/env bash
echo "$*" >> "$TK_LOG"
case "$1 $2" in
  "backlog ensure") echo bl-1 ;;
  create*) n=$(grep -c '^create' "$TK_LOG"); echo "new-$n" ;;
esac
"""
FAKE_STATUS = """#!/usr/bin/env bash
echo "/fake/run-history/$2.json"
"""

failures = 0


def check(name, cond, detail=""):
    global failures
    failures += not cond
    print(f"{'PASS' if cond else 'FAIL'}  {name}" + ("" if cond else f"\n      {detail}"))


def sh(*cmd, cwd):
    return subprocess.run(list(cmd), cwd=cwd, capture_output=True, text=True)


def new_repo(tmp):
    root = os.path.realpath(os.path.join(tmp, "repo"))
    os.makedirs(root)
    for cmd in (["git", "init", "-q", "-b", "main"], ["git", "config", "user.email", "t@example.com"],
                ["git", "config", "user.name", "Test"], ["git", "config", "commit.gpgsign", "false"]):
        sh(*cmd, cwd=root)
    Path(root, "app.txt").write_text("one\n")
    sh("git", "add", ".", cwd=root)
    sh("git", "commit", "-qm", "init", cwd=root)
    tools = os.path.join(tmp, "tools")
    os.makedirs(tools)
    for name, body in (("tk", FAKE_TK), ("status", FAKE_STATUS)):
        Path(tools, name).write_text(body)
        os.chmod(os.path.join(tools, name), 0o755)
    env = {**os.environ, "TK_SCRIPT": os.path.join(tools, "tk"), "TK_LOG": os.path.join(tmp, "tk.log"),
           "RUN_TICKETS_STATUS": os.path.join(tools, "status"), "TICKETS_DIR": os.path.join(root, ".tickets")}
    Path(env["TK_LOG"]).touch()
    os.makedirs(env["TICKETS_DIR"])
    return root, env


def run(script, *args, cwd, env):
    res = subprocess.run([script, *args], cwd=cwd, env=env, capture_output=True, text=True)
    try:
        out = json.loads(res.stdout) if res.stdout.strip() else None
    except json.JSONDecodeError:
        out = None
    return res.returncode, out, res.stderr


def commit(root, path, text, msg):
    Path(root, path).write_text(text)
    sh("git", "add", path, cwd=root)
    sh("git", "commit", "-qm", msg, cwd=root)


def ticket(env, tid, status):
    Path(env["TICKETS_DIR"], f"{tid}.md").write_text(f"---\nid: {tid}\nstatus: {status}\ntype: task\n---\n# {tid}\n")


# ---------- setup ----------

with tempfile.TemporaryDirectory() as tmp:
    root, env = new_repo(tmp)
    code, out, err = run(SETUP, "--stamp", "S1", "--branch", "epic/e1", "--slots", "2", "--tickets", "a,b",
                         "--session-epic", cwd=root, env=env)
    check("setup: exits 0", code == 0, err)
    out = out or {}
    check("setup: creates the branch from main", out.get("createdBranch") is True
          and sh("git", "rev-parse", "epic/e1", cwd=root).stdout == sh("git", "rev-parse", "main", cwd=root).stdout)
    check("setup: integration worktree is on the branch",
          sh("git", "branch", "--show-current", cwd=out.get("integrationWorktree", root)).stdout.strip() == "epic/e1")
    check("setup: two slot worktrees", len(out.get("slots", [])) == 2 and all(os.path.isdir(s) for s in out.get("slots", [])))
    check("setup: baseBranch is the branch's commit",
          out.get("baseBranch") == sh("git", "rev-parse", "epic/e1", cwd=root).stdout.strip())
    log = Path(env["TK_LOG"]).read_text()
    check("setup: backlog and session epic", out.get("backlogParent") == "bl-1" and out.get("sessionEpic") == "new-1", log)
    check("setup: claims every ticket", "start a\n" in log and "start b\n" in log, log)

    code, out, err = run(SETUP, "--stamp", "S1", "--branch", "epic/e1", "--slots", "2", "--tickets", "a,b",
                         cwd=root, env=env)
    check("setup: re-run reuses existing worktrees", code == 0, err)

with tempfile.TemporaryDirectory() as tmp:
    root, env = new_repo(tmp)
    sh("git", "checkout", "-qb", "epic/e2", cwd=root)
    code, _, err = run(SETUP, "--stamp", "S2", "--branch", "epic/e2", "--slots", "1", "--tickets", "a",
                       cwd=root, env=env)
    check("setup: refuses a branch checked out in the main repo", code == 2 and "main repo" in err, err)

with tempfile.TemporaryDirectory() as tmp:
    root, env = new_repo(tmp)
    sh("git", "branch", "epic/e3", cwd=root)
    sh("git", "checkout", "-q", "epic/e3", cwd=root)
    commit(root, "app.txt", "branch side\n", "branch change")
    sh("git", "checkout", "-q", "main", cwd=root)
    commit(root, "app.txt", "main side\n", "main change")
    code, out, err = run(SETUP, "--stamp", "S3", "--branch", "epic/e3", "--slots", "2", "--tickets", "a",
                         "--merge-main", cwd=root, env=env)
    check("setup: merge conflict exits 3 with the files", code == 3 and (out or {}).get("mergeMain", {}).get("files") == ["app.txt"],
          f"{code} {out} {err}")
    integ = os.path.join(root, ".worktrees", "run-S3-integration")
    check("setup: conflict leaves no merge in progress",
          sh("git", "status", "--porcelain", cwd=integ).stdout == "" and not os.path.exists(os.path.join(root, ".worktrees", "run-S3-slot-1")))
    check("setup: conflict claims nothing", "start" not in Path(env["TK_LOG"]).read_text())

with tempfile.TemporaryDirectory() as tmp:
    root, env = new_repo(tmp)
    sh("git", "branch", "epic/e4", cwd=root)
    commit(root, "other.txt", "x\n", "main moves on")
    code, out, err = run(SETUP, "--stamp", "S4", "--branch", "epic/e4", "--slots", "1", "--tickets", "a",
                         "--merge-main", cwd=root, env=env)
    check("setup: clean merge of main", code == 0 and (out or {}).get("mergeMain") == {"result": "merged"}, f"{out} {err}")
    check("setup: baseBranch includes the merge",
          sh("git", "merge-base", "--is-ancestor", "main", (out or {}).get("baseBranch", "x"), cwd=root).returncode == 0)


# ---------- finish ----------

def finished_run(tmp, merge_halted=None):
    """A repo after a run: a merged, b blocked on a decision, c stalled behind b."""
    root, env = new_repo(tmp)
    _, s, _ = run(SETUP, "--stamp", "F", "--branch", "epic/f", "--slots", "2", "--tickets", "a,b,c", cwd=root, env=env)
    slot1, slot2 = s["slots"]
    for slot, tid in ((slot1, "a"), (slot2, "b")):
        sh("git", "checkout", "-qB", f"ticket/{tid}", "epic/f", cwd=slot)
        commit(slot, f"{tid}.txt", f"{tid}\n", f"work on {tid}")
        sh("git", "checkout", "-q", "--detach", cwd=slot)
    sh("git", "merge", "--no-ff", "-qm", "Merge a: A", "ticket/a", cwd=s["integrationWorktree"])
    for tid, status in (("a", "open"), ("b", "in_progress"), ("c", "in_progress")):
        ticket(env, tid, status)
    args = {"repoRoot": root, "integrationBranch": "epic/f", "integrationWorktree": s["integrationWorktree"],
            "slots": s["slots"], "findingsParent": "e1", "backlogParent": "bl-1", "baseBranch": s["baseBranch"],
            "gates": [], "tickets": [{"id": "a", "deps": [], "decision": "limit is 3"}, {"id": "b", "deps": []}]}
    record = os.path.join(root, ".worktrees", "run-F.json")
    Path(record).write_text(json.dumps({"stamp": "F", "runId": "wf_test", "args": args}))
    result = {"integrationBranch": "epic/f", "mergeHalted": merge_halted, "integration": {"status": "pass"}, "tickets": [
        {"id": "a", "title": "A", "outcome": "merged", "sha": "m1", "acFails": 1, "qrRounds": 2, "conflicts": 0,
         "gateFails": 0, "findings": ["f1"], "outOfScope": ["f2"], "backlog": ["k1"], "noted": [],
         "humanChecks": ["menu opens: look at the menu on a phone", "limit is 5: DISPUTED: the design doc says 3"]},
        {"id": "b", "title": "B", "outcome": "blocked", "reason": "implementer failed: needs decision: which limit",
         "humanChecks": ["list scrolls: try it on a tablet", "size is 2: DISPUTED: the spec says 4"]},
        {"id": "c", "title": "C", "outcome": "stalled", "reason": "depends on unmerged b"},
    ]}
    result_path = os.path.join(tmp, "result.json")
    Path(result_path).write_text(json.dumps(result))
    return root, env, s, record, result_path


with tempfile.TemporaryDirectory() as tmp:
    root, env, s, record, result_path = finished_run(tmp)
    log_before = Path(env["TK_LOG"]).read_text()
    code, out, err = run(FINISH, "--dry-run", "--result", result_path, "wf_test", cwd=root, env=env)
    check("finish --dry-run: exits 0", code == 0, err)
    check("finish --dry-run: changes nothing", Path(env["TK_LOG"]).read_text() == log_before and os.path.exists(record)
          and all(os.path.isdir(p) for p in s["slots"]))

    code, out, err = run(FINISH, "--result", result_path, "wf_test", cwd=root, env=env)
    out = out or {}
    log = Path(env["TK_LOG"]).read_text()[len(log_before):]
    check("finish: exits 0", code == 0, err)
    check("finish: closes a merged ticket that is still open", "close a\n" in log and "add-note a " in log, log)
    check("finish: reopens blocked and stalled tickets with notes",
          "status b open" in log and "status c open" in log and "ticket/b" in log, log)
    check("finish: reports the needs-decision claim", [d["id"] for d in out.get("needs_decision", [])] == ["b"])
    check("finish: files the disputed check as needs-human under the findings parent",
          "--parent e1 --tags needs-human" in log and out.get("disputed", [{}])[0].get("ticket"), log)
    check("finish: keeps other human checks for the report", [h["id"] for h in out.get("human_checks", [])] == ["a"])
    check("finish: an unmerged ticket's human checks wait for the run that merges it",
          log.count("create ") == 1 and [d["source"] for d in out.get("disputed", [])] == ["a"], log)
    check("finish: collects findings and out-of-scope ids", out.get("findings") == ["f1", "f2"] and out.get("backlog") == ["k1"])
    check("finish: reports the owner's decisions from the args", out.get("decided") == [{"id": "a", "decision": "limit is 3"}])
    check("finish: removes every worktree", sorted(out.get("worktrees_removed", [])) == sorted([s["integrationWorktree"], *s["slots"]])
          and not out.get("worktrees_left"), out.get("errors"))
    branches = sh("git", "branch", "--format=%(refname:short)", cwd=root).stdout.split()
    check("finish: deletes slot placeholders and the merged ticket branch, keeps the blocked one",
          "ticket/a" not in branches and "ticket/b" in branches and not any(b.startswith("run-F-slot") for b in branches), branches)
    check("finish: archives and deletes the run record",
          out.get("archive", {}).get("path") == "/fake/run-history/wf_test.json" and out.get("record_deleted") and not os.path.exists(record))

with tempfile.TemporaryDirectory() as tmp:
    root, env, s, record, result_path = finished_run(tmp, merge_halted="merge agent died")
    # The merge agent died mid-merge: a merge is in progress in the integration worktree.
    sh("git", "merge", "--no-ff", "--no-commit", "ticket/b", cwd=s["integrationWorktree"])
    code, out, err = run(FINISH, "--result", result_path, "wf_test", cwd=root, env=env)
    out = out or {}
    check("finish after a merge halt mid-merge: keeps the integration worktree and the record",
          [w["path"] for w in out.get("worktrees_left", [])] == [s["integrationWorktree"]] and os.path.exists(record), f"{out} {err}")
    check("finish after a merge halt mid-merge: reports the integration worktree's status", bool(out.get("integration_status")))
    check("finish after a merge halt: still removes the slots", sorted(out.get("worktrees_removed", [])) == sorted(s["slots"]))
    log_before = Path(env["TK_LOG"]).read_text()
    code, out, err = run(FINISH, "--result", result_path, "wf_test", cwd=root, env=env)
    check("finish re-run: does not record tickets twice",
          code == 0 and (out or {}).get("tickets_already_recorded") and Path(env["TK_LOG"]).read_text() == log_before, err)

with tempfile.TemporaryDirectory() as tmp:
    root, env, s, record, result_path = finished_run(tmp, merge_halted="git merge was refused")
    code, out, err = run(FINISH, "--result", result_path, "wf_test", cwd=root, env=env)
    out = out or {}
    check("finish after a merge halt with the tree clean: removes the integration worktree too, so --resume can reuse the branch",
          s["integrationWorktree"] in out.get("worktrees_removed", []) and not out.get("worktrees_left")
          and not os.path.exists(record), f"{out} {err}")

with tempfile.TemporaryDirectory() as tmp:
    root, env = new_repo(tmp)
    code, _, err = run(FINISH, "wf_missing", cwd=root, env=env)
    check("finish: a run with no result says how to pass one", code == 1 and "--result" in err, err)

# ---------- status ----------

loader = SourceFileLoader("run_tickets_status", str(BIN / "run-tickets-status"))
status = module_from_spec(spec_from_loader(loader.name, loader))
loader.exec_module(status)

with tempfile.TemporaryDirectory() as tmp:
    journal = os.path.join(tmp, "journal.jsonl")
    Path(journal).write_text("")
    os.utime(journal, (1_800_000_100, 1_800_000_100))
    written = datetime.fromtimestamp(1_800_000_000, timezone.utc).isoformat()
    check("status: metadata written before the journal's last write is an earlier pass's",
          status.superseded({"timestamp": written}, journal))
    os.utime(journal, (1_800_000_002, 1_800_000_002))
    check("status: metadata written as the run finished is current", not status.superseded({"timestamp": written}, journal))
    check("status: without a timestamp, start plus duration is when it was written",
          not status.superseded({"startTime": 1_799_999_000_000, "durationMs": 1_000_000}, journal)
          and status.superseded({"startTime": 1_799_990_000_000, "durationMs": 1_000_000}, journal))
    check("status: no metadata or no journal is never stale", not status.superseded(None, journal) and not status.superseded({"timestamp": written}, None))

# Each agent's local start time and duration, in order; the running one shows how long it has run so far.
launch = datetime(2030, 3, 1, 23, 50).astimezone()


def at(minutes):
    return (launch + timedelta(minutes=minutes)).isoformat(timespec="seconds")


steps = [{"step": "impl", "round": 1, "started": at(2), "seconds": 600},
         {"step": "review", "round": 1, "started": at(12), "seconds": 300},
         {"step": "impl", "round": 2, "started": at(18), "seconds": None},
         {"step": "review", "round": 2, "started": None, "seconds": None}]
line = status.started_line({"steps": steps[:3], "active": ("impl", 2)}, launch, launch + timedelta(minutes=21))
check("status: started line gives each agent's clock time and duration, and the running one's time so far",
      line == "started: impl 23:52 (10m), review 03-02 00:02 (5m), impl r2 03-02 00:08 (running 3m)", line)
line = status.started_line({"steps": steps, "active": None}, launch, launch)
check("status: an agent with no log yet shows a question mark", line.endswith("review r2 ?"), line)


# ---------- status: fixtures ----------

STATUS = str(BIN / "run-tickets-status")
CLEAR = "\033[H\033[2J\033[3J"


def status_repo(tmp):
    """A git repo, and an env whose fake HOME holds the runs; TZ=UTC fixes the clock times printed."""
    root = os.path.realpath(os.path.join(tmp, "repo"))
    os.makedirs(os.path.join(root, ".worktrees"))
    sh("git", "init", "-q", cwd=root)
    home = os.path.join(tmp, "home")
    return root, home, {**os.environ, "HOME": home, "TZ": "UTC"}


def utc(clock):
    """Seconds since the epoch at the clock time ("10:00") on 2030-03-01, UTC."""
    return datetime.fromisoformat(f"2030-03-01T{clock}:00+00:00").timestamp()


def iso(clock):
    return f"2030-03-01T{clock}:00.000Z"


def started(agent, label):
    return {"type": "started", "agentId": agent, "label": label}


def finished(agent, result):
    return {"type": "result", "agentId": agent, "result": result}


def journal_of(home, run_id):
    return Path(home, ".claude", "projects", "p", "s", "subagents", "workflows", run_id, "journal.jsonl")


def add_run(root, home, run_id, tickets, launched=None, events=None, agents=None, final=None, record_mtime=None):
    """One run: its record in .worktrees/, its journal and agent logs, and its finished-run metadata.

    tickets: ids, or the ticket dicts the workflow args carry. events: the journal's
    lines, or None for no journal. agents: agent id -> (start, end, effort) of its log.
    final: the metadata's result, startTime, durationMs and timestamp, or None while
    the run is unfinished.
    """
    args = {"repoRoot": root, "integrationBranch": f"epic/{run_id}",
            "tickets": [t if isinstance(t, dict) else {"id": t, "title": f"Ticket {t}", "deps": [], "has_ac": True}
                        for t in tickets]}
    record = os.path.join(root, ".worktrees", f"run-{run_id}.json")
    Path(record).write_text(json.dumps({"stamp": run_id, "launched": launched, "args": args, "runId": run_id}))
    if record_mtime:
        os.utime(record, (record_mtime, record_mtime))
    session = os.path.join(home, ".claude", "projects", "p", "s")
    run_dir = os.path.join(session, "subagents", "workflows", run_id)
    if events is not None:
        os.makedirs(run_dir)
        journal = Path(run_dir, "journal.jsonl")
        journal.write_text("".join(json.dumps(e) + "\n" for e in events))
        # A fixed time, not the clock's: a journal written after its run's metadata marks the run as
        # relaunched and still going, so a finished fixture run would read as running from that date on.
        os.utime(journal, (utc("11:00"), utc("11:00")))
    for agent, (start, end, effort) in (agents or {}).items():
        reply = {"type": "assistant", "timestamp": iso(start), "message": {"model": "claude-test"}}
        if effort:
            reply["effort"] = effort
        lines = [{"type": "user", "timestamp": iso(start)}, reply, {"type": "user", "timestamp": iso(end)}]
        log = Path(run_dir, f"agent-{agent}.jsonl")
        # Compact, as Claude Code writes them: the effort reader looks for "type":"assistant".
        log.write_text("".join(json.dumps(line, separators=(",", ":")) + "\n" for line in lines))
        os.utime(log, (utc(end), utc(end)))
    if final is not None:
        os.makedirs(os.path.join(session, "workflows"), exist_ok=True)
        Path(session, "workflows", f"{run_id}.json").write_text(
            json.dumps({"workflowName": "run-tickets-engine", "runId": run_id, "args": args, **final}))


def report_runs(root, home):
    """wf_done: finished, with every kind of line the text report prints. wf_live: still running.

    wf_live was launched in 2099, so every duration measured against the clock
    clamps to 0s and its running report prints the same on every test run.
    """
    tickets = [{"id": "x-1", "title": "Add the menu", "deps": [], "has_ac": True, "decision": "use the short form"},
               {"id": "x-22", "title": "Fix the list", "deps": ["x-1"], "has_ac": False}]
    events = [{"type": "launched"},
              started("a1", "impl x-1"), finished("a1", {"status": "done", "src_lines_changed": 12}),
              started("a2", "ac x-1"),
              finished("a2", {"verdict": "PASS", "criteria": [{"criterion": "menu opens", "human_check": "open it on a phone"}]}),
              started("a3", "review x-1"),
              finished("a3", {"verdict": "CLEAN", "findings": [], "filed": [{"id": "x-9", "parent": "x-e"}]}),
              started("a4", "merge x-1"), finished("a4", {"result": "merged", "sha": "abc1234"}),
              started("a5", "impl x-22"), finished("a5", {"status": "failed"}),
              started("a6", "integration check"), finished("a6", {"status": "pass", "summary": "suite green"})]
    agents = {"a1": ("10:00", "10:10", "xhigh"), "a2": ("10:11", "10:14", None), "a3": ("10:15", "10:25", "high"),
              "a4": ("10:26", "10:28", "medium"), "a5": ("10:30", "10:52", "high"), "a6": ("10:53", "11:00", "medium")}
    final = {"startTime": int(utc("10:00") * 1000), "durationMs": 65 * 60_000, "timestamp": "2030-03-01T11:05:00Z",
             "result": {"mergeHalted": "merge agent died", "policy": {"impl": "xhigh"},
                        "tickets": [{"id": "x-1", "outcome": "merged", "sha": "abc1234"},
                                    {"id": "x-22", "outcome": "blocked",
                                     "reason": "implementer failed: needs decision: which limit"}]},
             "workflowProgress": [{"type": "workflow_agent", "agentId": "a1", "tokens": 1_250_000, "toolCalls": 40},
                                  {"type": "workflow_agent", "agentId": "a3", "tokens": 64_000, "toolCalls": 12}]}
    add_run(root, home, "wf_done", tickets, launched="2030-03-01T09:59:00", events=events, agents=agents, final=final)
    add_run(root, home, "wf_live", ["x-5", {"id": "x-6", "title": "Ticket x-6", "deps": ["x-5"], "has_ac": True}],
            launched="2099-03-01T08:00:00", events=[{"type": "launched"}, started("b1", "impl x-5")])


def run_status(*args, cwd, env):
    """Exit code, stdout and stderr. A run still going after 30s fails the check instead of
    hanging the suite: an argument mistake that starts a watch would never end."""
    try:
        res = subprocess.run([STATUS, *args], cwd=cwd, env=env, capture_output=True, text=True, timeout=30)
    except subprocess.TimeoutExpired:
        return "timeout", "", "no exit after 30s"
    return res.returncode, res.stdout, res.stderr


def check_output(name, result, want_out, want_code=0, want_err=""):
    """Check a run_status result, showing a line diff of stdout when it is not the one wanted."""
    code, out, err = result
    diff = "\n      ".join(difflib.unified_diff(want_out.splitlines(), out.splitlines(), "want", "got", lineterm=""))
    check(name, (code, out, err) == (want_code, want_out, want_err), f"exit {code}, stderr {err!r}\n      {diff}")


def lines(rows):
    return "\n".join(rows) + "\n"


# ---------- status: the report forms, unchanged ----------

# What run-tickets-status printed for report_runs' records before --ticket, --watch and --find-ticket existed.
REPORT_TEXT = [
    "run-tickets wf_done  [finished]  branch epic/wf_done",
    "launched 2030-03-01 10:00, finished 2030-03-01 11:05 (1h05m)  merged 1/2",
    "MERGES HALTED: merge agent died",
    "",
    "  x-1   merged abc1234",
    "        Add the menu  (agent runs: impl 1, AC 0 failed, review 1, merge conflicts 0)",
    "        owner decision: use the short form",
    "        needs a person to check: menu opens: open it on a phone",
    "        time: 28m start to merge (impl 10m, AC 3m, review 10m, merge 2m, waiting 3m)",
    "        started: impl 10:00 (10m), AC 10:11 (3m), review 10:15 (10m), merge 10:26 (2m)",
    "        effort: impl xhigh 1.2M, AC -, review high 64k, merge medium; src lines 12, dependents 1",
    "        findings filed: x-9 (x-e)",
    "  x-22  BLOCKED: implementer failed: needs decision: which limit",
    "        Fix the list  (agent runs: impl 1, AC 0 failed, review 0, merge conflicts 0)",
    "        time: 22m start to block, began 30m after launch (impl 22m)",
    "        started: impl 10:30 (22m)",
    "        effort: impl high; src lines ?, dependents 0",
    "",
    "integration check: pass (started 10:53, 7m), suite green",
    "",
    "agent time by step: impl 32m, AC 3m, review 10m, merge 2m, integration check 7m"
    "  (sum 54m; steps of different tickets overlap)",
    "tokens by step: impl 1.2M, review 64k",
]
LIVE_TEXT = [
    "run-tickets wf_live  [running]  branch epic/wf_live",
    "launched 2099-03-01 08:00, running 0s  last agent activity ?  merged 0/2",
    "",
    "  x-5  implementing",
    "       Ticket x-5  (agent runs: impl 0, AC 0 failed, review 0, merge conflicts 0)",
    "       started: impl ?",
    "       effort: impl -; src lines ?, dependents 1",
    "  x-6  waiting on x-5",
    "       Ticket x-6  (agent runs: impl 0, AC 0 failed, review 0, merge conflicts 0)",
]
REPORT_JSON = json.loads(
    '{"run_id":"wf_done","state":"finished","started":"2030-03-01T10:00:00+00:00",'
    '"ended":"2030-03-01T11:05:00+00:00","duration_seconds":3900.0,'
    '"last_activity":"2030-03-01T11:00:00+00:00","integration_branch":"epic/wf_done",'
    '"merge_halted":"merge agent died","integration_check":{"status":"pass","summary":"suite green"},'
    '"agent_seconds_by_step":{"impl":1920.0,"ac":180.0,"review":600.0,"merge":120.0,'
    '"integration check":420.0},"tokens_by_step":{"impl":1250000,"ac":0,"review":64000,"merge":0},'
    '"policy":{"impl":"xhigh"},"tickets":[{"id":"x-1","title":"Add the menu","status":"merged abc1234",'
    '"outcome":"merged","deps":[],"has_ac":true,"dependents":1,"src_lines_changed":12,"impl_rounds":1,'
    '"ac_fails":0,"review_rounds":1,"reworks":0,"conflicts":0,"gate_fails":0,'
    '"human_checks":["menu opens: open it on a phone"],"decision":"use the short form",'
    '"prior_findings":{"fixed":0,"total":0},"findings":["x-9 (x-e)"],"timing":{"began_after_launch":0.0,'
    '"wall":1680.0,"steps":{"impl":600.0,"ac":180.0,"review":600.0,"merge":120.0},"waiting":180.0,'
    '"running_for":null},"steps":[{"step":"impl","round":1,"agent_id":"a1","effort":"xhigh",'
    '"model":"claude-test","started":"2030-03-01T10:00:00+00:00","seconds":600.0,"tokens":1250000,'
    '"tool_calls":40,"result":"done","src_lines_changed":12},{"step":"ac","round":1,"agent_id":"a2",'
    '"effort":null,"model":"claude-test","started":"2030-03-01T10:11:00+00:00","seconds":180.0,"tokens":null,'
    '"tool_calls":null,"result":"PASS"},{"step":"review","round":1,"agent_id":"a3","effort":"high",'
    '"model":"claude-test","started":"2030-03-01T10:15:00+00:00","seconds":600.0,"tokens":64000,'
    '"tool_calls":12,"result":"CLEAN","findings":0,"prior_findings":{"fixed":0,"total":0}},{"step":"merge",'
    '"round":1,"agent_id":"a4","effort":"medium","model":"claude-test","started":"2030-03-01T10:26:00+00:00",'
    '"seconds":120.0,"tokens":null,"tool_calls":null,"result":"merged"}]},{"id":"x-22",'
    '"title":"Fix the list","status":"BLOCKED: implementer failed: needs decision: which limit",'
    '"outcome":"blocked","deps":["x-1"],"has_ac":false,"dependents":0,"src_lines_changed":null,'
    '"impl_rounds":1,"ac_fails":0,"review_rounds":0,"reworks":0,"conflicts":0,"gate_fails":0,'
    '"human_checks":[],"decision":null,"prior_findings":{"fixed":0,"total":0},"findings":[],'
    '"timing":{"began_after_launch":1800.0,"wall":1320.0,"steps":{"impl":1320.0},"waiting":0,'
    '"running_for":null},"steps":[{"step":"impl","round":1,"agent_id":"a5","effort":"high",'
    '"model":"claude-test","started":"2030-03-01T10:30:00+00:00","seconds":1320.0,"tokens":null,'
    '"tool_calls":null,"result":"failed"}]}]}'
)
LIST_TEXT = [
    "wf_live  2099-03-01 08:00  not finished, 2 tickets  [x-5 x-6]",
    "wf_done  2030-03-01 10:00  finished in 1h05m, merged 1/2  [x-1 x-22]",
]

with tempfile.TemporaryDirectory() as tmp:
    root, home, env = status_repo(tmp)
    report_runs(root, home)
    check_output("status: the text report of a finished run is unchanged", run_status("wf_done", cwd=root, env=env),
                 lines(REPORT_TEXT))
    check_output("status: the text report of a running run is unchanged", run_status("wf_live", cwd=root, env=env),
                 lines(LIVE_TEXT))
    check_output("status: --json is unchanged", run_status("--json", "wf_done", cwd=root, env=env),
                 json.dumps(REPORT_JSON, indent=2) + "\n")
    archived = os.path.join(home, ".claude", "run-history", "repo", "wf_done.json")
    check_output("status: --archive says where it wrote", run_status("--archive", "wf_done", cwd=root, env=env),
                 f"archived wf_done to {archived}\n")
    check("status: the --archive file is unchanged",
          Path(archived).read_text() == json.dumps({"repo": root, **REPORT_JSON}, indent=2))
    check_output("status: --list is unchanged", run_status("--list", cwd=root, env=env), lines(LIST_TEXT))

    # --ticket: the lines before the first ticket block, then that block as the whole report prints it.
    opening, x1, x22 = REPORT_TEXT[:4], REPORT_TEXT[4:12], REPORT_TEXT[12:17]
    check_output("status --ticket: the report's opening lines and that ticket's block, nothing after",
                 run_status("--ticket", "x-22", "wf_done", cwd=root, env=env), lines(opening + x22))
    check_output("status --ticket: the run id may come first", run_status("wf_done", "--ticket", "x-1", cwd=root, env=env),
                 lines(opening + x1))
    check_output("status --ticket: a run with no merge halt has no MERGES HALTED line",
                 run_status("--ticket", "x-6", "wf_live", cwd=root, env=env), lines(LIVE_TEXT[:3] + LIVE_TEXT[7:]))
    check_output("status --ticket: a ticket the run does not hold says so on stderr and exits 1",
                 run_status("--ticket", "x-9", "wf_done", cwd=root, env=env), "", 1, "ticket x-9 is not in run wf_done\n")


# ---------- status: --watch ----------

class Watch:
    """A --watch process; its stdout split into rounds at each screen clear."""

    def __init__(self, *args, cwd, env):
        self.err = tempfile.TemporaryFile()
        self.proc = subprocess.Popen([STATUS, *args], cwd=cwd, env=env, stdout=subprocess.PIPE, stderr=self.err)
        self.out = b""
        self.clears = []  # when each screen clear arrived, by the monotonic clock
        self.reader = threading.Thread(target=self._read, daemon=True)
        self.reader.start()

    def _read(self):
        while chunk := os.read(self.proc.stdout.fileno(), 65536):
            self.out += chunk
            self.clears += [time.monotonic()] * chunk.count(CLEAR.encode())

    def rounds(self):
        """The rounds printed in full: each ends where the next clear begins."""
        return self.out.decode(errors="replace").split(CLEAR)[1:-1]

    def wait_for(self, done, timeout=20):
        """Wait until done(rounds) holds; False if it never does or the process exits."""
        deadline = time.monotonic() + timeout
        while not done(self.rounds()):
            if time.monotonic() > deadline or self.proc.poll() is not None:
                return False
            time.sleep(0.05)
        return True

    def interrupt(self):
        """Ctrl-C: the exit code, and what the process wrote to stderr."""
        self.proc.send_signal(signal.SIGINT)
        try:
            code = self.proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            code = "still running 10s after SIGINT"
        self.reader.join(5)
        self.err.seek(0)
        return code, self.err.read().decode(errors="replace")

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        if self.proc.poll() is None:
            self.proc.kill()
            self.proc.wait()
        self.reader.join(5)
        self.proc.stdout.close()
        self.err.close()


# A process started with SIGINT ignored (a test run in the background of a non-interactive
# shell) passes that on, and Python then never raises KeyboardInterrupt in the child. With a
# handler here, the child starts with SIGINT at its default, as it does in a terminal.
signal.signal(signal.SIGINT, signal.default_int_handler)

with tempfile.TemporaryDirectory() as tmp:
    root, home, env = status_repo(tmp)
    report_runs(root, home)
    once = run_status("--ticket", "x-22", "wf_done", cwd=root, env=env)[1]
    begun = time.monotonic()
    with Watch("--ticket", "x-22", "--watch", "1", "wf_done", cwd=root, env=env) as w:
        w.wait_for(lambda rounds: len(rounds) >= 2)
        took = time.monotonic() - begun
        rounds = w.rounds()
        first_out = w.out
        clears = list(w.clears)
        code, err = w.interrupt()
    check("status --watch: each round clears the screen and prints the --ticket report", rounds[:2] == [once, once], rounds)
    check("status --watch: nothing is written before the first clear", first_out.startswith(CLEAR.encode()),
          first_out[:80])
    check("status --watch: rounds come the given number of seconds apart", took >= 1.9, f"third round after {took:.2f}s")
    # Measured between clears, so process startup is left out and the bound holds under load.
    gap = clears[2] - clears[1] if len(clears) >= 3 else None
    check("status --watch: a round comes about N seconds after the last, not much later",
          gap is not None and gap < 1.8, f"gap {gap}")
    check("status --watch: Ctrl-C exits 0 with nothing on stderr", (code, err) == (0, ""), f"{code} {err}")

    # The run appears while the watch is going, first with a journal caught mid-write.
    no_run = "run-tickets-status: no run wf_late (no run record in .worktrees/ and no finished-run metadata)\n"
    not_held = "ticket x-9 is not in run wf_late\n"
    with Watch("--ticket", "x-9", "--watch", "1", "wf_late", cwd=root, env=env) as w:
        missing = w.wait_for(lambda rounds: rounds[:1] == [no_run])
        add_run(root, home, "wf_late", ["x-1"], launched="2030-03-01T09:00:00", events=[{"type": "launched"}])
        journal_of(home, "wf_late").write_text('{"type": "launched"}\n{"type": "star')
        torn = w.wait_for(lambda rounds: any(r.startswith("run-tickets-status: JSONDecodeError: ") for r in rounds))
        journal_of(home, "wf_late").write_text('{"type": "launched"}\n')
        held = w.wait_for(lambda rounds: rounds[-2:] == [not_held, not_held])
        code, err = w.interrupt()
    check("status --watch: a round that finds no run says so, and the watch goes on", missing)
    check("status --watch: a round that cannot read the journal says why, and the next round reads it again", torn)
    check("status --watch: a ticket the run does not hold is said each round, and the watch goes on", held)
    check("status --watch: Ctrl-C after rounds that failed still exits 0 with nothing on stderr",
          (code, err) == (0, ""), f"{code} {err}")


# ---------- status: --find-ticket ----------

def found(ticket, cwd, env):
    return run_status("--find-ticket", ticket, cwd=cwd, env=env)


with tempfile.TemporaryDirectory() as tmp:
    root, home, env = status_repo(tmp)
    # wf_a and wf_c are running. wf_c was launched later but its record is older, so file age cannot pick it.
    # wf_a has x-3 merged and x-8 blocked (its implementer failed).
    add_run(root, home, "wf_a", ["x-1", "x-3", "x-4", "x-8"], launched="2030-03-01T10:00:00",
            record_mtime=utc("12:00"),
            events=[{"type": "launched"}, started("a1", "impl x-1"), started("a3", "merge x-3"),
                    finished("a3", {"result": "merged", "sha": "f00"}), started("a4", "impl x-4"),
                    started("a8", "impl x-8"), finished("a8", {"status": "failed"})])
    add_run(root, home, "wf_c", ["x-4"], launched="2030-03-01T11:00:00", record_mtime=utc("09:00"),
            events=[{"type": "launched"}, started("c1", "review x-4")])
    # wf_b was launched after both and has finished.
    add_run(root, home, "wf_b", ["x-1", "x-2"], launched="2030-03-01T12:00:00", events=[{"type": "launched"}],
            final={"startTime": int(utc("12:00") * 1000), "durationMs": 60_000, "timestamp": "2030-03-01T12:01:00Z",
                   "result": {"tickets": [{"id": "x-1", "outcome": "blocked"}, {"id": "x-2", "outcome": "merged"}]}})
    # wf_d, launched last, is launching: it has a run id but the workflow has not written its journal yet.
    add_run(root, home, "wf_d", ["x-4"], launched="2030-03-01T13:00:00")
    # wf_e's metadata is an earlier pass's: its journal has moved on since, so it is running again.
    add_run(root, home, "wf_e", ["x-5"], launched="2030-03-01T09:00:00",
            events=[{"type": "launched"}, started("e1", "impl x-5")],
            final={"startTime": int(utc("09:00") * 1000), "durationMs": 60_000, "timestamp": "2020-01-01T00:00:00Z",
                   "result": {"tickets": [{"id": "x-5", "outcome": "blocked"}]}})
    # wf_f's record has no launch time, so it counts as launched before any run that has one.
    add_run(root, home, "wf_f", ["x-7"], events=[{"type": "launched"}, started("f1", "impl x-7")])
    add_run(root, home, "wf_g", ["x-7"], launched="2030-03-01T08:00:00",
            events=[{"type": "launched"}, started("g1", "impl x-7")])
    # A record the lead has written but not yet given the run id.
    Path(root, ".worktrees", "run-pending.json").write_text(json.dumps(
        {"stamp": "pending", "args": {"tickets": [{"id": "x-6", "title": "t", "deps": [], "has_ac": True}]}}))

    check_output("status --find-ticket: the running run holding it unmerged, though a run launched later finished",
                 found("x-1", root, env), '{"run_id": "wf_a", "state": "running"}\n')
    check_output("status --find-ticket: a ticket only a finished run holds exits 1 with no output", found("x-2", root, env), "", 1)
    check_output("status --find-ticket: a ticket the running run has merged exits 1 with no output",
                 found("x-3", root, env), "", 1)
    check_output("status --find-ticket: of two running runs, the one launched last; a launching run does not count",
                 found("x-4", root, env), '{"run_id": "wf_c", "state": "running"}\n')
    check_output("status --find-ticket: a run whose metadata a resume has outdated is running",
                 found("x-5", root, env), '{"run_id": "wf_e", "state": "running"}\n')
    check_output("status --find-ticket: a record with no run id yet is skipped, not a failure", found("x-6", root, env), "", 1)
    check_output("status --find-ticket: a run with no launch time loses to one that has it",
                 found("x-7", root, env), '{"run_id": "wf_g", "state": "running"}\n')
    check_output("status --find-ticket: a ticket blocked in a running run is still held by it",
                 found("x-8", root, env), '{"run_id": "wf_a", "state": "running"}\n')
    code, out, err = run_status("wf_d", cwd=root, env=env)
    check("status: a launching run (record, no journal yet) reports instead of crashing",
          code == 0 and out.startswith("run-tickets wf_d  [launching]"), f"{code} {out[:80]!r} {err[-200:]!r}")

    meta_dir = os.path.join(home, ".claude", "projects", "p", "s", "workflows")
    Path(meta_dir, "wf_zz.json").write_text('{"workflowName": ')
    check_output("status --find-ticket: a torn metadata file is skipped, not a failure",
                 found("x-1", root, env), '{"run_id": "wf_a", "state": "running"}\n')
    os.remove(os.path.join(meta_dir, "wf_zz.json"))

    good = journal_of(home, "wf_c").read_text()
    journal_of(home, "wf_c").write_text(good + '{"type": "star')
    check_output("status --find-ticket: a torn journal of a run that does not hold the ticket is not read",
                 found("x-1", root, env), '{"run_id": "wf_a", "state": "running"}\n')
    code, out, err = found("x-4", root, env)
    check("status --find-ticket: a journal that does not parse fails the lookup: exit 2, the reason on stderr",
          (code, out) == (2, "") and err.startswith("run-tickets-status: JSONDecodeError: ") and err.count("\n") == 1,
          f"{code} {out!r} {err!r}")
    journal_of(home, "wf_c").write_text(good)

    torn = os.path.join(root, ".worktrees", "run-torn.json")
    Path(torn).write_text('{"stamp": ')
    code, out, err = found("x-1", root, env)
    check("status --find-ticket: an unreadable run record fails the lookup: exit 2, naming the file",
          (code, out) == (2, "") and err.startswith(f"run-tickets-status: ValueError: cannot read {torn}: "),
          f"{code} {out!r} {err!r}")
    os.remove(torn)
    try:
        removed = status.load_json(torn, strict=True)
    except ValueError as e:
        removed = e
    check("status: a record removed after it was listed is not a failure", removed is None, removed)

with tempfile.TemporaryDirectory() as tmp:
    root, home, env = status_repo(tmp)
    os.rmdir(os.path.join(root, ".worktrees"))
    check_output("status --find-ticket: a repo that has never had a run exits 1 with no output",
                 found("x-1", root, env), "", 1)
    outside = os.path.join(tmp, "elsewhere")
    os.makedirs(outside)
    check_output("status --find-ticket: outside a git repo it exits 2 with the reason on stderr",
                 found("x-1", outside, env), "", 2, "run-tickets-status: not inside a git repository\n")
    code, out, err = run_status("--watch", "soon", cwd=root, env=env)
    check("status: a usage error exits 2, the problem on stderr's first line and the usage after it",
          (code, out) == (2, "") and err.splitlines()[0] == "run-tickets-status: --watch needs a whole number of seconds, "
          "1 or more, not soon" and "Usage: run-tickets-status" in err, f"{code} {out!r} {err!r}")


# ---------- status: arguments ----------

def usage_error_of(argv):
    """parse_args' exit code and first stderr line for argv, None when it takes argv, or the
    exception it raised in place of a usage error."""
    err = io.StringIO()
    try:
        with contextlib.redirect_stderr(err):
            status.parse_args(argv)
    except SystemExit as e:
        return e.code, err.getvalue().splitlines()[0]
    except Exception as e:
        return e
    return None


opts = status.parse_args(["--ticket", "x-2", "--watch", "5", "wf_1"])
check("status args: a flag's value is never taken for the run id",
      (opts["run_id"], opts["ticket"], opts["watch"]) == ("wf_1", "x-2", 5), opts)
accepted = ([], ["wf_1"], ["--json", "wf_1"], ["wf_1", "--archive"], ["--json", "--archive"], ["--list"],
            ["--list", "wf_1"], ["--find-ticket", "x-1"], ["--watch", "1"], ["--ticket", "x-1", "--watch", "1"])
check("status args: the existing forms, --find-ticket alone and --watch 1 are accepted",
      [usage_error_of(argv) for argv in accepted] == [None] * len(accepted),
      [usage_error_of(argv) for argv in accepted])
FOR_TEXT = "--ticket and --watch are for the text report, not --list, --json or --archive"
for argv, problem in ((["--watch"], "--watch needs a value"),
                      (["--ticket", "--watch", "5"], "--ticket needs a value"),
                      (["--watch", "0"], "--watch needs a whole number of seconds, 1 or more, not 0"),
                      (["--watch", "2.5"], "--watch needs a whole number of seconds, 1 or more, not 2.5"),
                      (["--tickets", "x-2"], "unknown option --tickets"),
                      (["wf_1", "wf_2"], "one run id at most, not wf_1 and wf_2"),
                      (["--find-ticket", "x-1", "wf_1"], "--find-ticket takes no run id and no other option"),
                      (["--find-ticket", "x-1", "--json"], "--find-ticket takes no run id and no other option"),
                      (["--ticket", "x-1", "--json"], FOR_TEXT),
                      (["--watch", "5", "--archive"], FOR_TEXT),
                      (["--ticket", "x-1", "--list"], FOR_TEXT)):
    got = usage_error_of(argv)
    check(f"status args: {' '.join(argv)} is a usage error", got == (2, f"run-tickets-status: {problem}"), got)

print(f"\n{failures} check(s) failed" if failures else "\nall checks passed")
raise SystemExit(1 if failures else 0)
