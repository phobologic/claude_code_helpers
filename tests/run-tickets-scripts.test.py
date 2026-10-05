"""Checks bin/run-tickets-setup and bin/run-tickets-finish against throwaway git repos, and
run-tickets-status's test for metadata an in-session resume has outdated.

    python3 tests/run-tickets-scripts.test.py

Each scenario builds a repo in a temp dir. tk is replaced by a fake that logs its
arguments and prints ids, and run-tickets-status by a fake archiver, so nothing
touches real tickets or ~/.claude/run-history.
"""

import json
import os
import subprocess
import tempfile
from datetime import datetime, timezone
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

print(f"\n{failures} check(s) failed" if failures else "\nall checks passed")
raise SystemExit(1 if failures else 0)
