"""Tests for snapctl.py, run against throwaway git repositories.

Run: python3 mods/worktree-snapshots/bin/snapctl.test.py
"""

import os
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
SNAPSHOT = os.path.join(HERE, "snapshot.py")
SNAPCTL = os.path.join(HERE, "snapctl.py")


def git(cwd, *args):
    return subprocess.run(
        ["git", *args], cwd=cwd, capture_output=True, text=True, check=True
    ).stdout.strip()


def write(path, text="x"):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as f:
        f.write(text)


def read(path):
    with open(path) as f:
        return f.read()


def snap(cwd, reason="rm -rf build"):
    subprocess.run([sys.executable, "-I", SNAPSHOT, reason], cwd=cwd, check=True)


def ctl(cwd, *args):
    return subprocess.run(
        [sys.executable, "-I", SNAPCTL, *args], cwd=cwd, capture_output=True, text=True
    )


def short_id(cwd, ref="refs/snapshots/bash", position=0):
    return git(cwd, "rev-parse", f"{ref}@{{{position}}}")[:8]


class SnapctlTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.repo = os.path.join(self.tmp.name, "repo")
        os.makedirs(self.repo)
        git(self.repo, "init", "-q", "-b", "main")
        git(self.repo, "config", "user.name", "t")
        git(self.repo, "config", "user.email", "t@example.com")
        write(os.path.join(self.repo, ".gitignore"), ".env\n")
        write(os.path.join(self.repo, "tracked.txt"), "one")
        git(self.repo, "add", ".")
        git(self.repo, "commit", "-q", "-m", "init")

    def tearDown(self):
        self.tmp.cleanup()

    def path(self, name):
        return os.path.join(self.repo, name)

    def lose_work(self):
        """Snapshot a checkout with edits, then destroy them. Returns the entry's id."""
        write(self.path("tracked.txt"), "two")
        write(self.path("notes/draft.txt"), "keep me")
        snap(self.repo)
        os.remove(self.path("tracked.txt"))
        os.remove(self.path("notes/draft.txt"))
        return short_id(self.repo)

    def test_list_with_no_snapshots_says_so(self):
        run = ctl(self.repo, "list")
        self.assertEqual(run.returncode, 0)
        self.assertIn("no snapshots yet", run.stdout)

    def test_list_shows_the_command_the_id_and_what_is_gone(self):
        entry = self.lose_work()
        run = ctl(self.repo, "list")
        self.assertEqual(run.returncode, 0, run.stderr)
        self.assertIn("rm -rf build", run.stdout)
        self.assertIn(entry, run.stdout)
        self.assertIn("2 gone", run.stdout)

    def test_list_says_same_as_now_when_nothing_differs(self):
        write(self.path("tracked.txt"), "two")
        snap(self.repo)
        self.assertIn("same as now", ctl(self.repo, "list").stdout)

    def test_show_lists_gone_changed_and_new_files(self):
        entry = self.lose_work()
        write(self.path("tracked.txt"), "three")
        write(self.path("fresh.txt"))
        out = ctl(self.repo, "show", entry).stdout
        self.assertRegex(out, r"changed\s+tracked\.txt")
        self.assertRegex(out, r"gone\s+notes/draft\.txt")
        self.assertRegex(out, r"new\s+fresh\.txt")

    def test_diff_shows_the_snapshot_against_the_disk(self):
        self.lose_work()
        write(self.path("tracked.txt"), "three")
        out = ctl(self.repo, "diff", "0", "tracked.txt").stdout
        self.assertIn("-two", out)
        self.assertIn("+three", out)
        self.assertNotIn("draft.txt", out)

    def test_cat_prints_the_file_as_the_entry_held_it_and_changes_nothing(self):
        entry = self.lose_work()
        write(self.path("notes/draft.txt"), "rewritten")
        run = ctl(self.repo, "cat", entry, "notes/draft.txt")
        self.assertEqual(run.returncode, 0, run.stderr)
        self.assertEqual(run.stdout, "keep me")
        self.assertEqual(read(self.path("notes/draft.txt")), "rewritten")
        self.assertFalse(os.path.exists(self.path("tracked.txt")))

    def test_cat_refuses_a_missing_path_a_folder_and_the_whole_checkout(self):
        self.lose_work()
        self.assertIn("missing.txt is not in entry 0", ctl(self.repo, "cat", "0", "missing.txt").stderr)
        self.assertIn("is a folder", ctl(self.repo, "cat", "0", "notes").stderr)
        run = ctl(self.repo, "cat", "0", ".")
        self.assertEqual(run.returncode, 1)
        self.assertIn("cat needs a file", run.stderr)

    def make_history(self):
        """Three snapshots: needle v1, the same plus another file, then needle v2."""
        write(self.path("notes.txt"), "alpha\nneedle v1\n")
        snap(self.repo, "first")
        write(self.path("other.txt"), "something else")
        snap(self.repo, "second")
        write(self.path("notes.txt"), "alpha\nneedle v2\n")
        snap(self.repo, "third")

    def test_grep_lists_each_distinct_match_once_with_the_entries_holding_it(self):
        self.make_history()
        out = ctl(self.repo, "grep", "needle").stdout
        self.assertEqual(out.count("needle v1"), 1, out)
        self.assertRegex(out, r"notes\.txt:2: needle v2\n\s+entries 0 ")
        self.assertRegex(out, r"notes\.txt:2: needle v1\n\s+entries 1-2 ")

    def test_grep_limits_how_many_entries_it_searches(self):
        self.make_history()
        out = ctl(self.repo, "grep", "needle", "-n", "1").stdout
        self.assertIn("needle v2", out)
        self.assertNotIn("needle v1", out)

    def test_grep_says_so_when_nothing_matches(self):
        self.make_history()
        run = ctl(self.repo, "grep", "absent-string")
        self.assertEqual(run.returncode, 0, run.stderr)
        self.assertIn("no matches", run.stdout)

    def test_grep_is_a_regex_unless_fixed_and_case_sensitive_unless_asked(self):
        write(self.path("notes.txt"), "a.c\nabc\nABC\n")
        snap(self.repo)
        regex = ctl(self.repo, "grep", "a.c").stdout
        self.assertIn(":1: a.c", regex)
        self.assertIn(":2: abc", regex)
        fixed = ctl(self.repo, "grep", "-F", "a.c").stdout
        self.assertIn(":1: a.c", fixed)
        self.assertNotIn(":2: abc", fixed)
        self.assertNotIn(":3: ABC", ctl(self.repo, "grep", "abc").stdout)
        self.assertIn(":3: ABC", ctl(self.repo, "grep", "-i", "abc").stdout)

    def test_grep_can_be_limited_to_paths_and_resolves_them_from_a_subfolder(self):
        write(self.path("notes/one.txt"), "needle in notes")
        write(self.path("top.txt"), "needle at top")
        snap(self.repo)
        out = ctl(self.path("notes"), "grep", "needle", "one.txt").stdout
        self.assertIn("notes/one.txt:1: needle in notes", out)
        self.assertNotIn("top.txt", out)

    def test_grep_reads_file_names_with_colons_and_regex_characters(self):
        write(self.path("we:ird [1].txt"), "needle here")
        snap(self.repo)
        out = ctl(self.repo, "grep", "needle").stdout
        self.assertIn("we:ird [1].txt:1: needle here", out)

    def test_restore_brings_back_deleted_tracked_and_untracked_files(self):
        self.lose_work()
        write(self.path("other.txt"), "untouched")
        run = ctl(self.repo, "restore", "0", "tracked.txt", "notes/draft.txt")
        self.assertEqual(run.returncode, 0, run.stderr)
        self.assertEqual(read(self.path("tracked.txt")), "two")
        self.assertEqual(read(self.path("notes/draft.txt")), "keep me")
        self.assertEqual(read(self.path("other.txt")), "untouched")
        self.assertRegex(run.stdout, r"recreated\s+tracked\.txt")

    def test_restore_only_writes_the_named_paths(self):
        write(self.path("a.txt"), "a1")
        write(self.path("b.txt"), "b1")
        snap(self.repo)
        write(self.path("a.txt"), "a2")
        write(self.path("b.txt"), "b2")
        ctl(self.repo, "restore", "0", "a.txt")
        self.assertEqual(read(self.path("a.txt")), "a1")
        self.assertEqual(read(self.path("b.txt")), "b2")

    def test_restore_never_deletes_a_file_added_since(self):
        write(self.path("a.txt"), "a1")
        snap(self.repo)
        write(self.path("added.txt"), "later")
        ctl(self.repo, "restore", "0", "a.txt", "added.txt")
        self.assertEqual(read(self.path("added.txt")), "later")

    def test_restore_leaves_the_index_alone(self):
        self.lose_work()
        write(self.path("staged.txt"), "s")
        git(self.repo, "add", "staged.txt")
        ctl(self.repo, "restore", "0", "tracked.txt")
        self.assertEqual(git(self.repo, "diff", "--cached", "--name-only"), "staged.txt")

    def test_restore_saves_the_current_state_so_overwritten_edits_come_back(self):
        write(self.path("tracked.txt"), "two")
        snap(self.repo)
        write(self.path("tracked.txt"), "three")
        run = ctl(self.repo, "restore", "0", "tracked.txt")
        self.assertEqual(read(self.path("tracked.txt")), "two")
        self.assertIn("saved as entry 0", run.stdout)
        subject = git(self.repo, "reflog", "show", "--format=%gs", "refs/snapshots/bash").splitlines()[0]
        self.assertTrue(subject.startswith("before: snapctl restore"), subject)
        ctl(self.repo, "restore", "0", "tracked.txt")
        self.assertEqual(read(self.path("tracked.txt")), "three")

    def test_restore_of_paths_that_already_match_changes_nothing(self):
        write(self.path("tracked.txt"), "two")
        snap(self.repo)
        before = git(self.repo, "reflog", "show", "refs/snapshots/bash")
        run = ctl(self.repo, "restore", "0", "tracked.txt")
        self.assertEqual(run.returncode, 0)
        self.assertIn("nothing to restore", run.stdout)
        self.assertEqual(git(self.repo, "reflog", "show", "refs/snapshots/bash"), before)

    def test_restore_refuses_without_paths_or_for_the_whole_checkout(self):
        self.lose_work()
        for args in (["restore", "0"], ["restore", "0", "."]):
            run = ctl(self.repo, *args)
            self.assertEqual(run.returncode, 1, args)
            self.assertIn("restore needs", run.stderr)
        self.assertFalse(os.path.exists(self.path("tracked.txt")))

    def test_restore_of_a_path_not_in_the_entry_explains_and_restores_nothing(self):
        self.lose_work()
        run = ctl(self.repo, "restore", "0", "tracked.txt", "missing.txt")
        self.assertEqual(run.returncode, 1)
        self.assertIn("missing.txt is not in entry 0", run.stderr)
        self.assertIn("git restore", run.stderr)
        self.assertFalse(os.path.exists(self.path("tracked.txt")))

    def test_restore_refuses_a_path_outside_the_checkout(self):
        self.lose_work()
        run = ctl(self.repo, "restore", "0", "../elsewhere.txt")
        self.assertEqual(run.returncode, 1)
        self.assertIn("outside the checkout", run.stderr)

    def test_an_id_still_names_its_entry_after_newer_snapshots_move_the_positions(self):
        entry = self.lose_work()
        write(self.path("later.txt"), "l")
        snap(self.repo, "another command")
        self.assertNotEqual(short_id(self.repo), entry)
        run = ctl(self.repo, "restore", entry, "tracked.txt")
        self.assertEqual(run.returncode, 0, run.stderr)
        self.assertEqual(read(self.path("tracked.txt")), "two")

    def test_a_bad_position_or_id_is_an_error_that_names_the_choices(self):
        self.lose_work()
        self.assertIn("there are 1", ctl(self.repo, "show", "5").stderr)
        self.assertIn("no entry matches", ctl(self.repo, "show", "deadbeef").stderr)
        self.assertIn("no entry matches", ctl(self.repo, "show", "abc").stderr)

    def test_paths_resolve_from_a_subfolder(self):
        self.lose_work()
        sub = self.path("notes")
        run = ctl(sub, "restore", "0", "draft.txt")
        self.assertEqual(run.returncode, 0, run.stderr)
        self.assertEqual(read(self.path("notes/draft.txt")), "keep me")

    def test_paths_with_spaces_and_glob_characters_are_taken_literally(self):
        write(self.path("my file [1].txt"), "odd")
        write(self.path("my file 2.txt"), "other")
        snap(self.repo)
        os.remove(self.path("my file [1].txt"))
        os.remove(self.path("my file 2.txt"))
        ctl(self.repo, "restore", "0", "my file [1].txt")
        self.assertEqual(read(self.path("my file [1].txt")), "odd")
        self.assertFalse(os.path.exists(self.path("my file 2.txt")))

    def test_a_linked_worktree_sees_only_its_own_snapshots(self):
        wt = os.path.join(self.tmp.name, "wt")
        git(self.repo, "worktree", "add", "-q", "-b", "side", wt)
        write(os.path.join(wt, "side.txt"), "s")
        snap(wt, "side command")
        self.assertIn("side command", ctl(wt, "list").stdout)
        self.assertIn("no snapshots yet", ctl(self.repo, "list").stdout)
        os.remove(os.path.join(wt, "side.txt"))
        run = ctl(wt, "restore", "0", "side.txt")
        self.assertEqual(run.returncode, 0, run.stderr)
        self.assertEqual(read(os.path.join(wt, "side.txt")), "s")

    def test_outside_a_git_checkout_it_says_so_and_fails(self):
        run = ctl(self.tmp.name, "list")
        self.assertEqual(run.returncode, 1)
        self.assertIn("not in a git checkout", run.stderr)


if __name__ == "__main__":
    unittest.main()
