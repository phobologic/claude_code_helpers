"""Checks bin/run-tickets-setup and bin/run-tickets-finish against throwaway git repos,
run-tickets-status's test for metadata an in-session resume has outdated, bin/run-tickets-gates's
path matching (and its read of a merge in progress), and bin/run-capped against real process groups.

    python3 tests/run-tickets-scripts.test.py

Each scenario builds a repo in a temp dir. tk is replaced by a fake that logs its
arguments and prints ids, and run-tickets-status by a fake archiver, so nothing
touches real tickets or ~/.claude/run-history.
"""

import json
import os
import signal
import subprocess
import sys
import tempfile
import time
import types
from datetime import datetime, timedelta, timezone
from importlib.machinery import SourceFileLoader
from importlib.util import module_from_spec, spec_from_loader
from pathlib import Path

BIN = Path(__file__).resolve().parent.parent / "bin"
SETUP, FINISH, CAPPED, GATES = (str(BIN / name) for name in
                                ("run-tickets-setup", "run-tickets-finish", "run-capped", "run-tickets-gates"))

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


def alive(pid):
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    return True


def group_alive(pgid):
    try:
        os.killpg(pgid, 0)
    except ProcessLookupError:
        return False
    return True


def gone_soon(probe, ident, seconds=2.0):
    """True once probe(ident) is false; an orphan is reaped by init a moment after it dies."""
    deadline = time.monotonic() + seconds
    while probe(ident):
        if time.monotonic() > deadline:
            return False
        time.sleep(0.05)
    return True


def kill_quietly(pid, group=False):
    try:
        (os.killpg if group else os.kill)(pid, signal.SIGKILL)
    except (ProcessLookupError, PermissionError):
        pass


SLEEPER = """import os, pathlib, signal, sys, time
if "ignore-term" in sys.argv:
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
pathlib.Path(os.path.dirname(__file__), f"ready-{os.getpid()}").touch()
time.sleep(120)
"""


def orphan(tmp, *argv):
    """Start a sleeper whose command line carries argv, detached so its parent is init, like a
    test run its agent gave up on. Returns its pid once it is running."""
    script = Path(tmp, "sleeper.py")
    script.write_text(SLEEPER)
    res = subprocess.run(["sh", "-c", '"$@" >/dev/null 2>&1 & echo $!', "sh", sys.executable, str(script), *argv],
                         capture_output=True, text=True, timeout=10)
    pid = int(res.stdout.strip())
    deadline = time.monotonic() + 10
    while not Path(tmp, f"ready-{pid}").exists() and time.monotonic() < deadline:
        time.sleep(0.05)
    return pid


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
    # Left running by agents: a test in a slot, and one in the integration worktree that ignores
    # SIGTERM. Not this run's: a sibling path that shares the slot's prefix, and an unrelated path.
    in_slot = orphan(tmp, f"{s['slots'][0]}/hooks/guard.test.ts")
    in_integration = orphan(tmp, f"--file={s['integrationWorktree']}", "ignore-term")
    sibling = orphan(tmp, f"{s['slots'][0]}0/hooks/guard.test.ts")
    unrelated = orphan(tmp, os.path.join(tmp, "elsewhere"))
    sleepers = (in_slot, in_integration, sibling, unrelated)
    try:
        log_before = Path(env["TK_LOG"]).read_text()
        code, out, err = run(FINISH, "--dry-run", "--result", result_path, "wf_test", cwd=root, env=env)
        check("finish --dry-run: exits 0", code == 0, err)
        check("finish --dry-run: changes nothing", Path(env["TK_LOG"]).read_text() == log_before and os.path.exists(record)
              and all(os.path.isdir(p) for p in s["slots"]) and all(alive(p) for p in sleepers))
        found = {p["pid"]: p["action"] for p in (out or {}).get("leftover_processes", [])}
        check("finish --dry-run: reports the processes running in the run's worktrees, and only those",
              found == {in_slot: "would stop", in_integration: "would stop"}, found)

        code, out, err = run(FINISH, "--result", result_path, "wf_test", cwd=root, env=env)
        out = out or {}
        found = {p["pid"]: p["action"] for p in out.get("leftover_processes", [])}
        check("finish: stops processes left in the run's worktrees, with SIGKILL for one that ignores SIGTERM",
              found == {in_slot: "stopped", in_integration: "killed"}
              and gone_soon(alive, in_slot) and gone_soon(alive, in_integration), found)
        check("finish: leaves alone processes that name no worktree of this run, even one sharing a slot's prefix",
              alive(sibling) and alive(unrelated))
    finally:
        for pid in sleepers:
            kill_quietly(pid)
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
at = lambda minutes: (launch + timedelta(minutes=minutes)).isoformat(timespec="seconds")
steps = [{"step": "impl", "round": 1, "started": at(2), "seconds": 600},
         {"step": "review", "round": 1, "started": at(12), "seconds": 300},
         {"step": "impl", "round": 2, "started": at(18), "seconds": None},
         {"step": "review", "round": 2, "started": None, "seconds": None}]
line = status.started_line({"steps": steps[:3], "active": ("impl", 2)}, launch, launch + timedelta(minutes=21))
check("status: started line gives each agent's clock time and duration, and the running one's time so far",
      line == "started: impl 23:52 (10m), review 03-02 00:02 (5m), impl r2 03-02 00:08 (running 3m)", line)
line = status.started_line({"steps": steps, "active": None}, launch, launch)
check("status: an agent with no log yet shows a question mark", line.endswith("review r2 ?"), line)

# ---------- finish: which processes the sweep may touch ----------

loader = SourceFileLoader("run_tickets_finish", FINISH)
finish = module_from_spec(spec_from_loader(loader.name, loader))
loader.exec_module(finish)

with tempfile.TemporaryDirectory() as tmp:
    tmp = os.path.realpath(tmp)
    slot = os.path.join(tmp, "repo", ".worktrees", "run-S-slot-1")
    os.makedirs(slot)
    link = os.path.join(tmp, "link")
    os.symlink(os.path.join(tmp, "repo"), link)
    procs = [
        (101, 1, f"bun test {slot}/hooks/a.test.ts"),          # a path under the slot
        (102, 1, f"node --file={slot}"),                        # the slot itself, after =
        (103, 1, f"sh -c 'cd \"{slot}\" && npm test'"),         # quoted
        (104, 1, f"bun test {slot}0/hooks/a.test.ts"),          # run-S-slot-10: shares the prefix
        (105, 1, f"bun test /mnt{slot}/a.test.ts"),             # contains the path, does not start it
        (106, 1, f"bun test {slot}-copy"),                      # a longer name
        (107, 1, "sleep 60"),
        (108, 1, f"vim {link}/.worktrees/run-S-slot-1/x"),      # the slot reached through a symlink
    ]
    found = [pid for pid, _ in finish.leftover_processes(procs, finish.worktree_patterns([slot]), set())]
    check("finish sweep: matches a worktree only as a whole path", found == [101, 102, 103], found)
    found = [pid for pid, _ in finish.leftover_processes(
        procs, finish.worktree_patterns([os.path.join(link, ".worktrees", "run-S-slot-1")]), set())]
    check("finish sweep: a worktree recorded through a symlink also matches its real path", found == [101, 102, 103, 108], found)
    found = [pid for pid, _ in finish.leftover_processes(procs, finish.worktree_patterns([slot]), {101, 103})]
    check("finish sweep: never touches the processes it is told to skip", found == [102], found)
    check("finish sweep: no worktrees, no matches", finish.leftover_processes(procs, finish.worktree_patterns([None]), set()) == [])
    tree = [(1, 0, "init"), (50, 1, "shell"), (60, 50, f"bash -c cd {slot}"), (70, 60, "run-tickets-finish"), (80, 50, "other")]
    check("finish sweep: skips the script and every process above it",
          finish.ancestors(tree, 70) == {70, 60, 50, 1}, finish.ancestors(tree, 70))
    check("finish sweep: a parent loop in the process list ends the walk",
          finish.ancestors([(5, 6, "a"), (6, 5, "b")], 5) == {5, 6})
    found = [pid for pid, _ in finish.leftover_processes(
        [(201, 1, f"env PYTHONPATH=/opt/lib:{slot}/src python3 -m pytest")], finish.worktree_patterns([slot]), set())]
    check("finish sweep: a worktree after : in a path list matches", found == [201], found)

    # A process that exits between ps and the signal is stopped, not a permission failure.
    gone = subprocess.Popen(["true"])
    gone.wait()
    errs = types.SimpleNamespace(errors=[])
    entries = [{"pid": gone.pid, "command": "x", "action": "would stop"}]
    finish.stop_processes(errs, entries)
    check("finish sweep: a process gone before the signal is reported stopped, not failed",
          entries[0]["action"] == "stopped" and errs.errors == [], entries)


class FakePs:
    """A Runner whose ps prints canned output."""

    def __init__(self, code, stdout, stderr=""):
        self.res, self.errors = subprocess.CompletedProcess([], code, stdout, stderr), []

    def read(self, *cmd, cwd=None):
        return self.res


fake = FakePs(0, "  PID  PPID COMMAND\n  12     1 bun test /w/a.test.ts\n  13     1\n  14   12 sleep 5\n")
check("finish sweep: reads pid, ppid and the full command, skipping lines that are not a process",
      finish.list_processes(fake) == [(12, 1, "bun test /w/a.test.ts"), (14, 12, "sleep 5")] and not fake.errors,
      finish.list_processes(fake))
fake = FakePs(1, "", "ps: illegal option")
check("finish sweep: a failing ps finds nothing and reports why",
      finish.list_processes(fake) == [] and fake.errors == ["ps: ps: illegal option"], fake.errors)

with tempfile.TemporaryDirectory() as tmp:
    root, env, s, record, result_path = finished_run(tmp)
    # The lead's own shell names a slot (it cd'd there first): finish must not stop its parent.
    res = subprocess.run(["sh", "-c", '"$0" --dry-run --result "$1" wf_test; status=$?; : "$2"; exit $status',
                          FINISH, result_path, s["slots"][0]], cwd=root, env=env, capture_output=True, text=True, timeout=60)
    found = json.loads(res.stdout or "{}").get("leftover_processes")
    check("finish sweep: never lists its own parent shell, even when that names a worktree",
          res.returncode == 0 and found == [], f"{res.returncode} {found} {res.stderr}")

# ---------- gates ----------

loader = SourceFileLoader("run_tickets_gates", GATES)
gates_mod = module_from_spec(spec_from_loader(loader.name, loader))
loader.exec_module(gates_mod)

SAMPLE_GATES = [
    "make lint",
    {"command": "mods-check", "paths": ["mods/**"]},
    {"command": "judge-test", "paths": ["mods/blast-radius/**"]},
    {"command": "suite", "paths": ["bin/**", "workflows/", "tests/*.py"]},
]


def chosen(files, gates=SAMPLE_GATES):
    return gates_mod.select(gates, files)


check("gates: a file matching two scoped gates runs both, in gate order, after the unscoped one",
      chosen(["mods/blast-radius/bin/judge.py"]) == ["make lint", "mods-check", "judge-test"],
      chosen(["mods/blast-radius/bin/judge.py"]))
check("gates: a file matching no scoped gate runs only the unscoped one", chosen(["README.md"]) == ["make lint"],
      chosen(["README.md"]))
check("gates: no changed files still runs the unscoped one", chosen([]) == ["make lint"])
check("gates: a gate matched by several files is listed once",
      chosen(["bin/a", "bin/b", "workflows/w.js"]) == ["make lint", "suite"], chosen(["bin/a", "bin/b", "workflows/w.js"]))
check("gates: a trailing slash covers everything under the folder", chosen(["workflows/x/y.js"]) == ["make lint", "suite"])
check("gates: * stays within one folder", chosen(["tests/t.py"]) == ["make lint", "suite"]
      and chosen(["tests/sub/t.py"]) == ["make lint"], chosen(["tests/sub/t.py"]))
check("gates: a folder prefix is not a match for a sibling with a longer name",
      chosen(["mods/blast-radius-two/x"]) == ["make lint", "mods-check"], chosen(["mods/blast-radius-two/x"]))
check("gates: mods/** does not match a top-level file named mods", chosen(["modsfile"]) == ["make lint"])
check("gates: a glob must match the whole path, not just its start", chosen(["tests/t.pyc"]) == ["make lint"],
      chosen(["tests/t.pyc"]))


def matches(glob, path):
    return bool(gates_mod.pattern(glob).fullmatch(path))


check("gates: **/ matches at the top level and in any folder",
      matches("**/*.py", "a.py") and matches("**/*.py", "x/y/a.py") and not matches("**/*.py", "a.pyc"))
check("gates: ? is one character within a folder", matches("a?.txt", "ab.txt") and not matches("a?.txt", "a/.txt")
      and not matches("a?.txt", "abc.txt"))
check("gates: a path with no wildcard is that file or the folder's contents",
      matches("src/app", "src/app") and matches("src/app", "src/app/main.go") and not matches("src/app", "src/application"))
check("gates: other characters are literal", matches("a.b/[x]", "a.b/[x]") and not matches("a.b/[x]", "aXb/[x]")
      and not matches("a.b/[x]", "a.b/x"))
check("gates: other characters stay literal next to a wildcard", matches("a.b/[x]/*", "a.b/[x]/f")
      and not matches("a.b/[x]/*", "aXb/[x]/f") and not matches("a.b/[x]/*", "a.b/x/f"))

with tempfile.TemporaryDirectory() as tmp:
    root, env = new_repo(tmp)
    os.makedirs(os.path.join(root, "bin"))
    commit(root, "bin/tool.sh", "echo\n", "tool")
    sh("git", "checkout", "-qb", "ticket/g", cwd=root)
    os.makedirs(os.path.join(root, "mods", "m"))
    commit(root, "mods/m/hook.ts", "x\n", "hook")
    sh("git", "checkout", "-q", "main", cwd=root)
    sh("git", "merge", "--no-ff", "--no-commit", "ticket/g", cwd=root)
    res = subprocess.run([GATES, json.dumps(SAMPLE_GATES)], cwd=root, capture_output=True, text=True)
    check("gates: during a merge it reads the files the merge changes",
          res.returncode == 0 and res.stdout.splitlines() == ["make lint", "mods-check"], res.stdout + res.stderr)
    check("gates: stderr names the skipped gates", "judge-test" in res.stderr and "suite" in res.stderr, res.stderr)
    sh("git", "merge", "--abort", cwd=root)

    # A file moved out of bin/ still runs bin's gate: the old path counts as changed.
    sh("git", "checkout", "-qb", "ticket/mv", cwd=root)
    os.makedirs(os.path.join(root, "docs"))
    sh("git", "mv", "bin/tool.sh", "docs/tool.sh", cwd=root)
    sh("git", "commit", "-qm", "move", cwd=root)
    sh("git", "checkout", "-q", "main", cwd=root)
    sh("git", "merge", "--no-ff", "--no-commit", "ticket/mv", cwd=root)
    res = subprocess.run([GATES, json.dumps(SAMPLE_GATES)], cwd=root, capture_output=True, text=True)
    check("gates: a file moved out of a gate's paths still runs that gate",
          res.stdout.splitlines() == ["make lint", "suite"], res.stdout + res.stderr)
    sh("git", "merge", "--abort", cwd=root)

    # A name git would quote (non-ASCII) still matches its gate.
    sh("git", "checkout", "-qb", "ticket/q", "main", cwd=root)
    os.makedirs(os.path.join(root, "mods", "q"))
    commit(root, "mods/q/café.txt", "x\n", "quoted")
    sh("git", "checkout", "-q", "main", cwd=root)
    sh("git", "merge", "--no-ff", "--no-commit", "ticket/q", cwd=root)
    res = subprocess.run([GATES, json.dumps(SAMPLE_GATES)], cwd=root, capture_output=True, text=True)
    check("gates: a changed file whose name git would quote still runs its gate",
          res.stdout.splitlines() == ["make lint", "mods-check"], res.stdout + res.stderr)
    sh("git", "merge", "--abort", cwd=root)

    res = subprocess.run([GATES, json.dumps(SAMPLE_GATES)], cwd=tmp, capture_output=True, text=True)
    check("gates: outside a git repo it fails instead of choosing from nothing", res.returncode == 1 and not res.stdout,
          res.stdout + res.stderr)

for bad in ('{"command": "x"}', "[3]", '[{"command": "x", "paths": []}]', '[{"command": "x"}]', '[{"command": "x", "path": ["a"]}]',
            '[{"command": "x", "paths": ["a"], "extra": 1}]',
            '[{"command": "", "paths": ["a"]}]', '[{"command": "x", "paths": [""]}]', '[{"command": "x", "paths": "a"}]',
            '["a\\nb"]', '[""]', "not json", '[{"command": "x", "paths": ["/a"]}]', '[{"command": "x", "paths": ["./a"]}]'):
    res = subprocess.run([GATES, bad, "--files", "a"], capture_output=True, text=True)
    check(f"gates: malformed gates exit 2 without choosing: {bad}", res.returncode == 2 and not res.stdout, res.stdout + res.stderr)
res = subprocess.run([GATES, "[]", "--bogus"], capture_output=True, text=True)
check("gates: an unknown argument exits 2", res.returncode == 2 and not res.stdout)
res = subprocess.run([GATES], capture_output=True, text=True)
check("gates: no arguments exits 2 with the usage", res.returncode == 2 and "Usage" in res.stderr)
res = subprocess.run([GATES, "--help"], capture_output=True, text=True)
check("gates: --help exits 2 with the usage", res.returncode == 2 and "Usage" in res.stderr, res.stderr)

# ---------- run-capped ----------

GROUP = """trap '' TERM
echo $$ > "$1"
sh -c 'while :; do sleep 0.1; done' &
echo $! >> "$1"
wait
"""


def capped(*args, timeout=30):
    start = time.monotonic()
    res = subprocess.run([CAPPED, *args], capture_output=True, text=True, timeout=timeout)
    return res.returncode, res.stderr, time.monotonic() - start


def pids(path):
    return [int(x) for x in Path(path).read_text().split()]


def kill_group_in(pidfile):
    """Clean up after a failed check: SIGKILL the group whose leader the pidfile names."""
    if os.path.exists(pidfile) and Path(pidfile).read_text().strip():
        kill_quietly(pids(pidfile)[0], group=True)


with tempfile.TemporaryDirectory() as tmp:
    script, pidfile = os.path.join(tmp, "group.sh"), os.path.join(tmp, "pids")
    Path(script).write_text(GROUP)
    # The leader and its looping child both ignore SIGTERM, so only SIGKILL ends them.
    try:
        code, err, took = capped("1", "sh", script, pidfile)
        leader, child = pids(pidfile)
        check("run-capped: a command over its limit exits 124 with a TIMEOUT line naming SIGKILL",
              code == 124 and "run-capped: TIMEOUT after 1s" in err and "SIGKILL" in err, f"{code} {err}")
        check("run-capped: waits the default 2s grace after SIGTERM, then SIGKILLs, within a few seconds of the limit",
              3 <= took < 8, took)
        check("run-capped: the whole process group is gone after a timeout",
              gone_soon(group_alive, leader) and gone_soon(alive, child), pids(pidfile))
    finally:
        kill_group_in(pidfile)

    os.remove(pidfile)
    try:
        # Lower bounds only: a loaded machine makes things slower, never faster.
        code, err, took = capped("--grace", "4", "1", "--", "sh", script, pidfile)
        check("run-capped: --grace sets the wait between SIGTERM and SIGKILL", code == 124 and 5 <= took < 12, f"{code} {took}")
        check("run-capped: the group is gone after a longer grace too", gone_soon(group_alive, pids(pidfile)[0]))
    finally:
        kill_group_in(pidfile)

    # A grace of 5s leaves a wide gap between stopping on SIGTERM (about 1s) and waiting it out (6s).
    code, err, took = capped("--grace", "5", "1", "sh", "-c", "while :; do sleep 0.1; done")
    check("run-capped: a command that exits on SIGTERM is stopped without waiting out the grace",
          code == 124 and "with SIGTERM." in err and took < 4, f"{code} {took} {err}")

    code, err, _ = capped("5", "true")
    check("run-capped: passes a clean exit through, with no TIMEOUT line", code == 0 and "TIMEOUT" not in err, f"{code} {err}")
    code, err, _ = capped("5", "--", "sh", "-c", "exit 3")
    check("run-capped: passes a failing exit status through", code == 3 and "TIMEOUT" not in err, f"{code} {err}")
    code, _, _ = capped("5", "sh", "-c", "kill -9 $$")
    check("run-capped: a command killed by signal N exits 128+N", code == 137, code)
    code, err, _ = capped("5", os.path.join(tmp, "no-such-command"))
    check("run-capped: a command that cannot start exits 127", code == 127 and "cannot run" in err, f"{code} {err}")
    for bad in (["0", "true"], ["-1", "true"], ["soon", "true"], ["5"], ["5", "--"], [], ["--grace"], ["--grace", "x", "5", "true"]):
        code, err, _ = capped(*bad)
        check(f"run-capped: usage error for {bad}", code == 2 and "Usage:" in err, f"{code} {err}")

    # The leader exits normally but leaves a looping child in its group: it is stopped too.
    left = os.path.join(tmp, "left")
    code, _, _ = capped("10", "sh", "-c", f"sh -c 'while :; do sleep 0.1; done' >/dev/null 2>&1 & echo $! > {left}; exit 0")
    child = pids(left)[0]
    check("run-capped: stops what the command left running in its group when it exits", code == 0 and gone_soon(alive, child), code)
    kill_quietly(child)

    # The caller gives up on run-capped itself: the group goes with it.
    os.remove(pidfile)
    wrapper = subprocess.Popen([CAPPED, "60", "sh", "-c", f"echo $$ > {pidfile}; while :; do sleep 0.1; done"],
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        deadline = time.monotonic() + 10
        while not (os.path.exists(pidfile) and Path(pidfile).read_text().strip()) and time.monotonic() < deadline:
            time.sleep(0.05)
        leader = pids(pidfile)[0]
        wrapper.send_signal(signal.SIGTERM)
        code = wrapper.wait(timeout=10)
        check("run-capped: on SIGTERM it stops the command's group and exits 143",
              code == 143 and gone_soon(group_alive, leader), code)
    finally:
        wrapper.kill()
        kill_group_in(pidfile)

    # Ctrl-C reaches only run-capped's own group, never the command's new session, and a
    # closed terminal sends SIGHUP: both must take the command's group down too.
    for sig in (signal.SIGINT, signal.SIGHUP):
        os.remove(pidfile)
        wrapper = subprocess.Popen([CAPPED, "60", "sh", "-c", f"echo $$ > {pidfile}; while :; do sleep 0.1; done"],
                                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        try:
            deadline = time.monotonic() + 10
            while not (os.path.exists(pidfile) and Path(pidfile).read_text().strip()) and time.monotonic() < deadline:
                time.sleep(0.05)
            leader = pids(pidfile)[0]
            wrapper.send_signal(sig)
            code = wrapper.wait(timeout=10)
            check(f"run-capped: on {sig.name} it stops the command's group and exits {128 + sig}",
                  code == 128 + sig and gone_soon(group_alive, leader), code)
        finally:
            wrapper.kill()
            kill_group_in(pidfile)

print(f"\n{failures} check(s) failed" if failures else "\nall checks passed")
raise SystemExit(1 if failures else 0)
