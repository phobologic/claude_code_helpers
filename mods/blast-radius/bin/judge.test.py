"""Checks bin/judge.py against throwaway git repos.

    python3 mods/blast-radius/bin/judge.test.py

Each check builds the effects hooks/parse.ts would send and reads the verdict. The
sandbox stands in for the machine: HOME is a folder in it, and only its tmp/ counts
as a temp folder, so "outside the repository" is somewhere the test owns.
"""

import json
import os
import shutil
import subprocess
import tempfile

JUDGE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "judge.py")
GIT_ENV = {**os.environ, "GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@t", "GIT_COMMITTER_NAME": "t", "GIT_COMMITTER_EMAIL": "t@t"}

failures = 0


def check(name, cond, detail=""):
    global failures
    failures += not cond
    print(f"{'PASS' if cond else 'FAIL'}  {name}" + ("" if cond else f"\n      {detail}"))


def sh(*cmd, cwd):
    subprocess.run(cmd, cwd=cwd, env=GIT_ENV, check=True, capture_output=True)


def write(path, text="x\n"):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as f:
        f.write(text)


def delete(*paths, recursive=True, dir=None):
    return {"op": "delete", "dir": dir, "paths": list(paths), "recursive": recursive, "cmd": "rm"}


def overwrite(*paths, dir=None):
    return {"op": "overwrite", "dir": dir, "paths": list(paths), "cmd": ">"}


def copy(mode, sources, dest, no_clobber=False, dir=None):
    return {"op": "copy", "dir": dir, "mode": mode, "sources": sources, "dest": [dest], "intoDir": False,
            "noTargetDir": False, "noClobber": no_clobber, "cmd": mode}


def find(*argv, dir=None):
    return {"op": "find", "dir": dir, "argv": list(argv), "recursive": False, "cmd": "find"}


def git(*argv, dir=None):
    return {"op": "git", "dir": dir, "argv": list(argv), "cmd": "git"}


class Sandbox:
    def __init__(self):
        self.root = os.path.realpath(tempfile.mkdtemp(prefix="blast-radius-"))
        self.home = os.path.join(self.root, "home")
        self.tmp = os.path.join(self.root, "tmp")
        self.outside = os.path.join(self.root, "outside")
        self.repo = os.path.join(self.root, "repo")
        os.makedirs(self.tmp)
        write(os.path.join(self.home, ".zshrc"))
        write(os.path.join(self.home, ".claude", "projects", "p", "memory", "m.md"))
        write(os.path.join(self.outside, "notes.txt"))
        write(os.path.join(self.outside, "dir", "a.txt"))
        sh("git", "init", "-q", "-b", "main", self.repo, cwd=self.root)
        write(os.path.join(self.repo, ".gitignore"), "build/\n.env\n*.pyc\n.worktrees/\nnode_modules/\n")
        write(os.path.join(self.repo, "README.md"))
        write(os.path.join(self.repo, "src", "a.py"))
        os.symlink("../outside/dir", os.path.join(self.repo, "link"))
        self.commit("init")

    def commit(self, msg):
        sh("git", "add", "-A", cwd=self.repo)
        sh("git", "commit", "-q", "-m", msg, cwd=self.repo)

    def p(self, *parts):
        return os.path.join(self.repo, *parts)

    def judge(self, *effects, cwd=None, root=None, **extra):
        env = {**os.environ, "HOME": self.home, "TMPDIR": self.tmp, "BLAST_RADIUS_TEMP_ROOTS": self.tmp}
        req = {"sessionRoot": root or self.repo, "cwd": cwd or self.repo, "effects": list(effects), **extra}
        r = subprocess.run(["python3", "-I", JUDGE], input=json.dumps(req), capture_output=True, text=True, env=env)
        return json.loads(r.stdout)

    def done(self):
        shutil.rmtree(self.root, ignore_errors=True)


def kinds(v):
    return sorted((f["kind"], f["path"]) for f in v["findings"])


def expect(name, v, want):
    got = kinds(v)
    check(name, got == sorted(want), f"got {got} {v['findings']}")


def main():
    s = Sandbox()
    try:
        deletes(s)
        unmatched_globs(s)
        outside(s)
        overwrites_and_copies(s)
        finds(s)
        git_ops(s)
        worktrees(s)
        other_repos(s)
        subagent_folders(s)
        odd_cases(s)
    finally:
        s.done()
    print(f"\n{failures} failure(s)" if failures else "\nall passed")
    raise SystemExit(1 if failures else 0)


def deletes(s):
    expect("deleting a committed, unchanged file passes", s.judge(delete("README.md")), [])
    write(s.p("src", "new.py"))
    expect("deleting an untracked file holds", s.judge(delete("src/new.py")), [("uncommitted", "src/new.py")])
    expect("deleting a folder holding an untracked file holds", s.judge(delete("src")), [("uncommitted", "src/new.py")])
    os.remove(s.p("src", "new.py"))
    write(s.p("src", "a.py"), "changed\n")
    expect("deleting a modified file holds", s.judge(delete("src/a.py")), [("uncommitted", "src/a.py")])
    sh("git", "checkout", "--", "src/a.py", cwd=s.repo)
    expect("rm without -r leaves a folder alone", s.judge(delete("src", recursive=False)), [])

    write(s.p("build", "out.o"))
    expect("deleting ignored build output passes", s.judge(delete("build")), [])
    write(s.p(".env"), "SECRET=1\n")
    expect("deleting an ignored .env holds", s.judge(delete(".env")), [("uncommitted", ".env")])
    os.remove(s.p(".env"))
    write(s.p("build", ".env"))
    expect("an ignored folder holding a .env holds", s.judge(delete("build")), [("uncommitted", "build/.env")])
    os.remove(s.p("build", ".env"))
    write(s.p("node_modules", "pkg", ".env"))
    expect("a .env inside node_modules doesn't count", s.judge(delete("node_modules")), [])
    os.makedirs(s.p("build", "dep"))
    sh("git", "init", "-q", s.p("build", "dep"), cwd=s.repo)
    expect("a nested repository's history holds", s.judge(delete("build")), [("history", "build/dep")])
    shutil.rmtree(s.p("build", "dep"))

    expect("deleting .git holds", s.judge(delete(".git")), [("git", ".git")])
    write(s.p(".git", "index.lock"))
    expect("deleting a stale .git lock passes", s.judge(delete(".git/index.lock")), [])
    os.remove(s.p(".git", "index.lock"))
    expect("deleting the repository folder holds", s.judge(delete(".")), [("git", s.repo)])
    expect("deleting a folder above it holds", s.judge(delete("..")), [("git", s.root)])
    expect("a glob is expanded like the shell does it", s.judge(delete("*.md")), [])
    expect("a missing path has nothing to lose", s.judge(delete("nope")), [])


def unmatched_globs(s):
    # Route folders like [id] are globs to bash, which passes one that matches nothing
    # on as typed. A quoted part reaches the judge escaped, as parse.ts sends it.
    app = s.p("src", "app")
    page = "src/app/[id]/page.tsx"
    write(os.path.join(app, "[id]", "page.tsx"))
    expect("rm -rf of an unquoted [id] folder holds its untracked work", s.judge(delete("src/app/[id]")), [("uncommitted", page)])
    expect("  as the quoted form does", s.judge(delete("src/app/[[]id]")), [("uncommitted", page)])
    write(os.path.join(app, "[slug]", "[id]", "page.tsx"))
    expect("  a quoted part of the name is read back as typed", s.judge(delete("src/app/[[]slug]/[id]")),
           [("uncommitted", "src/app/[slug]/[id]/page.tsx")])
    expect("  and so is one run from inside a folder named like a glob", s.judge(delete("[id]", dir="src/app/[slug]")),
           [("uncommitted", "src/app/[slug]/[id]/page.tsx")])
    shutil.rmtree(os.path.join(app, "[slug]"))
    write(os.path.join(app, "*?", "[id]", "page.tsx"))
    expect("  and so is a quoted * or ?", s.judge(delete("src/app/[*][?]/[id]")), [("uncommitted", "src/app/*?/[id]/page.tsx")])
    shutil.rmtree(os.path.join(app, "*?"))
    write(os.path.join(app, "a[[]b"))
    expect("  so is a name that only looks escaped", s.judge(delete("src/app/a[[]b")), [("uncommitted", "src/app/a[[]b")])
    os.remove(os.path.join(app, "a[[]b"))
    expect("a glob that matches nothing, with no file of that name, passes", s.judge(delete("src/app/[nope]")), [])
    expect("  and so does its quoted form", s.judge(delete("src/app/[[]nope]")), [])
    expect("  and a * that matches nothing", s.judge(delete("src/*.nothing")), [])
    expect("  and a mv of one inside .git has nothing to move", s.judge(copy("mv", [".git/[nope]"], "x")), [])
    write(os.path.join(s.outside, "[id]", "README.md"))
    expect("mv into a folder named like a glob holds", s.judge(copy("mv", ["README.md"], os.path.join(s.outside, "[id]"))),
           [("outside", os.path.join(s.outside, "[id]", "README.md"))])
    expect("  while a new name like a glob is free", s.judge(copy("cp", ["README.md"], os.path.join(s.outside, "[new]"))), [])
    shutil.rmtree(os.path.join(s.outside, "[id]"))
    write(os.path.join(s.outside, "[id]"))
    expect("ln -sf of a glob that matches nothing replaces the file it names", s.judge(copy("ln", ["[id]"], s.outside)),
           [("outside", os.path.join(s.outside, "[id]"))])
    os.remove(os.path.join(s.outside, "[id]"))
    write(os.path.join(app, "d"))
    sh("git", "add", "src/app/d", cwd=s.repo)
    sh("git", "commit", "-q", "-m", "route", cwd=s.repo)
    expect("a glob that matches a name is not also read as typed", s.judge(delete("src/app/[id]")), [])
    os.remove(os.path.join(app, "d"))
    sh("git", "commit", "-q", "-am", "drop route", cwd=s.repo)
    shutil.rmtree(app)


def outside(s):
    v = s.judge(delete(os.path.join(s.outside, "dir")))
    expect("deleting a folder outside the repository holds", v, [("outside", os.path.join(s.outside, "dir"))])
    check("  and says what is in it", "a folder, 1 file" in v["findings"][0]["detail"], v["findings"])
    expect("the temp folder itself is not free", s.judge(delete(s.tmp)), [("outside", s.tmp)])
    write(os.path.join(s.tmp, "y"))
    expect("files in a temp folder are free", s.judge(delete(os.path.join(s.tmp, "y"))), [])
    expect("Claude's memory files are free", s.judge(delete("~/.claude/projects/p/memory/m.md")), [])
    memory, other = "~/.claude/projects/p/memory", "~/.claude/projects/q/memory"
    expect("a memory folder itself is not free", s.judge(delete(memory)), [("outside", memory)])
    expect("  nor with a trailing slash", s.judge(delete(memory + "/")), [("outside", memory)])
    write(os.path.join(s.home, ".claude", "projects", "q", "memory", "n.md"))
    expect("  nor any memory folder a glob matches", s.judge(delete("~/.claude/projects/*/memory")),
           [("outside", memory), ("outside", other)])
    expect("  while a glob of the files in them is free", s.judge(delete("~/.claude/projects/*/memory/*")), [])
    shutil.rmtree(os.path.join(s.home, ".claude", "projects", "q"))
    transcript = "~/.claude/projects/p/s1/t.jsonl"
    write(os.path.join(s.home, ".claude", "projects", "p", "s1", "t.jsonl"))
    expect("other folders in a project are not memory", s.judge(delete(transcript)), [("outside", transcript)])
    shutil.rmtree(os.path.join(s.home, ".claude", "projects", "p", "s1"))
    expect("~ is the home folder", s.judge(delete("~/.zshrc")), [("outside", "~/.zshrc")])
    expect("$HOME arrives as a placeholder", s.judge(delete("\x01HOME\x01/.zshrc")), [("outside", "~/.zshrc")])
    expect("cd moves where a relative path lands", s.judge(delete("notes.txt", dir=s.outside)), [("outside", os.path.join(s.outside, "notes.txt"))])
    expect("removing a tracked symlink removes only the link", s.judge(delete("link")), [])
    expect("a trailing slash follows the link", s.judge(delete("link/")), [("outside", os.path.join(s.outside, "dir"))])


def overwrites_and_copies(s):
    expect("overwriting a file outside the repository holds", s.judge(overwrite("~/.zshrc")), [("outside", "~/.zshrc")])
    expect("a new file outside the repository is free", s.judge(overwrite("~/new.txt")), [])
    expect("overwriting a file in the repository is free", s.judge(overwrite("README.md")), [])
    expect("overwriting git's own files holds", s.judge(overwrite(".git/config")), [("git", ".git/config")])
    expect("/dev is never a file to lose", s.judge(overwrite("/dev/null")), [])
    expect("mv onto an existing file outside holds", s.judge(copy("mv", ["README.md"], "~/.zshrc")), [("outside", "~/.zshrc")])
    write(os.path.join(s.outside, "README.md"))
    expect("mv into a folder that has the name holds", s.judge(copy("mv", ["README.md"], s.outside)), [("outside", os.path.join(s.outside, "README.md"))])
    expect("mv -n never overwrites", s.judge(copy("mv", ["README.md"], s.outside, no_clobber=True)), [])
    expect("cp to a new name outside is free", s.judge(copy("cp", ["README.md"], os.path.join(s.outside, "new.md"))), [])
    expect("moving .git away holds", s.judge(copy("mv", [".git"], os.path.join(s.tmp, "g"))), [("git", ".git")])


def finds(s):
    write(s.p("src", "a.pyc"))
    expect("find -delete of ignored files passes", s.judge(find(".", "-name", "*.pyc", "-print")), [])
    write(s.p("src", "b.py"))
    expect("find -delete of untracked files holds", s.judge(find(".", "-name", "b.py", "-print")), [("uncommitted", "src/b.py")])
    os.remove(s.p("src", "b.py"))
    v = s.judge(find(".", "-name", "x", "-delete"))
    check("a find that still has an action is never run", v["findings"][0]["kind"] == "unknown", v)


def git_ops(s):
    expect("reset --hard on a clean tree passes", s.judge(git("reset", "--hard")), [])
    write(s.p("src", "a.py"), "changed\n")
    expect("reset --hard over a change holds", s.judge(git("reset", "--hard")), [("uncommitted", "src/a.py")])
    expect("checkout -- file over a change holds", s.judge(git("checkout", "--", "src/a.py")), [("uncommitted", "src/a.py")])
    expect("checkout of a path with no -- holds", s.judge(git("checkout", "src")), [("uncommitted", "src/a.py")])
    expect("checkout -- of another path passes", s.judge(git("checkout", "--", "README.md")), [])
    expect("checkout of a branch passes (git refuses to clobber)", s.judge(git("checkout", "main")), [])
    expect("restore --staged only unstages", s.judge(git("restore", "--staged", "src/a.py")), [])
    expect("restore . holds", s.judge(git("restore", ".", dir="src")), [("uncommitted", "src/a.py")])
    expect("git -C reaches another folder", s.judge(git("-C", s.repo, "reset", "--hard", dir=s.outside)), [("uncommitted", "src/a.py")])
    expect("rm -f of a changed file holds", s.judge(git("rm", "-f", "src/a.py")), [("uncommitted", "src/a.py")])
    sh("git", "stash", "-q", cwd=s.repo)
    v = s.judge(git("stash", "drop"))
    check("stash drop holds", [f["kind"] for f in v["findings"]] == ["history"], v)
    sh("git", "stash", "drop", "-q", cwd=s.repo)
    expect("stash clear with no stashes passes", s.judge(git("stash", "clear")), [])

    write(s.p("src", "new.py"))
    expect("clean -fd over untracked work holds", s.judge(git("clean", "-fd")), [("uncommitted", "src/new.py")])
    os.remove(s.p("src", "new.py"))
    write(s.p("build", "out.o"))
    expect("clean -fdX of ignored build output passes", s.judge(git("clean", "-fdX")), [])
    write(s.p(".env"))
    expect("clean -fdx over an ignored .env holds", s.judge(git("clean", "-fdx")), [("uncommitted", ".env")])
    os.remove(s.p(".env"))
    expect("clean -n is a dry run", s.judge(git("clean", "-n", "-fdx")), [])

    sh("git", "branch", "merged", cwd=s.repo)
    expect("branch -D of a merged branch passes", s.judge(git("branch", "-D", "merged")), [])
    sh("git", "checkout", "-q", "-b", "side", cwd=s.repo)
    write(s.p("side.txt"))
    s.commit("side work")
    sh("git", "checkout", "-q", "main", cwd=s.repo)
    expect("branch -D of unmerged work holds", s.judge(git("branch", "-D", "side")), [("history", "side")])
    expect("branch -d is left to git", s.judge(git("branch", "-d", "side")), [])
    expect("gc --prune=now holds", s.judge(git("gc", "--prune=now")), [("history", "unreachable commits")])
    expect("a git subcommand with nothing to lose passes", s.judge(git("log", "-1")), [])


def worktrees(s):
    slot = s.p(".worktrees", "slot-1")
    sh("git", "worktree", "add", "-q", "-b", "slot-1", slot, cwd=s.repo)
    write(os.path.join(slot, "src", "a.py"), "mutant\n")
    write(os.path.join(slot, "scratch.txt"))
    expect("an agent's worktree: checkout -- over its change passes", s.judge(git("checkout", "--", "src/a.py"), cwd=slot), [])
    expect("an agent's worktree: reset --hard passes", s.judge(git("reset", "--hard", dir=".worktrees/slot-1")), [])
    expect("an agent's worktree: reset --hard from inside it passes", s.judge(git("reset", "--hard"), cwd=slot), [])
    write(os.path.join(slot, ".env"))
    expect("an agent's worktree: clean -fd over its untracked file passes", s.judge(git("clean", "-fd"), cwd=slot), [])
    expect("an agent's worktree: clean -fdx over its ignored .env passes", s.judge(git("clean", "-fdx"), cwd=slot), [])
    os.remove(os.path.join(slot, ".env"))
    shared_state_from_scratch(s, slot)
    expect("an agent's worktree: deleting its untracked file passes", s.judge(delete("scratch.txt"), cwd=slot), [])
    expect("deleting a whole agent worktree passes", s.judge(delete(".worktrees/slot-1")), [])
    expect("deleting the folder of agent worktrees passes", s.judge(delete(".worktrees")), [])
    expect("from an agent's worktree, outside still holds", s.judge(delete("~/.zshrc"), cwd=slot), [("outside", "~/.zshrc")])
    write(s.p("src", "a.py"), "changed in main\n")
    expect("from an agent's worktree, the main checkout still holds",
           s.judge(git("-C", "../..", "checkout", "--", "."), cwd=slot), [("uncommitted", "src/a.py")])
    expect("the worktree a session runs in keeps full protection",
           s.judge(git("checkout", "--", "src/a.py"), cwd=slot, root=slot), [("uncommitted", ".worktrees/slot-1/src/a.py")])
    sh("git", "checkout", "--", "src/a.py", cwd=s.repo)

    away = os.path.join(s.root, "wt-away")
    sh("git", "worktree", "add", "-q", "-b", "away", away, cwd=s.repo)
    write(os.path.join(away, "README.md"), "mine\n")
    expect("a worktree outside the repository folder keeps full protection",
           s.judge(git("checkout", "--", "README.md"), cwd=away), [("uncommitted", os.path.join(away, "README.md"))])
    expect("worktree remove --force over its changes holds", s.judge(git("worktree", "remove", "--force", away)),
           [("uncommitted", os.path.join(away, "README.md"))])
    expect("from an agent's worktree, worktree remove --force of another worktree's changes holds",
           s.judge(git("worktree", "remove", "--force", away), cwd=slot), [("uncommitted", os.path.join(away, "README.md"))])

    copy_repo = os.path.join(s.tmp, "review-scratch")
    sh("git", "clone", "-q", s.repo, copy_repo, cwd=s.root)
    write(os.path.join(copy_repo, "README.md"), "mutant\n")
    expect("a throwaway copy under a temp folder is free", s.judge(git("checkout", "--", "README.md"), cwd=copy_repo), [])
    throwaway_history(s, copy_repo)


# Commands on a repository's history whatever its worktrees hold: each one holds from
# a scratch worktree of the session's repository and passes in a throwaway copy.
HISTORY_WIDE = (("reflog", "expire", "--expire=now", "--all"), ("gc", "--prune=now"), ("prune",),
                ("filter-branch",), ("filter-repo",))


def shared_state_from_scratch(s, slot):
    """Branches, stashes and history are the whole repository's, not the worktree's."""
    expect("from an agent's worktree, branch -D of unmerged work holds",
           s.judge(git("branch", "-D", "side"), cwd=slot), [("history", "side")])
    expect("from an agent's worktree, branch -D of a merged branch passes",
           s.judge(git("branch", "-D", "merged"), cwd=slot), [])
    expect("git -C into an agent's worktree, branch -D of unmerged work holds",
           s.judge(git("-C", ".worktrees/slot-1", "branch", "-D", "side")), [("history", "side")])
    write(s.p("src", "a.py"), "stashed\n")
    sh("git", "stash", "-q", cwd=s.repo)
    for sub in ("clear", "drop"):
        v = s.judge(git("stash", sub), cwd=slot)
        check(f"from an agent's worktree, stash {sub} holds", [f["kind"] for f in v["findings"]] == ["history"], v)
    sh("git", "stash", "drop", "-q", cwd=s.repo)
    for argv in HISTORY_WIDE:
        v = s.judge(git(*argv), cwd=slot)
        check(f"from an agent's worktree, {' '.join(argv)} holds", [f["kind"] for f in v["findings"]] == ["history"], v)


def throwaway_history(s, copy_repo):
    """A throwaway copy's branches and history go with it, but a temp folder alone doesn't make them free."""
    sh("git", "checkout", "-q", "-b", "copy-side", cwd=copy_repo)
    sh("git", "commit", "-q", "-am", "copy work", cwd=copy_repo)
    sh("git", "checkout", "-q", "main", cwd=copy_repo)
    expect("a throwaway copy's unmerged branch is free to delete", s.judge(git("branch", "-D", "copy-side"), cwd=copy_repo), [])
    write(os.path.join(copy_repo, "README.md"), "stashed\n")
    sh("git", "stash", "-q", cwd=copy_repo)
    expect("a throwaway copy's stashes are free to clear", s.judge(git("stash", "clear"), cwd=copy_repo), [])
    for argv in HISTORY_WIDE:
        expect(f"a throwaway copy: {' '.join(argv)} passes", s.judge(git(*argv), cwd=copy_repo), [])
    copy_wt = os.path.join(s.root, "copy-wt")
    sh("git", "worktree", "add", "-q", "-b", "copy-wt", copy_wt, cwd=copy_repo)
    write(os.path.join(copy_wt, "README.md"), "kept outside\n")
    expect("a throwaway copy's worktree kept outside a temp folder still holds its changes on remove --force",
           s.judge(git("worktree", "remove", "--force", copy_wt), cwd=copy_repo), [("uncommitted", os.path.join(copy_wt, "README.md"))])

    other = os.path.join(s.root, "other-repo")
    sh("git", "init", "-q", "-b", "main", other, cwd=s.root)
    write(os.path.join(other, "f.txt"))
    sh("git", "add", "-A", cwd=other)
    sh("git", "commit", "-q", "-m", "init", cwd=other)
    other_wt = os.path.join(s.tmp, "other-wt")
    sh("git", "worktree", "add", "-q", "-b", "work", other_wt, cwd=other)
    write(os.path.join(other_wt, "g.txt"))
    sh("git", "add", "-A", cwd=other_wt)
    sh("git", "commit", "-q", "-m", "work", cwd=other_wt)
    sh("git", "checkout", "-q", "--detach", "main", cwd=other_wt)
    expect("a worktree in a temp folder still holds its repository's unmerged branch",
           s.judge(git("branch", "-D", "work"), cwd=other_wt), [("history", "work")])


def other_repos(s):
    # A repository's config can name commands that git status runs (core.fsmonitor, a
    # clean filter for a changed file). Each trap below appends to `marker` if git runs
    # one, so a check that runs git in that repository shows up.
    marker = os.path.join(s.root, "ran")
    fsmonitor = os.path.join(s.root, "traps", "fsmonitor.sh")
    clean = os.path.join(s.root, "traps", "clean.sh")
    write(fsmonitor, f"#!/bin/sh\necho fsmonitor >> '{marker}'\n")
    write(clean, f"#!/bin/sh\necho clean >> '{marker}'\nexec cat\n")
    os.chmod(fsmonitor, 0o755)
    os.chmod(clean, 0o755)

    def trap(repo):
        """Commits a .txt file run through a clean filter, then sets both traps."""
        write(os.path.join(repo, ".gitattributes"), "*.txt filter=trap\n")
        write(os.path.join(repo, "a.txt"))
        sh("git", "add", "-A", cwd=repo)
        sh("git", "commit", "-q", "-m", "trap", cwd=repo)
        sh("git", "config", "core.fsmonitor", fsmonitor, cwd=repo)
        sh("git", "config", "filter.trap.clean", clean, cwd=repo)

    def touch(path):
        """Same size, new content: git status has to run the clean filter to tell."""
        write(path, "y\n")

    def ran():
        if not os.path.exists(marker):
            return ""
        with open(marker) as f:
            return f.read()

    def judged(*effects, **kw):
        if os.path.exists(marker):
            os.remove(marker)
        return s.judge(*effects, **kw)

    pkg = s.p("build", "pkg")  # say, an archive extracted into the project
    sh("git", "init", "-q", pkg, cwd=s.repo)
    trap(pkg)
    touch(os.path.join(pkg, "a.txt"))
    expect("deleting inside a nested repository holds without running git there", judged(delete("build/pkg/*")),
           [("history", "build/pkg")])
    check("  and its config ran nothing", not ran(), ran())
    shutil.rmtree(pkg)

    other = os.path.join(s.root, "other")
    sh("git", "init", "-q", "-b", "main", other, cwd=s.root)
    write(os.path.join(other, ".env"))
    trap(other)
    wt = s.p("build", "box", "wt")
    sh("git", "worktree", "add", "-q", "-b", "wt", wt, cwd=other)
    touch(os.path.join(wt, "a.txt"))
    # Its .env is reported as git-ignored: the session's git is asked, never the other repository's.
    expect("a folder holding another repository's worktree holds without running git there", judged(delete("build/box")),
           [("history", "build/box/wt"), ("uncommitted", "build/box/wt/.env")])
    check("  and its config ran nothing", not ran(), ran())
    expect("worktree remove of a folder that isn't the session's worktree holds without running git there",
           judged(git("worktree", "remove", "--force", "build/box/wt")), [("history", "build/box/wt")])
    check("  and its config ran nothing", not ran(), ran())
    shutil.rmtree(s.p("build", "box"))
    shutil.rmtree(other)

    write(s.p("src", "new.py"))
    sh("git", "config", "core.fsmonitor", fsmonitor, cwd=s.repo)
    expect("the session's own repository is still checked", judged(delete("src/new.py")), [("uncommitted", "src/new.py")])
    check("  without starting its file monitor", not ran(), ran())
    sh("git", "config", "--unset", "core.fsmonitor", cwd=s.repo)
    os.remove(s.p("src", "new.py"))

    outer = os.path.join(s.root, "wt-outer")
    inner = os.path.join(outer, "box", "inner")
    sh("git", "worktree", "add", "-q", "-b", "outer", outer, cwd=s.repo)
    sh("git", "worktree", "add", "-q", "-b", "inner", inner, cwd=s.repo)
    write(os.path.join(inner, "new.txt"))
    expect("a session worktree nested in another is still checked", s.judge(delete("box"), cwd=outer),
           [("uncommitted", inner), ("uncommitted", os.path.join(inner, "new.txt"))])
    sh("git", "worktree", "remove", "--force", inner, cwd=s.repo)
    sh("git", "worktree", "remove", "--force", outer, cwd=s.repo)

    slot = s.p(".worktrees", "slot-env")
    sh("git", "worktree", "add", "-q", "-b", "slot-env", slot, cwd=s.repo)
    write(os.path.join(slot, ".env"))
    sh("git", "add", "-f", ".env", cwd=slot)
    sh("git", "commit", "-q", "-m", "env", cwd=slot)
    expect("a committed .env in the worktree a session runs in is asked of that worktree",
           s.judge(delete(".env"), cwd=slot, root=slot), [])
    write(s.p(".env"))
    sh("git", "add", "-f", ".env", cwd=s.repo)
    sh("git", "commit", "-q", "-m", "main env", cwd=s.repo)
    expect("a committed .env in another session worktree is asked of that worktree",
           s.judge(delete(s.p(".env")), cwd=slot, root=slot), [])
    sh("git", "rm", "-q", "-f", ".env", cwd=s.repo)
    sh("git", "commit", "-q", "-m", "drop env", cwd=s.repo)
    sh("git", "worktree", "remove", "--force", slot, cwd=s.repo)

    os.makedirs(s.p("build", "plain"))
    expect("worktree remove of a plain folder passes, since git refuses it",
           s.judge(git("worktree", "remove", "build/plain")), [])
    os.rmdir(s.p("build", "plain"))


def subagent_folders(s):
    out_notes = os.path.join(s.outside, "notes.txt")
    v = s.judge(delete("notes.txt"), altCwds=[s.outside])
    expect("a relative path is judged from every folder a subagent could be in", v, [("outside", out_notes)])
    check("  and a finding only another folder has says which folder",
          v["findings"][0]["detail"].endswith(f"(if it runs in {s.outside})"), v["findings"])
    write(s.p("notes.txt"))
    v = s.judge(delete("notes.txt"), altCwds=[s.outside])
    check("  the starting folder's own findings carry no such note",
          [f["detail"] for f in v["findings"] if f["path"] == "notes.txt"] == ["untracked"], v["findings"])
    os.remove(s.p("notes.txt"))
    expect("  and passes when none of them has anything to lose", s.judge(delete("src/a.py"), altCwds=[s.outside]), [])
    expect("  a ~ folder works too", s.judge(delete(".zshrc"), altCwds=["~"]), [("outside", "~/.zshrc")])
    expect("  a folder that no longer exists is skipped", s.judge(delete("README.md"), altCwds=["/no/such"]), [])
    expect("absolute paths don't depend on the folder", s.judge(delete(out_notes), lostCwd="the subagent ran cd -"),
           [("outside", out_notes)])
    v = s.judge(delete("README.md"), lostCwd="the subagent ran cd -")
    check("relative paths after a cd that can't be followed hold",
          [f["kind"] for f in v["findings"]] == ["unknown"] and "cd -" in v["findings"][0]["detail"], v)
    expect("a cd on the same line makes them absolute again",
           s.judge(delete("README.md", dir=s.repo), lostCwd="the subagent ran cd -"), [])


def odd_cases(s):
    v = s.judge(delete("x", dir="no/such/dir"))
    check("a cd into a folder that doesn't exist holds", [f["kind"] for f in v["findings"]] == ["unknown"], v)
    v = s.judge({"op": "unknown", "what": "xargs rm: what it deletes comes from its input", "cmd": "ls | xargs rm"})
    check("an unknown effect holds", v["hold"] and v["findings"][0]["cmd"] == "ls | xargs rm", v)
    plain = os.path.join(s.root, "plain")
    write(os.path.join(plain, "f.txt"))
    expect("outside git, deleting project files holds", s.judge(delete("f.txt"), cwd=plain, root=plain), [("uncommitted", os.path.join(plain, "f.txt"))])


if __name__ == "__main__":
    main()
