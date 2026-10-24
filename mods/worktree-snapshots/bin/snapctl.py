#!/usr/bin/env python3
"""List, inspect and restore from the snapshots snapshot.py saves.

Usage:
  snapctl.py list [-n COUNT]
  snapctl.py show <entry>
  snapctl.py diff <entry> [path ...]
  snapctl.py restore <entry> <path ...>

An entry is the checkout as it was just before the command shown next to it. <entry> is
a position in `list` (0 is the newest) or the id `list` prints. Prefer the id once
anything else has run: each Bash command can save a new snapshot, which moves every
position by one.

`show` and `diff` compare the entry with the files on disk now. `restore` writes only
the named paths back, and only files that are gone or differ; it never deletes a file.
It saves the current state as a snapshot first, so a restore can be undone.

Exits 0 on success, 1 with a message on stderr on failure or outside a git checkout.
"""

from __future__ import annotations

import argparse
import os
import subprocess
import sys
import time
from collections import Counter
from dataclasses import dataclass

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import snapshot  # noqa: E402

DEFAULT_COUNT = 15
SHOW_MAX = 200
REASON_SHOWN = 72
ID_LENGTH = 8
MIN_ID = 6
WORDS = {"D": "gone", "M": "changed", "A": "new"}


class Fail(Exception):
    """A failure to report on stderr without a traceback."""


@dataclass
class Entry:
    """One snapshot: a reflog entry on the worktree's snapshot ref."""

    position: int
    commit: str
    tree: str
    when: int
    reason: str

    @property
    def id(self) -> str:
        """The short commit id `list` prints, which stays put as new snapshots arrive."""
        return self.commit[:ID_LENGTH]


def run_git(
    *args: str, cwd: str, stdin: bytes | None = None, literal: bool = False
) -> str:
    """Run git and return its stdout unstripped. Raises CalledProcessError on failure."""
    command = ["git", "--no-pager"]
    if literal:
        command.append("--literal-pathspecs")
    run = subprocess.run(
        [*command, *args], cwd=cwd, input=stdin, capture_output=True, check=True
    )
    return run.stdout.decode("utf-8", "surrogateescape")


def load_entries(top: str, ref: str) -> list[Entry]:
    """Return the snapshots on `ref`, newest first. Empty when nothing was ever saved."""
    try:
        out = run_git("reflog", "show", "--format=%H%x09%T%x09%ct%x09%gs", ref, cwd=top)
    except subprocess.CalledProcessError:
        return []
    entries = []
    for line in filter(None, out.splitlines()):
        parts = line.split("\t", 3)
        parts += [""] * (4 - len(parts))
        commit, tree, when, subject = parts
        reason = subject.removeprefix("before: ")
        entries.append(
            Entry(len(entries), commit, tree, int(when), reason or "(no command)")
        )
    return entries


def pick(entries: list[Entry], token: str) -> Entry:
    """Return the entry a position or an id names."""
    if not entries:
        raise Fail("no snapshots yet for this worktree")
    if token.isdigit() and len(token) <= 3:
        if int(token) >= len(entries):
            raise Fail(f"no entry {token}: there are {len(entries)} (0 to {len(entries) - 1})")
        return entries[int(token)]
    matches = [e for e in entries if e.commit.startswith(token.lower())]
    if len(token) < MIN_ID or not matches:
        raise Fail(f"no entry matches {token!r}; use a position or an id from `list`")
    if len(matches) > 1:
        raise Fail(f"{token!r} matches {len(matches)} entries; give more of the id")
    return matches[0]


def age(when: int) -> str:
    """Return how long ago `when` was, in the largest sensible unit."""
    seconds = max(0, int(time.time()) - when)
    if seconds < 90:
        return f"{seconds}s ago"
    if seconds < 90 * 60:
        return f"{round(seconds / 60)}m ago"
    if seconds < 36 * 3600:
        return f"{round(seconds / 3600)}h ago"
    return f"{round(seconds / 86400)}d ago"


def changes(
    top: str, old: str, new: str, paths: list[str] | None = None
) -> list[tuple[str, str]]:
    """Return (status, path) for what differs between two trees; D means in `old` only."""
    args = ["diff-tree", "-r", "--no-renames", "--name-status", "-z", old, new]
    if paths:
        args += ["--", *paths]
    parts = run_git(*args, cwd=top, literal=True).split("\0")
    return [(parts[i], parts[i + 1]) for i in range(0, len(parts) - 1, 2)]


def current_tree(top: str) -> str:
    """Return the tree of the files on disk now, built the way a snapshot is."""
    gitdir = snapshot.git("rev-parse", "--path-format=absolute", "--git-dir", cwd=top)
    return snapshot.tree_of_files(top, gitdir)


def summary(delta: list[tuple[str, str]]) -> str:
    """Return a count of gone, changed and new files, or that nothing differs."""
    counts = Counter(status for status, _ in delta)
    words = [f"{counts[s]} {WORDS[s]}" for s in WORDS if counts[s]]
    return ", ".join(words) or "same as now"


def repo_paths(top: str, paths: list[str]) -> list[str]:
    """Return `paths` (relative to the current folder) relative to the repository root."""
    rels = []
    for path in paths:
        rel = os.path.relpath(os.path.abspath(path), top)
        if rel == ".." or rel.startswith(".." + os.sep):
            raise Fail(f"{path} is outside the checkout at {top}")
        rels.append(rel)
    return rels


def cmd_list(top: str, ref: str, count: int) -> None:
    """Print the newest `count` snapshots and what each differs from the files now."""
    entries = load_entries(top, ref)
    if not entries:
        print("no snapshots yet for this worktree")
        return
    now = current_tree(top)
    print(f"{'pos':>3}  {'id':<{ID_LENGTH}}  {'when':>8}  {'vs now':<26}  command")
    for entry in entries[:count]:
        reason = entry.reason
        if len(reason) > REASON_SHOWN:
            reason = reason[: REASON_SHOWN - 3] + "..."
        delta = changes(top, entry.tree, now)
        print(
            f"{entry.position:>3}  {entry.id:<{ID_LENGTH}}  {age(entry.when):>8}  "
            f"{summary(delta):<26}  {reason}"
        )
    if len(entries) > count:
        print(f"... {len(entries) - count} older (use -n)")
    print(
        "\nEach entry is the checkout just before its command ran. 'gone' and 'changed'"
        "\nare files that differ from the disk now; restore brings those back. A command"
        "\nwith no entry ran when the files matched HEAD or the entry below it. Entries"
        f"\nexpire after {snapshot.KEEP.replace('.', ' ')}."
    )


def cmd_show(top: str, ref: str, token: str) -> None:
    """Print one snapshot and the files that differ between it and the disk now."""
    entry = pick(load_entries(top, ref), token)
    delta = changes(top, entry.tree, current_tree(top))
    print(f"entry {entry.position} ({entry.id}), {age(entry.when)}: {entry.reason}")
    print(f"{summary(delta)} (the entry is the state before that command ran)")
    order = {s: i for i, s in enumerate(WORDS)}
    shown = sorted(delta, key=lambda item: (order.get(item[0], 9), item[1]))
    for status, path in shown[:SHOW_MAX]:
        print(f"  {WORDS.get(status, status):<8} {path}")
    if len(shown) > SHOW_MAX:
        print(f"  ... and {len(shown) - SHOW_MAX} more")


def cmd_diff(top: str, ref: str, token: str, paths: list[str]) -> None:
    """Print the diff from a snapshot to the disk now, for `paths` or everything."""
    entry = pick(load_entries(top, ref), token)
    rels = [p for p in repo_paths(top, paths) if p != "."]
    print(f"# entry {entry.position} ({entry.id}) -> disk now: '-' is the snapshot, '+' is now")
    sys.stdout.flush()
    args = ["--no-pager", "--literal-pathspecs", "diff", "--no-ext-diff"]
    args += [entry.tree, current_tree(top)]
    if rels:
        args += ["--", *rels]
    subprocess.run(["git", *args], cwd=top, check=True)


def cmd_restore(top: str, ref: str, token: str, paths: list[str]) -> None:
    """Write the named paths back from a snapshot, after saving the current state."""
    entries = load_entries(top, ref)
    entry = pick(entries, token)
    if not paths:
        raise Fail("restore needs the paths to bring back; it never restores everything")
    rels = repo_paths(top, paths)
    if "." in rels:
        raise Fail("restore needs named files or folders, not the whole checkout")
    for rel in rels:
        listed = run_git("ls-tree", "-r", "--name-only", entry.tree, "--", rel, cwd=top)
        if not listed.strip():
            raise Fail(
                f"{rel} is not in entry {entry.position} ({entry.id}). If it matched HEAD "
                "when the snapshot was taken it was left out; use `git restore -- <path>`"
            )
    plan = [(s, p) for s, p in changes(top, entry.tree, current_tree(top), rels) if s in "DM"]
    if not plan:
        print(f"nothing to restore: those paths already match entry {entry.position} ({entry.id})")
        return
    saved = f"snapctl restore {entry.id} {' '.join(rels)}"
    if snapshot.main(["snapshot.py", saved]) != 0:
        raise Fail("could not save the current state first; nothing was restored")
    names = b"\0".join(p.encode("utf-8", "surrogateescape") for _, p in plan)
    run_git(
        "restore",
        f"--source={entry.commit}",
        "--worktree",
        "--pathspec-from-file=-",
        "--pathspec-file-nul",
        cwd=top,
        stdin=names,
        literal=True,
    )
    print(f"restored {len(plan)} file(s) from entry {entry.position} ({entry.id}):")
    for status, path in plan:
        print(f"  {'recreated' if status == 'D' else 'overwrote':<9} {path}")
    if len(load_entries(top, ref)) > len(entries):
        print("the state before this restore is saved as entry 0; restore from it to get back edits this overwrote")
    else:
        print("the state before this restore matched HEAD or the newest entry; edits it overwrote are recoverable from there")


def parser() -> argparse.ArgumentParser:
    """Build the command line parser."""
    root = argparse.ArgumentParser(prog="snapctl.py", description=__doc__.split("\n")[0])
    sub = root.add_subparsers(dest="command", required=True)
    listing = sub.add_parser("list", help="recent snapshots and how each differs from now")
    listing.add_argument("-n", type=int, default=DEFAULT_COUNT, dest="count")
    show = sub.add_parser("show", help="the files that differ between a snapshot and now")
    show.add_argument("entry")
    diff = sub.add_parser("diff", help="the diff from a snapshot to now")
    diff.add_argument("entry")
    diff.add_argument("paths", nargs="*")
    restore = sub.add_parser("restore", help="write named paths back from a snapshot")
    restore.add_argument("entry")
    restore.add_argument("paths", nargs="*")
    return root


def main(argv: list[str]) -> int:
    """Run one command against the checkout at the current folder. Returns the exit code."""
    args = parser().parse_args(argv[1:])
    try:
        top = snapshot.git("rev-parse", "--show-toplevel", cwd=os.getcwd())
    except subprocess.CalledProcessError:
        print("not in a git checkout", file=sys.stderr)
        return 1
    try:
        ref = snapshot.snapshot_ref(top)
        if args.command == "list":
            cmd_list(top, ref, args.count)
        elif args.command == "show":
            cmd_show(top, ref, args.entry)
        elif args.command == "diff":
            cmd_diff(top, ref, args.entry, args.paths)
        else:
            cmd_restore(top, ref, args.entry, args.paths)
    except Fail as error:
        print(error, file=sys.stderr)
        return 1
    except subprocess.CalledProcessError as error:
        detail = (error.stderr or b"").decode("utf-8", "replace").strip().splitlines()
        print(detail[0] if detail else f"git exited {error.returncode}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
