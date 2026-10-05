"""Checks bin/wrap-epic-plan against a throwaway git repo and fixture tickets.

    python3 tests/wrap-epic-plan.test.py

The script is the one definition of what blocks a wrap, so every
classification rule is checked, along with branch resolution (epic branch,
merged tickets, ambiguity, current branch, a planning epic's sub-epic), when
the parent epic closes too, and which runner worktrees belong to another run.
"""

import json
import os
import shutil
import subprocess
import tempfile
from pathlib import Path

SCRIPT = Path(__file__).resolve().parent.parent / "bin" / "wrap-epic-plan"

failures = 0


def check(name, got, want):
    global failures
    ok = got == want
    failures += not ok
    print(f"{'PASS' if ok else 'FAIL'}  {name}" + ("" if ok else f"\n      got  {got!r}\n      want {want!r}"))


def sh(*args, cwd):
    subprocess.run(args, cwd=cwd, check=True, capture_output=True, text=True)


def commit(repo, path, text, msg):
    full = os.path.join(repo, path)
    os.makedirs(os.path.dirname(full), exist_ok=True)
    with open(full, "w") as f:
        f.write(text)
    sh("git", "add", path, cwd=repo)
    sh("git", "commit", "-q", "-m", msg, cwd=repo)


def ticket(tdir, tid, title, status="open", type="task", priority=2, parent=None, tags=(), body="",
           created="2026-01-01T00:00:00Z"):
    lines = ["---", f"id: {tid}", f"status: {status}", "deps: []", "links: []", f"created: {created}",
             f"type: {type}", f"priority: {priority}"]
    if parent:
        lines.append(f"parent: {parent}")
    if tags:
        lines.append(f"tags: [{', '.join(tags)}]")
    lines += ["---", f"# {title}", "", body, ""]
    with open(os.path.join(tdir, f"{tid}.md"), "w") as f:
        f.write("\n".join(lines))


def plan(repo, tdir, *args, cwd=None):
    out = subprocess.run([str(SCRIPT), *args], cwd=cwd or repo, capture_output=True, text=True,
                         env={**os.environ, "TICKETS_DIR": tdir})
    return out.returncode, (json.loads(out.stdout) if out.returncode == 0 else None), out.stderr


tmp = tempfile.mkdtemp()
try:
    repo = os.path.realpath(os.path.join(tmp, "repo"))
    os.makedirs(repo)
    sh("git", "init", "-q", "-b", "main", cwd=repo)
    sh("git", "config", "user.name", "Test", cwd=repo)
    sh("git", "config", "user.email", "test@example.com", cwd=repo)
    commit(repo, ".gitignore", ".tickets/\n.worktrees/\n", "ignore")
    tdir = os.path.join(repo, ".tickets")
    os.makedirs(tdir)

    # ---------- fixtures ----------
    ticket(tdir, "bl", "Backlog: pre-existing findings", type="epic", priority=3, tags=["backlog"])
    ticket(tdir, "bl-1", "Parser drops trailing comma", parent="bl", tags=["code-review", "preexisting"],
           body="**Files**: src/parser.ts:10-20\n")
    ticket(tdir, "bl-2", "Old parser note", status="closed", parent="bl", body="**Files**: src/parser.ts\n")

    ticket(tdir, "e1", "Search filters", type="epic", parent="root-epic")
    ticket(tdir, "e1-reg", "Filter resets on reload", priority=3, parent="e1",
           tags=["code-review", "quality", "regression"], body="**Files**: src/filter.ts\n**Source ticket**: e1-t9\n")
    ticket(tdir, "e1-pre", "Parser ignores whitespace", priority=2, parent="e1",
           tags=["code-review", "quality", "preexisting"], body="**Files**: src/parser.ts:5\n")
    ticket(tdir, "e1-nor", "Retry count is fixed", priority=2, parent="e1", tags=["code-review", "quality"],
           body="**Files**: src/retry.ts\n")
    ticket(tdir, "e1-p1", "Null session crashes handler", priority=1, parent="e1", tags=["code-review"])
    ticket(tdir, "e1-hum", "Confirm disputed criterion", priority=2, parent="e1", tags=["needs-human"])
    ticket(tdir, "e1-task", "Add filter chips", priority=2, parent="e1")
    ticket(tdir, "e1-dec", "Decide: default sort order", priority=2, parent="e1", tags=["decision"])
    ticket(tdir, "e1-done", "Old regression", status="closed", priority=3, parent="e1",
           tags=["code-review", "regression"])

    ticket(tdir, "e2", "Finished epic", type="epic")
    ticket(tdir, "e2-a", "Done work", status="closed", parent="e2")

    ticket(tdir, "e3", "Run-branch epic", type="epic")
    ticket(tdir, "t3a", "Add export", status="closed", parent="e3")

    ticket(tdir, "e4", "Ambiguous epic", type="epic")
    ticket(tdir, "t4a", "First half", status="closed", parent="e4")
    ticket(tdir, "t4b", "Second half", status="closed", parent="e4")

    ticket(tdir, "plain", "A task", priority=2)

    # Planning epics: /spec's shape (a top-level epic over one execution sub-epic) and two variants.
    ticket(tdir, "top", "Planning view", type="epic")
    ticket(tdir, "exec", "Planning view -- execution", type="epic", parent="top")
    ticket(tdir, "exec-a", "Build it", status="closed", parent="exec")
    ticket(tdir, "top2", "Two runs", type="epic")
    ticket(tdir, "sub1", "First run", type="epic", parent="top2")
    ticket(tdir, "sub2", "Second run", type="epic", parent="top2")
    ticket(tdir, "top3", "Planning view with loose work", type="epic")
    ticket(tdir, "exec3", "Execution", type="epic", parent="top3")
    ticket(tdir, "top3-task", "Write the launch post", parent="top3")

    # ---------- git history ----------
    commit(repo, "README.md", "base\n", "base")
    for sub in ("exec", "sub1", "sub2", "exec3"):
        sh("git", "branch", f"epic/{sub}", cwd=repo)
    sh("git", "branch", "epic/e1", cwd=repo)
    sh("git", "checkout", "-q", "epic/e1", cwd=repo)
    commit(repo, "src/filter.ts", "a\n", "filter")
    commit(repo, "src/chips.ts", "b\n", "chips")
    sh("git", "checkout", "-q", "main", cwd=repo)
    commit(repo, "docs/notes.md", "n\n", "main moves on")

    def merge_branch(target, source_branch, subject, path):
        sh("git", "checkout", "-q", "-b", source_branch, "main", cwd=repo)
        commit(repo, path, source_branch + "\n", f"work on {source_branch}")
        sh("git", "checkout", "-q", target, cwd=repo)
        sh("git", "merge", "-q", "--no-ff", "-m", subject, source_branch, cwd=repo)
        sh("git", "checkout", "-q", "main", cwd=repo)

    sh("git", "branch", "run/20260101-000000", "main", cwd=repo)
    merge_branch("run/20260101-000000", "ticket/t3a", "Merge t3a: Add export", "src/export.ts")
    sh("git", "branch", "run/20260102-000000", "main", cwd=repo)
    merge_branch("run/20260102-000000", "ticket/t4a", "Merge t4a: First half", "src/half_a.ts")
    sh("git", "branch", "fix/batch-20260103-000000", "main", cwd=repo)
    merge_branch("fix/batch-20260103-000000", "fix/t4b", "Fix t4b: Second half", "src/half_b.ts")

    # Worktrees: one in this epic's run, one in another run's record, one not a runner worktree.
    wt = os.path.join(repo, ".worktrees")
    sh("git", "worktree", "add", "-q", os.path.join(wt, "run-222-integration"), "epic/e1", cwd=repo)
    sh("git", "worktree", "add", "-q", "-b", "run-222-slot-1", os.path.join(wt, "run-222-slot-1"), cwd=repo)
    sh("git", "worktree", "add", "-q", "-b", "run-111-slot-1", os.path.join(wt, "run-111-slot-1"), cwd=repo)
    sh("git", "worktree", "add", "-q", "-b", "scratch", os.path.join(wt, "scratch"), cwd=repo)
    with open(os.path.join(wt, "run-222.json"), "w") as f:
        json.dump({"args": {"integrationBranch": "epic/e1", "integrationWorktree": os.path.join(wt, "run-222-integration"),
                            "slots": [os.path.join(wt, "run-222-slot-1")]}}, f)
    with open(os.path.join(wt, "run-111.json"), "w") as f:
        json.dump({"args": {"integrationBranch": "epic/other", "integrationWorktree": os.path.join(wt, "run-111-integration"),
                            "slots": [os.path.join(wt, "run-111-slot-1")]}}, f)

    # ---------- classification ----------
    rc, p, err = plan(repo, tdir, "e1")
    check("e1: exit 0", rc, 0)
    blocking = {b["id"]: b["why"] for b in p["blocking"]}
    check("regression P3 blocks", blocking.get("e1-reg"), ["regression"])
    check("no-origin code-review P1 blocks", blocking.get("e1-p1"), ["P1"])
    check("needs-human non-finding blocks", blocking.get("e1-hum"), ["needs-human"])
    check("source ticket parsed", next(b for b in p["blocking"] if b["id"] == "e1-reg")["source_ticket"], "e1-t9")
    movable = {m["id"]: m for m in p["movable"]}
    check("preexisting P2 is movable", movable.get("e1-pre", {}).get("origin"), "preexisting")
    check("no-origin code-review P2 is movable", ("e1-nor" in movable, movable.get("e1-nor", {}).get("origin")),
          (True, None))
    check("plain and decision tasks are unfinished", sorted(u["id"] for u in p["unfinished"]), ["e1-dec", "e1-task"])
    check("closed children are ignored", "e1-done" in blocking or "e1-done" in movable, False)
    check("backlog matches by file path (open only)", [m["id"] for m in movable["e1-pre"]["backlog_matches"]], ["bl-1"])
    check("no backlog match without a shared file", movable["e1-nor"]["backlog_matches"], [])
    check("files strip line suffixes", movable["e1-pre"]["files"], ["src/parser.ts"])
    check("e1 not closeable", p["closeable"], False)
    check("backlog id", p["backlog"], "bl")
    check("epic parent", p["epic"]["parent"], "root-epic")

    # ---------- branch: epic/<id> ----------
    b = p["branch"]
    check("epic branch resolved", (b["name"], b["source"], b["exists"]), ("epic/e1", "epic branch", True))
    check("ahead/behind main", (b["ahead_of_main"], b["behind_main"]), (2, 1))
    check("files changed", b["files_changed"], 2)
    check("checked out in the integration worktree", os.path.realpath(b["checked_out_at"] or ""),
          os.path.realpath(os.path.join(wt, "run-222-integration")))
    check("main repo state", p["main_repo"], {"current_branch": "main", "dirty": False})

    # ---------- worktrees ----------
    wts = {os.path.basename(w["path"]): w["other_run"] for w in p["worktrees"]}
    check("runner worktrees listed, others not", sorted(wts), ["run-111-slot-1", "run-222-integration", "run-222-slot-1"])
    check("this run's worktrees are not other_run", (wts["run-222-integration"], wts["run-222-slot-1"]), (False, False))
    check("another run's worktree is other_run", wts["run-111-slot-1"], True)

    # ---------- closeable, backlog, no branch ----------
    rc, p, err = plan(repo, tdir, "e2")
    check("finished epic closeable", p["closeable"], True)
    check("no branch: null with a note", (p["branch"], bool(p["branch_note"])), (None, True))

    rc, p, err = plan(repo, tdir, "bl")
    check("backlog epic flagged and never closeable", (p["epic"]["is_backlog"], p["closeable"]), (True, False))
    check("no parent epic: parent is null", p["parent"], None)

    # ---------- planning epics ----------
    rc, p, err = plan(repo, tdir, "top")
    check("planning epic redirects to its one sub-epic with a branch",
          (rc, p["epic"]["id"], p["resolved_from"], p["branch"]["name"]),
          (0, "exec", {"id": "top", "title": "Planning view"}, "epic/exec"))
    check("redirected sub-epic is closeable", p["closeable"], True)
    check("parent closes with the sub-epic", p["parent"], {"id": "top", "title": "Planning view", "other_open": [],
                                                          "close_with_epic": True})
    rc, p, err = plan(repo, tdir, "exec")
    check("naming the sub-epic directly gives the same plan, without a redirect",
          (p["epic"]["id"], p["resolved_from"], p["parent"]["close_with_epic"]), ("exec", None, True))

    rc, p, err = plan(repo, tdir, "top2")
    check("two sub-epics with branches: no redirect, the note names both",
          (p["epic"]["id"], p["resolved_from"], p["branch"], "sub1, sub2" in (p["branch_note"] or "")),
          ("top2", None, None, True))

    rc, p, err = plan(repo, tdir, "top3")
    check("parent with other open work stays open",
          (p["epic"]["id"], p["parent"]["other_open"], p["parent"]["close_with_epic"]),
          ("exec3", ["top3-task"], False))

    # ---------- branch: merged tickets, ambiguity, current branch ----------
    rc, p, err = plan(repo, tdir, "e3")
    check("run branch found through Merge <id>: commits",
          (p["branch"] or {}).get("name"), "run/20260101-000000")
    check("source is merged tickets", (p["branch"] or {}).get("source"), "merged tickets")

    rc, p, err = plan(repo, tdir, "e4")
    check("two matching branches are ambiguous",
          (p["branch"], sorted(p["branch_candidates"])), (None, ["fix/batch-20260103-000000", "run/20260102-000000"]))

    rc, p, err = plan(repo, tdir, "e3", "--branch", "run/20260101-000000")
    check("--branch wins", (p["branch"]["name"], p["branch"]["source"]), ("run/20260101-000000", "argument"))

    sh("git", "checkout", "-q", "run/20260101-000000", cwd=repo)
    rc, p, err = plan(repo, tdir)
    check("no epic id: current run branch names the epic", (rc, p and p["epic"]["id"], p and p["branch"]["source"]),
          (0, "e3", "current branch"))
    check("checked out in the main repo", os.path.realpath((p or {}).get("branch", {}).get("checked_out_at") or ""), repo)
    sh("git", "checkout", "-q", "main", cwd=repo)

    # ---------- errors ----------
    rc, p, err = plan(repo, tdir)
    check("no epic id on main: exit 1 with a reason", (rc, "pass an epic id" in err), (1, True))
    rc, p, err = plan(repo, tdir, "nope")
    check("unknown epic: exit 1", (rc, "no ticket with id nope" in err), (1, True))
    rc, p, err = plan(repo, tdir, "plain")
    check("non-epic id: exit 1", (rc, "not an epic" in err), (1, True))
    outside = os.path.join(tmp, "not-a-repo")
    os.makedirs(outside)
    rc, p, err = plan(repo, tdir, "e1", cwd=outside)
    check("outside a git repo: exit 1", (rc, "not inside a git repository" in err), (1, True))
finally:
    shutil.rmtree(tmp, ignore_errors=True)

print(f"\n{failures} check(s) failed" if failures else "\nall checks passed")
raise SystemExit(1 if failures else 0)
