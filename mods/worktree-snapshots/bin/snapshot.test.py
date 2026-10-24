"""Tests for snapshot.py, run against throwaway git repositories.

Run: python3 mods/worktree-snapshots/bin/snapshot.test.py
"""

import os
import subprocess
import sys
import tempfile
import unittest

SCRIPT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "snapshot.py")
REF = "refs/snapshots/bash"


def git(cwd, *args):
    return subprocess.run(
        ["git", *args], cwd=cwd, capture_output=True, text=True, check=True
    ).stdout.strip()


def write(path, text="x"):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as f:
        f.write(text)


def snap(cwd, reason="rm -rf build"):
    return subprocess.run(
        [sys.executable, "-I", SCRIPT, reason], cwd=cwd, capture_output=True, text=True
    )


def entries(cwd, ref=REF):
    try:
        return git(cwd, "reflog", "show", "--format=%gs", ref).splitlines()
    except subprocess.CalledProcessError:
        return []


def files(cwd, rev=REF):
    return sorted(git(cwd, "ls-tree", "-r", "--name-only", rev).splitlines())


class SnapshotTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.repo = os.path.join(self.tmp.name, "repo")
        os.makedirs(self.repo)
        git(self.repo, "init", "-q", "-b", "main")
        git(self.repo, "config", "user.name", "t")
        git(self.repo, "config", "user.email", "t@example.com")
        write(os.path.join(self.repo, ".gitignore"), ".env\nbuild/\n")
        write(os.path.join(self.repo, "tracked.txt"), "one")
        git(self.repo, "add", ".")
        git(self.repo, "commit", "-q", "-m", "init")

    def tearDown(self):
        self.tmp.cleanup()

    def test_saves_modified_and_untracked_files_but_not_ignored_ones(self):
        write(os.path.join(self.repo, "tracked.txt"), "two")
        write(os.path.join(self.repo, "src/new.ts"), "new")
        write(os.path.join(self.repo, ".env"), "SECRET=1")
        write(os.path.join(self.repo, "build/out.js"), "built")
        self.assertEqual(snap(self.repo).returncode, 0)
        self.assertEqual(files(self.repo), [".gitignore", "src/new.ts", "tracked.txt"])
        self.assertEqual(git(self.repo, "show", f"{REF}:tracked.txt"), "two")
        self.assertEqual(entries(self.repo), ["before: rm -rf build"])

    def test_leaves_the_real_index_alone(self):
        write(os.path.join(self.repo, "staged.txt"), "s")
        git(self.repo, "add", "staged.txt")
        write(os.path.join(self.repo, "loose.txt"), "l")
        snap(self.repo)
        self.assertEqual(
            git(self.repo, "diff", "--cached", "--name-only"), "staged.txt"
        )
        self.assertIn("?? loose.txt", git(self.repo, "status", "--porcelain"))

    def test_a_deleted_tracked_file_is_left_out(self):
        os.remove(os.path.join(self.repo, "tracked.txt"))
        write(os.path.join(self.repo, "other.txt"))
        snap(self.repo)
        self.assertEqual(files(self.repo), [".gitignore", "other.txt"])

    def test_untracked_files_over_1_mb_are_skipped(self):
        with open(os.path.join(self.repo, "big.bin"), "wb") as f:
            f.truncate(1024 * 1024 + 1)
        with open(os.path.join(self.repo, "edge.bin"), "wb") as f:
            f.truncate(1024 * 1024)
        write(os.path.join(self.repo, "small.txt"))
        snap(self.repo)
        self.assertEqual(
            files(self.repo), [".gitignore", "edge.bin", "small.txt", "tracked.txt"]
        )

    def test_nothing_is_written_when_files_match_head(self):
        self.assertEqual(snap(self.repo).returncode, 0)
        self.assertEqual(entries(self.repo), [])

    def test_nothing_is_written_when_files_match_the_newest_snapshot(self):
        write(os.path.join(self.repo, "new.txt"))
        snap(self.repo, "first")
        snap(self.repo, "second")
        self.assertEqual(entries(self.repo), ["before: first"])
        write(os.path.join(self.repo, "new.txt"), "changed")
        snap(self.repo, "third")
        self.assertEqual(entries(self.repo), ["before: third", "before: first"])

    def test_snapshots_are_not_chained_so_old_ones_can_expire(self):
        write(os.path.join(self.repo, "a.txt"))
        snap(self.repo, "first")
        write(os.path.join(self.repo, "a.txt"), "again")
        snap(self.repo, "second")
        head = git(self.repo, "rev-parse", "HEAD")
        self.assertEqual(git(self.repo, "rev-parse", f"{REF}^"), head)
        self.assertEqual(git(self.repo, "rev-parse", f"{REF}@{{1}}^"), head)

    def test_old_entries_are_expired(self):
        write(os.path.join(self.repo, "a.txt"))
        old = {**os.environ, "GIT_COMMITTER_DATE": "2000-01-01T00:00:00"}
        subprocess.run(
            [sys.executable, "-I", SCRIPT, "old"], cwd=self.repo, env=old, check=True
        )
        write(os.path.join(self.repo, "a.txt"), "new")
        snap(self.repo, "new")
        self.assertEqual(entries(self.repo), ["before: new"])

    def test_gc_removes_expired_snapshots_but_the_newest_expired_one(self):
        # A reflog entry names the ref's old value too, and gc keeps both, so the newest
        # expired snapshot stays reachable until the next one expires. Older ones go.
        old = {**os.environ, "GIT_COMMITTER_DATE": "2000-01-01T00:00:00"}
        blobs = []
        for text in ("first-old", "second-old"):
            write(os.path.join(self.repo, "a.txt"), text)
            subprocess.run(
                [sys.executable, "-I", SCRIPT, text], cwd=self.repo, env=old, check=True
            )
            blobs.append(git(self.repo, "rev-parse", f"{REF}:a.txt"))
        write(os.path.join(self.repo, "a.txt"), "new")
        snap(self.repo, "new")
        git(self.repo, "gc", "-q", "--prune=now")
        present = [
            subprocess.run(["git", "cat-file", "-e", b], cwd=self.repo).returncode == 0
            for b in blobs
        ]
        self.assertEqual(present, [False, True])

    def test_parallel_runs_all_succeed(self):
        write(os.path.join(self.repo, "a.txt"), "work")
        runs = [
            subprocess.Popen(
                [sys.executable, "-I", SCRIPT, f"run {i}"],
                cwd=self.repo,
                stderr=subprocess.PIPE,
            )
            for i in range(4)
        ]
        results = [(run.wait(), run.stderr.read().decode()) for run in runs]
        self.assertEqual(results, [(0, "")] * 4)
        self.assertEqual(files(self.repo), [".gitignore", "a.txt", "tracked.txt"])

    def test_a_file_can_be_restored_from_a_snapshot(self):
        write(os.path.join(self.repo, "work.txt"), "precious")
        snap(self.repo)
        os.remove(os.path.join(self.repo, "work.txt"))
        git(self.repo, "restore", f"--source={REF}", "--", "work.txt")
        with open(os.path.join(self.repo, "work.txt")) as f:
            self.assertEqual(f.read(), "precious")

    def test_runs_from_a_subfolder_and_saves_the_whole_checkout(self):
        write(os.path.join(self.repo, "top.txt"))
        os.makedirs(os.path.join(self.repo, "sub"))
        snap(os.path.join(self.repo, "sub"))
        self.assertIn("top.txt", files(self.repo))

    def test_a_linked_worktree_gets_its_own_ref(self):
        wt = os.path.join(self.tmp.name, "feature")
        git(self.repo, "worktree", "add", "-q", wt)
        write(os.path.join(wt, "wt.txt"))
        snap(wt)
        self.assertEqual(entries(self.repo), [])
        self.assertIn("wt.txt", files(self.repo, "refs/snapshots/bash-feature"))

    def test_a_repo_with_no_commits_is_saved_without_a_parent(self):
        fresh = os.path.join(self.tmp.name, "fresh")
        os.makedirs(fresh)
        git(fresh, "init", "-q")
        write(os.path.join(fresh, "a.txt"))
        self.assertEqual(snap(fresh).returncode, 0)
        self.assertEqual(files(fresh), ["a.txt"])

    def test_works_without_a_git_identity(self):
        git(self.repo, "config", "--unset", "user.name")
        git(self.repo, "config", "--unset", "user.email")
        write(os.path.join(self.repo, "a.txt"))
        env = {**os.environ, "HOME": self.tmp.name, "GIT_CONFIG_NOSYSTEM": "1"}
        run = subprocess.run(
            [sys.executable, "-I", SCRIPT, "x"],
            cwd=self.repo,
            env=env,
            capture_output=True,
            text=True,
        )
        self.assertEqual(run.returncode, 0, run.stderr)

    def test_newlines_in_the_reason_become_spaces(self):
        write(os.path.join(self.repo, "a.txt"))
        snap(self.repo, "rm a\n  && rm b")
        self.assertEqual(entries(self.repo), ["before: rm a && rm b"])

    def test_outside_a_checkout_does_nothing(self):
        outside = os.path.join(self.tmp.name, "plain")
        os.makedirs(outside)
        run = snap(outside)
        self.assertEqual((run.returncode, run.stderr), (0, ""))

    def test_a_git_failure_exits_1_with_the_reason(self):
        git(self.repo, "update-ref", REF, git(self.repo, "rev-parse", "HEAD"))
        lock = os.path.join(self.repo, ".git", REF + ".lock")
        write(lock, "")
        write(os.path.join(self.repo, "a.txt"))
        run = snap(self.repo)
        self.assertEqual(run.returncode, 1)
        self.assertIn("lock", run.stderr)


if __name__ == "__main__":
    unittest.main()
