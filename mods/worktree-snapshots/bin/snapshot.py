#!/usr/bin/env python3
"""Save the git checkout at the current folder as a snapshot commit.

Usage: snapshot.py [<reason>]

The commit holds every tracked file as it is on disk and every untracked file that is
not ignored and is at most MAX_UNTRACKED bytes. It is built in a temporary index, so the
checkout's own index (what is staged) is never touched. Its parent is HEAD, so
`git show --stat <snapshot>` lists what differs from the last commit.

Snapshots go on one ref per worktree, refs/snapshots/bash (main worktree) or
refs/snapshots/bash-<name> (a linked one), each one a reflog entry with the reason as
its message. Snapshots are not chained to each other, so once an entry expires (KEEP)
its commit is unreachable and git's gc removes its objects. Nothing is written when the
files match HEAD or the newest snapshot.

Exits 0 when the folder is not in a git checkout. Any git failure exits 1 with git's
message on stderr.
"""

from __future__ import annotations

import os
import re
import shutil
import subprocess
import sys
import tempfile

MAX_UNTRACKED = 1024 * 1024
KEEP = "3.days"
REASON_MAX = 200
IDENTITY = {
    "GIT_AUTHOR_NAME": "worktree-snapshots",
    "GIT_AUTHOR_EMAIL": "worktree-snapshots@localhost",
    "GIT_COMMITTER_NAME": "worktree-snapshots",
    "GIT_COMMITTER_EMAIL": "worktree-snapshots@localhost",
}


def git(
    *args: str,
    cwd: str | None = None,
    env: dict[str, str] | None = None,
    stdin: bytes | None = None,
) -> str:
    """Run git and return its stripped stdout. Raises CalledProcessError on failure."""
    run = subprocess.run(
        ["git", *args], cwd=cwd, env=env, input=stdin, capture_output=True, check=True
    )
    return run.stdout.decode("utf-8", "surrogateescape").strip()


def verify(rev: str, cwd: str) -> str | None:
    """Return the object id `rev` names, or None when it names nothing."""
    try:
        return git("rev-parse", "-q", "--verify", rev, cwd=cwd) or None
    except subprocess.CalledProcessError:
        return None


def snapshot_ref(cwd: str) -> str:
    """Return the snapshot ref for the worktree at `cwd`: one per worktree."""
    gitdir = git("rev-parse", "--path-format=absolute", "--git-dir", cwd=cwd)
    common = git("rev-parse", "--path-format=absolute", "--git-common-dir", cwd=cwd)
    if os.path.realpath(gitdir) == os.path.realpath(common):
        return "refs/snapshots/bash"
    return f"refs/snapshots/bash-{os.path.basename(gitdir)}"


def small_untracked(top: str) -> list[bytes]:
    """Return the untracked, unignored files and links under `top` of at most MAX_UNTRACKED bytes."""
    listed = subprocess.run(
        ["git", "ls-files", "-z", "--others", "--exclude-standard"],
        cwd=top,
        capture_output=True,
        check=True,
    ).stdout
    keep = []
    for path in filter(None, listed.split(b"\0")):
        full = os.path.join(os.fsencode(top), path)
        if os.path.islink(full) or (
            os.path.isfile(full) and os.path.getsize(full) <= MAX_UNTRACKED
        ):
            keep.append(path)
    return keep


def tree_of_files(top: str, gitdir: str) -> str:
    """Write the checkout's files to git as a tree, using a temporary index, and return its id."""
    with tempfile.TemporaryDirectory() as tmp:
        index = os.path.join(tmp, "index")
        if os.path.exists(os.path.join(gitdir, "index")):
            # Starting from the real index reuses its file stat cache, so only changed
            # files are hashed again. copy2 keeps the index's mtime, which git needs to
            # tell a file edited in the same second as the index was written ("racy").
            shutil.copy2(os.path.join(gitdir, "index"), index)
        env = {**os.environ, "GIT_INDEX_FILE": index}
        git("add", "--update", cwd=top, env=env)
        untracked = small_untracked(top)
        if untracked:
            git(
                "add",
                "--pathspec-from-file=-",
                "--pathspec-file-nul",
                cwd=top,
                env=env,
                stdin=b"\0".join(untracked),
            )
        return git("write-tree", cwd=top, env=env)


def main(argv: list[str]) -> int:
    """Snapshot the checkout at the current folder; argv[1] is the reason. Returns the exit code."""
    reason = re.sub(r"\s+", " ", argv[1] if len(argv) > 1 else "").strip()[:REASON_MAX]
    here = os.getcwd()
    try:
        top = git("rev-parse", "--show-toplevel", cwd=here)
    except subprocess.CalledProcessError:
        return 0
    try:
        gitdir = git("rev-parse", "--path-format=absolute", "--git-dir", cwd=top)
        ref = snapshot_ref(top)
        tree = tree_of_files(top, gitdir)
        head = verify("HEAD^{commit}", top)
        if tree in (verify("HEAD^{tree}", top), verify(f"{ref}^{{tree}}", top)):
            return 0
        parent = ["-p", head] if head else []
        message = f"before: {reason}" if reason else "snapshot"
        commit = git(
            "commit-tree",
            tree,
            *parent,
            "-m",
            message,
            cwd=top,
            env={**os.environ, **IDENTITY},
        )
        git("update-ref", "--create-reflog", "-m", message, ref, commit, cwd=top)
    except subprocess.CalledProcessError as error:
        detail = (error.stderr or b"").decode("utf-8", "replace").strip().splitlines()
        print(
            detail[0] if detail else f"git {error.cmd[1]} exited {error.returncode}",
            file=sys.stderr,
        )
        return 1
    # Expiring only after a write keeps read-only commands off the ref's lock. The
    # snapshot is already saved, so a parallel run holding the lock is no failure: the
    # next write expires the entries instead.
    subprocess.run(
        [
            "git",
            "reflog",
            "expire",
            f"--expire={KEEP}",
            f"--expire-unreachable={KEEP}",
            ref,
        ],
        cwd=top,
        capture_output=True,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
