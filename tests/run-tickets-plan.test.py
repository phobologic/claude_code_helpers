"""Checks bin/run-tickets-plan's **Files** parsing and its decision-wording hint against known inputs.

    python3 tests/run-tickets-plan.test.py

Parsed files become in-run locks in the run-tickets workflow, so prose must not
parse as a path. Decision wording only flags candidates for the lead to judge,
but false positives cost the lead's time and false negatives let a decision
through, so both directions are checked.
"""

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

print(f"\n{failures} check(s) failed" if failures else "\nall checks passed")
raise SystemExit(1 if failures else 0)
