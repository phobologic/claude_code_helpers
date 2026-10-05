"""Checks bin/run-tickets-plan's parsing against known inputs: **Files** lines, decision wording,
review notes, and permission rules.

    python3 tests/run-tickets-plan.test.py

Parsed files become in-run locks in the run-tickets workflow, so prose must not
parse as a path. Decision wording only flags candidates for the lead to judge,
but false positives cost the lead's time and false negatives let a decision
through, so both directions are checked. A passing review read from the notes
sends a resumed ticket straight to merge, so anything that should invalidate it
is checked too.
"""

import os
import subprocess
import tempfile
from importlib.machinery import SourceFileLoader
from importlib.util import module_from_spec, spec_from_loader
from pathlib import Path

PLANNER = Path(__file__).resolve().parent.parent / "bin" / "run-tickets-plan"
loader = SourceFileLoader("run_tickets_plan", str(PLANNER))
plan = module_from_spec(spec_from_loader(loader.name, loader))
loader.exec_module(plan)

failures = 0


def check(name, got, want):
    global failures
    ok = got == want
    failures += not ok
    print(f"{'PASS' if ok else 'FAIL'}  {name}" + ("" if ok else f"\n      got  {got!r}\n      want {want!r}"))


FILES = {
    "**Files**: N/A": [],
    "**Files**: TBD.": [],
    "**Files**: see the description, e.g. the parser.": [],
    "**Files**: src/a.ts (new), tests/test_a.py, etc.": ["src/a.ts", "tests/test_a.py"],
    "**Files**: ./src/a.ts, src/components/": ["src/a.ts", "src/components/"],
    "**Files**: src/api/handler.ts:120-140 (`handle`), src/api/routes.ts:12-30": ["src/api/handler.ts", "src/api/routes.ts"],
    "**Files**: README.md, app.css:281-285": ["README.md", "app.css"],
}
for line, want in FILES.items():
    check(f"files: {line}", plan.parse_files(line), want)

DECISIONS = {
    # Wording that asks the owner for a choice.
    "# Decide whether the tooltip suffix still earns its place": True,
    "Suggested Fix: Decide during the next release: either cache it or drop it.": True,
    "# Every rate limit and timeout is untuned": True,
    "Not verified: whether the owner wants retries at all, which is a design call.": True,
    "It is a design-level consequence worth a decision rather than a patch.": True,
    "Worth deciding as a design question rather than patched.": True,
    # Wording that does not.
    "Check or change it only through the owner; do not re-derive it here.": False,
    "`should_retry()` decides whether to back off.": False,
    "Implements decision D1 (owner chose 8).": False,
    "**Files**: src/decision.py": False,
    # Text after the description belongs to notes or other tickets.
    "Fix the crash.\n## Linked\n- [x] Decide whether to keep the suffix": False,
    "Fix the crash.\n## Notes\nDecide whether this matters": False,
}
for text, want in DECISIONS.items():
    check(f"decision: {text[:60]!r}", plan.decision_phrase(text) is not None, want)

# A resumed run sends a ticket straight to merge only when its notes end in a passing review.
SHOW = """---
id: x-1
status: in_progress
---
# Retry failed uploads

Uploads that fail mid-way restart from zero.

## Notes

**2026-01-02T10:00:00Z**

AC VERIFICATION: PASS

1. Retries three times: met. Code: src/upload.ts:10. Test: tests/upload.test.ts:5 asserts calls == 3
2. Progress bar stays visible: met, NEEDS A PERSON: watch an upload on a slow link. Code: src/bar.ts:4. Evidence: none

**2026-01-02T10:05:00Z**

**Review round 1**: {verdict}

**Diff reviewed**: run/x...ticket/x-1 at 1a2b3c4
**Previous findings**: none, first round
{later}
## Linked

- [ ] x-2 Show upload errors
"""
LATER = {
    "": ("1a2b3c4", ["Progress bar stays visible: watch an upload on a slow link"]),
    "\n**2026-01-02T11:00:00Z**\n\n/run-tickets: blocked: not merged: run halted. Work so far is on branch ticket/x-1.\n": (
        "1a2b3c4", ["Progress bar stays visible: watch an upload on a slow link"]),
    "\n**2026-01-02T11:00:00Z**\n\nSeen again reviewing x-9: src/upload.ts:40 still swallows the error\n": (
        "1a2b3c4", ["Progress bar stays visible: watch an upload on a slow link"]),
    "\n**2026-01-02T11:00:00Z**\n\nOwner decision (/run-tickets, 2026-01-03): retry five times\n": None,
    "\n**2026-01-02T11:00:00Z**\n\nACCEPTANCE CRITERIA:\n1. Retries five times\n": None,
    "\n**2026-01-02T11:00:00Z**\n\n**Implementer round 2**: handled the timeout case\n": None,
}
for later, want in LATER.items():
    body = SHOW.replace("{verdict}", "CLEAN").replace("{later}", later)
    check(f"reviewed: a passing review followed by {later.strip()[:50]!r}", plan.passing_review(plan.notes(body)), want)
check("reviewed: FINDINGS passes too",
      plan.passing_review(plan.notes(SHOW.replace("{verdict}", "FINDINGS").replace("{later}", ""))) is not None, True)
check("reviewed: REWORK does not",
      plan.passing_review(plan.notes(SHOW.replace("{verdict}", "REWORK").replace("{later}", ""))), None)
check("reviewed: a review note with no sha does not",
      plan.passing_review(plan.notes(SHOW.replace("{verdict}", "CLEAN").replace("{later}", "").replace(" at 1a2b3c4", ""))), None)
check("reviewed: a free-form reviewed line naming another commit does not",
      plan.passing_review(plan.notes(SHOW.replace("{verdict}", "CLEAN").replace("{later}", "").replace(
          "run/x...ticket/x-1 at 1a2b3c4", "1a2b3c4 (the range is empty: the branch merged at 9f8e7d6)"))), None)
check("reviewed: a NEEDS A PERSON line of its own is a human check too",
      plan.passing_review(plan.notes(SHOW.replace("{verdict}", "CLEAN").replace("{later}", "").replace(
          "Evidence: none\n", "Evidence: none\nNEEDS A PERSON (non-blocking): open the menu on a phone.\n")))[1],
      ["Progress bar stays visible: watch an upload on a slow link", "open the menu on a phone."])
check("reviewed: a NEEDS A PERSON with no colon keeps its own words, not a later field",
      plan.passing_review(plan.notes(SHOW.replace("{verdict}", "CLEAN").replace("{later}", "").replace(
          "Evidence: none\n", "Evidence: none\n3. Errors show: met. NEEDS A PERSON to read the copy. Evidence: none\n")))[1][-1],
      "Errors show: NEEDS A PERSON to read the copy. Evidence: none")
check("reviewed: no notes, no review", plan.passing_review(plan.notes("# Title\n\nBody\n")), None)
check("reviewed: sections tk show adds after the notes are not notes",
      plan.notes(SHOW.replace("{verdict}", "CLEAN").replace("{later}", ""))[-1].endswith("none, first round"), True)

# The review must have seen exactly the branch's current tip.
with tempfile.TemporaryDirectory() as tmp:
    for cmd in (["git", "init", "-q", "-b", "main"], ["git", "config", "user.email", "t@example.com"],
                ["git", "config", "user.name", "Test"], ["git", "config", "commit.gpgsign", "false"],
                ["git", "commit", "-q", "--allow-empty", "-m", "init"], ["git", "branch", "ticket/x-1"]):
        subprocess.run(cmd, cwd=tmp, capture_output=True)
    tip = subprocess.run(["git", "rev-parse", "--short=7", "ticket/x-1"], cwd=tmp, capture_output=True, text=True).stdout.strip()
    cwd = os.getcwd()
    os.chdir(tmp)
    try:
        at_tip = SHOW.replace("{verdict}", "CLEAN").replace("{later}", "").replace("1a2b3c4", tip)
        check("reviewed: the review saw the branch tip", (plan.reviewed("x-1", at_tip) or {}).get("sha"), tip)
        check("reviewed: the branch moved since the review", plan.reviewed("x-1", SHOW.replace("{verdict}", "CLEAN").replace("{later}", "")), None)
        check("reviewed: no ticket branch", plan.reviewed("x-2", at_tip), None)
    finally:
        os.chdir(cwd)

RULES = {
    (): False,
    ("Bash(git merge:*)",): True,
    ("Bash(git:*)",): True,
    ("Bash(git *)",): True,
    ("Bash",): True,
    ("Bash(git merge --abort)",): False,
    ("Bash(git log:*)", "Read(*)"): False,
}
for rules, want in RULES.items():
    check(f"allow rules {list(rules)} cover git merge", plan.allows_git_merge(rules), want)

print(f"\n{failures} check(s) failed" if failures else "\nall checks passed")
raise SystemExit(1 if failures else 0)
