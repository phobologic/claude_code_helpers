"""Checks bin/judge.py against throwaway git repos.

    python3 mods/blast-radius/bin/judge.test.py

Each check builds the effects hooks/parse.ts would send and reads the verdict. The
sandbox stands in for the machine: HOME is a folder in it, and only its tmp/ counts
as a temp folder, so "outside the repository" is somewhere the test owns.
"""

import importlib.util
import json
import os
import shutil
import subprocess
import tempfile
import threading
from types import SimpleNamespace
from unittest import mock

JUDGE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "judge.py")
_spec = importlib.util.spec_from_file_location("judge", JUDGE)
judge_module = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(judge_module)
GIT_ENV = {**os.environ, "GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@t", "GIT_COMMITTER_NAME": "t", "GIT_COMMITTER_EMAIL": "t@t"}
REAL_GIT = shutil.which("git")
TIMEOUT = 60

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

    def judge(self, *effects, cwd=None, root=None, git_log=None, **extra):
        """The verdict; with `git_log`, each git command the judge runs is logged there."""
        env = {**os.environ, "HOME": self.home, "TMPDIR": self.tmp, "BLAST_RADIUS_TEMP_ROOTS": self.tmp}
        if git_log:
            env["PATH"] = self.git_shim(git_log) + os.pathsep + env["PATH"]
        req = {"sessionRoot": root or self.repo, "cwd": cwd or self.repo, "effects": list(effects), **extra}
        try:
            r = subprocess.run(["python3", "-I", JUDGE], input=json.dumps(req), capture_output=True, text=True, env=env, timeout=TIMEOUT)
        except subprocess.TimeoutExpired:
            return {"hold": None, "findings": [{"kind": "timeout", "path": "", "detail": f"judge.py ran over {TIMEOUT}s"}], "notes": []}
        return json.loads(r.stdout)

    def git_shim(self, log):
        shim = os.path.join(self.root, "shim")
        os.makedirs(shim, exist_ok=True)
        with open(os.path.join(shim, "git"), "w") as f:
            f.write(f'#!/bin/sh\necho "$*" >> "{log}"\nexec "{REAL_GIT}" "$@"\n')
        os.chmod(os.path.join(shim, "git"), 0o755)
        open(log, "w").close()
        return shim

    def done(self):
        shutil.rmtree(self.root, ignore_errors=True)


def kinds(v):
    return sorted((f["kind"], f["path"]) for f in v["findings"])


def expect(name, v, want):
    got = kinds(v)
    check(name, got == sorted(want), f"got {got} {v['findings']}")


def git_calls(log, sub):
    """How many logged git commands ran the subcommand `sub`."""
    with open(log) as f:
        return sum(sub in line.split() for line in f)


def load_judge():
    """judge.py as a module, for the checks that need to stand in for the file system."""
    spec = importlib.util.spec_from_file_location("blast_radius_judge", JUDGE)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def main():
    s = Sandbox()
    try:
        deletes(s)
        unmatched_globs(s)
        outside(s)
        overwrites_and_copies(s)
        finds(s)
        many_paths(s)
        owners(s)
        tracked_files(s)
        git_ops(s)
        branch_moves(s)
        short_options(s)
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
    expect("an untracked file elsewhere doesn't hold a delete", s.judge(delete("README.md")), [])
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
    for sink in ("/dev/null", "/dev/stdout", "/dev/stderr", "/dev/tty", "/dev/fd/1", "/dev/fd/3"):
        expect(f"writing to {sink} loses nothing", s.judge(overwrite(sink)), [])
    expect("cp to /dev/stdout loses nothing", s.judge(copy("cp", ["README.md"], "/dev/stdout")), [])
    v = s.judge(overwrite("/dev/zero"))
    expect("writing to any other device holds, as outside the repository", v, [("outside", "/dev/zero")])
    check("  and says it is a device", any("(a device)" in f["detail"] for f in v["findings"]), v["findings"])
    if os.path.exists("/dev/disk2"):  # the disk from the bug report, where this machine has one
        v = s.judge(overwrite("/dev/disk2"))
        expect("dd of=/dev/disk2 holds", v, [("outside", "/dev/disk2")])
        check("  and says it is a device", any("(a device)" in f["detail"] for f in v["findings"]), v["findings"])
        expect("cp onto /dev/disk2 holds", s.judge(copy("cp", ["README.md"], "/dev/disk2")), [("outside", "/dev/disk2")])
    # Checked on the pattern itself: a real lstat through macOS's /dev/fd/.. fails now and then under load.
    check("only a number after /dev/fd/ is a stream",
          judge_module.SINK.fullmatch("/dev/fd/../zero") is None and judge_module.SINK.fullmatch("/dev/fd/12") is not None)
    for spelling in ("/dev//null", "/dev/./null", os.path.relpath("/dev/null", s.repo)):
        expect(f"another spelling of /dev/null loses nothing ({spelling})", s.judge(overwrite(spelling)), [])
    # On Linux /dev/stdout resolves through /proc/self/fd/1 to whatever stdout is, perhaps a file
    # outside; the path as written still marks it as the command's own stream.
    class OutsideCtx:
        def where(self, rp):
            return "outside"

        def show(self, rp):
            return rp

    with mock.patch.object(judge_module.os.path, "realpath", return_value=os.path.join(s.outside, "notes.txt")):
        got = judge_module.judge_overwrite(OutsideCtx(), "/dev/stdout")
    check("/dev/stdout is free wherever it resolves", got == [], got)
    # A terminal such as /dev/ttyp0 or /dev/ttyS0, where the machine has one: only /dev/tty itself is free.
    near = next((n for n in sorted(os.listdir("/dev")) if n.startswith("tty") and n[3:].isalnum()), None)
    if near:
        expect(f"/dev/{near} is not /dev/tty", s.judge(overwrite(f"/dev/{near}")), [("outside", f"/dev/{near}")])
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


def many_paths(s):
    log = os.path.join(s.root, "git.log")
    for i in range(40):
        write(s.p("src", f"p{i}", "__pycache__", "m.pyc"))
        write(s.p("src", f"p{i}", ".env"))
    expect("a find listing 40 ignored files in 40 folders passes", s.judge(find("src", "-name", "*.pyc", "-print"), git_log=log), [])
    n = git_calls(log, "rev-parse")
    check("  asking git for the repository once per repository, not once per path", n < 5, f"{n} rev-parse calls")
    v = s.judge(find("src", "-name", ".env", "-print"), git_log=log)
    expect("a find listing 40 ignored .env files holds each one", v, [("uncommitted", f"src/p{i}/.env") for i in range(40)])
    n = git_calls(log, "ls-files")
    check("  with one ls-files for the repository, not one per file", n == 1, f"{n} ls-files calls")
    for i in range(40):
        shutil.rmtree(s.p("src", f"p{i}"))

    j = load_judge()
    ctx = SimpleNamespace(owners={}, scratch=[], notes=[], show=lambda p: p)
    levels = [s.p("build"), s.p("build", "a"), s.p("build", "a", "b"), s.p("build", "a", "b", "c")]
    write(os.path.join(levels[-1], "f.txt"))
    write(s.p("build", "a", ".env"))
    walked = []
    real_walk, limit = j.walk, j.WALK_LIMIT
    j.walk = lambda ctx, top, protected, nested: walked.append(top) or real_walk(ctx, top, protected, nested)
    try:
        protected, _ = j.search(ctx, s.repo, [(p, True) for p in reversed(levels)])
        check("a delete of every level of a folder walks the folder once", walked == levels[:1], walked)
        check("  and still finds what is deeper in it", protected == [s.p("build", "a", ".env")], protected)
        walked.clear()
        j.WALK_LIMIT = 0
        j.search(ctx, s.repo, [(p, True) for p in levels])
        check("a folder too large to search fully doesn't stand in for the folders inside it", walked == levels, walked)
    finally:
        j.walk, j.WALK_LIMIT = real_walk, limit
    shutil.rmtree(s.p("build", "a"))
    check("covered: a path inside a root", j.covered("/a/b/c", {"/a/b"}))
    check("covered: a root itself", j.covered("/a/b", {"/a/b"}))
    check("covered: a name sharing a root's prefix is not inside it", not j.covered("/a/bc", {"/a/b"}))
    check("covered: a root's parent is not inside it", not j.covered("/a", {"/a/b"}))


def owners(s):
    """The repository a deleted path is judged by is the one git finds from its folder."""
    os.makedirs(s.p("build", "dep"))
    sh("git", "init", "-q", s.p("build", "dep"), cwd=s.repo)
    write(s.p("build", "dep", "new.txt"))
    v = s.judge(delete("build/dep/new.txt"))
    check("a file in a nested repository is judged by it, not by the ignored folder around it",
          v["hold"] and all(f["path"].startswith("build/dep") for f in v["findings"]), v)
    shutil.rmtree(s.p("build", "dep"))
    sh("git", "init", "-q", "--bare", s.p("build", "backup.git"), cwd=s.repo)
    expect("a file in a bare repository holds, though the folder around it is ignored",
           s.judge(delete("build/backup.git/HEAD")), [("uncommitted", "build/backup.git/HEAD")])
    write(s.p("build", "backup.git", ".env"))
    expect("  and so does a .env in it when the folder around it is deleted",
           s.judge(delete("build")), [("uncommitted", "build/backup.git/.env")])
    shutil.rmtree(s.p("build", "backup.git"))
    os.makedirs(s.p("src", "fake", ".git"))
    write(s.p("src", "fake", "x.txt"))
    expect("an empty .git folder is no repository, as git sees it", s.judge(delete("src/fake/x.txt")), [("uncommitted", "src/fake/x.txt")])
    shutil.rmtree(s.p("src", "fake"))

    j = load_judge()
    mount = s.p("build", "mnt")
    os.makedirs(os.path.join(mount, "x"))
    real_stat, real_toplevel = os.stat, j.toplevel

    def stat(p, *a, **kw):  # the mount and what is in it are on another file system
        st = real_stat(p, *a, **kw)
        return os.stat_result((*st[:2], st.st_dev + 1, *st[3:])) if isinstance(p, str) and j.under(p, mount) else st

    os.stat = stat
    j.toplevel = lambda path: None if path == mount else real_toplevel(path)  # git stops at the mount
    try:
        got = j.owner_of(SimpleNamespace(owners={}), os.path.join(mount, "x"))
    finally:
        os.stat, j.toplevel = real_stat, real_toplevel
    check("a folder on another file system gets git's own answer there, not its parent's", got is None, got)
    shutil.rmtree(mount)
    ctx = SimpleNamespace(owners={})
    os.makedirs(s.p("src", "deep"))
    first = j.owner_of(ctx, s.p("src", "deep"))
    os.rmdir(s.p("src", "deep"))
    looks, real_lstat = [], os.lstat
    os.stat = lambda p, *a, **kw: looks.append(p) or real_stat(p, *a, **kw)
    os.lstat = lambda p, *a, **kw: looks.append(p) or real_lstat(p, *a, **kw)
    try:
        again = j.owner_of(ctx, s.p("src"))
    finally:
        os.stat, os.lstat = real_stat, real_lstat
    check("a folder passed on the way up is answered later without looking at the disk",
          first == again == s.repo and not looks, (first, again, looks))
    out = []
    t = threading.Thread(target=lambda: out.append(j.owner_of(SimpleNamespace(owners={}), "/")), daemon=True)
    t.start()
    t.join(TIMEOUT)
    check("looking for the repository stops at /", out == [None], out)


def tracked_files(s):
    write(s.p("src", ".env"))
    sh("git", "add", "-f", "src/.env", cwd=s.repo)
    s.commit("a tracked .env")
    write(s.p("src", "sub", ".env"))
    write(s.p("src", "local.db"))
    v = s.judge(delete("src/.env", "src/sub/.env", "src/local.db"))
    expect("a committed .env passes, while an ignored one holds", v, [("uncommitted", "src/sub/.env"), ("uncommitted", "src/local.db")])
    check("  and an untracked .db says it is untracked, not ignored",
          [f["detail"] for f in v["findings"] if f["path"] == "src/local.db"] == ["untracked"], v["findings"])
    shutil.rmtree(s.p("src", "sub"))
    os.remove(s.p("src", "local.db"))
    sh("git", "rm", "-q", "src/.env", cwd=s.repo)
    s.commit("drop the tracked .env")


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


def branch_moves(s):
    # From git_ops: on main, `side` has a commit no other branch has, `merged` sits on main.
    lost = [("history", "side")]
    say = " ".join
    for argv in (["branch", "-f", "side", "main"], ["branch", "--force", "side", "main"], ["branch", "-qf", "side", "main"],
                 ["branch", "-f", "side"],
                 ["checkout", "-B", "side", "main"], ["checkout", "-qB", "side", "main"], ["checkout", "-Bside", "main"],
                 ["switch", "-C", "side", "main"], ["switch", "-qCside", "main"], ["switch", "--force-create", "side", "main"],
                 ["switch", "--force-create=side", "main"]):
        expect(f"{say(argv)} over unmerged work holds", s.judge(git(*argv)), lost)
    v = s.judge(git("branch", "-f", "side", "main"))
    check("  and says what would be lost", "1 commit on no other branch, newest:" in v["findings"][0]["detail"], v["findings"])
    for argv in (["branch", "-f", "fresh", "main"], ["checkout", "-B", "fresh"], ["switch", "-C", "fresh", "main"]):
        expect(f"{say(argv)} of a new branch passes", s.judge(git(*argv)), [])
    for argv in (["branch", "-f", "merged", "side"], ["checkout", "-B", "merged", "side"], ["switch", "-C", "merged", "side"]):
        expect(f"{say(argv)} of a branch another one holds passes", s.judge(git(*argv)), [])
    for argv in (["branch", "-f", "side", "side"], ["checkout", "-B", "side", "side"], ["switch", "-C", "side", "side"],
                 ["branch", "-M", "side", "side"], ["branch", "-C", "side", "side"]):
        expect(f"{say(argv)} leaves the branch where it is, so passes", s.judge(git(*argv)), [])

    for argv in (["branch", "-M", "merged", "side"], ["branch", "-m", "-f", "merged", "side"], ["branch", "--move", "--force", "merged", "side"],
                 ["branch", "-C", "merged", "side"], ["branch", "-c", "-f", "merged", "side"], ["branch", "--copy", "--force", "merged", "side"]):
        expect(f"{say(argv)} over unmerged work holds", s.judge(git(*argv)), lost)
    expect("branch -M of the current branch over unmerged work holds", s.judge(git("branch", "-M", "side")), lost)
    expect("branch -M onto a branch another one holds passes", s.judge(git("branch", "-M", "side", "merged")), [])
    expect("branch -m is left to git", s.judge(git("branch", "-m", "merged", "side")), [])
    for argv in (["branch", "-D", "merged", "side"], ["branch", "-df", "merged", "side"], ["branch", "--delete", "--force", "merged", "side"]):
        expect(f"{say(argv)} judges every branch it deletes", s.judge(git(*argv)), lost)
    expect("branch -f -u only sets the upstream", s.judge(git("branch", "-f", "-u", "main", "side")), [])
    expect("branch -f side -u main only sets the upstream", s.judge(git("branch", "-f", "side", "-u", "main")), [])
    expect("branch -fl only lists", s.judge(git("branch", "-fl", "side")), [])
    expect("branch -f --list only lists", s.judge(git("branch", "-f", "--list", "side")), [])
    expect("branch -f --set-upstream-to= only sets the upstream", s.judge(git("branch", "-f", "--set-upstream-to=main", "side")), [])
    expect("branch -fudev reads dev as -u's value", s.judge(git("branch", "-fudev", "side")), [])
    expect("branch -f with no name only lists", s.judge(git("branch", "-f")), [])
    sh("git", "update-ref", "refs/remotes/side", "main", cwd=s.repo)
    expect("branch -r -D drops a remote-tracking branch, not the local one", s.judge(git("branch", "-r", "-D", "side")), [])
    sh("git", "update-ref", "-d", "refs/remotes/side", cwd=s.repo)

    sh("git", "checkout", "-q", "side", cwd=s.repo)
    expect("checkout -B of the current branch onto another holds", s.judge(git("checkout", "-B", "side", "main")), lost)
    expect("checkout -B of the current branch where it is passes", s.judge(git("checkout", "-B", "side")), [])
    sh("git", "checkout", "-q", "--detach", "side", cwd=s.repo)
    expect("branch -f passes while a detached HEAD still has the work", s.judge(git("branch", "-f", "side", "main")), [])
    sh("git", "checkout", "-q", "main", cwd=s.repo)


def short_options(s):
    # Combined short options are read the way git reads them, and never after --.
    write(s.p("src", "a.py"), "changed\n")
    changed = [("uncommitted", "src/a.py")]
    expect("checkout -fq over a change holds", s.judge(git("checkout", "-fq")), changed)
    expect("switch -qf over a change holds", s.judge(git("switch", "-qf", "main")), changed)
    expect("checkout -Bfeature reads feature as the branch, not as more options", s.judge(git("checkout", "-Bfeature", "main")), [])
    expect("checkout -B with no name is left to git", s.judge(git("checkout", "-B")), [])
    sh("git", "checkout", "--", "src/a.py", cwd=s.repo)
    expect("checkout -- -B side names files, not a branch", s.judge(git("checkout", "--", "-B", "side")), [])
    write(s.p("-qf"))
    s.commit("a file named like options")
    write(s.p("-qf"), "changed\n")
    expect("checkout -- -qf names a file", s.judge(git("checkout", "--", "-qf")), [("uncommitted", "-qf")])
    sh("git", "checkout", "--", "-qf", cwd=s.repo)


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
    expect("deleting a worktree outside the repository folder holds over its changes", s.judge(delete(away)),
           [("uncommitted", os.path.join(away, "README.md"))])
    write(os.path.join(away, ".env"))
    sh("git", "add", "-f", ".env", cwd=away)
    write(os.path.join(away, "sub", ".env"))
    expect("worktree remove holds the ignored .env in it, not the one git has",
           s.judge(git("worktree", "remove", away)), [("uncommitted", os.path.join(away, "sub", ".env"))])

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
    # Not one of the session's worktrees, so the judge holds it without running git there.
    expect("a throwaway copy's worktree kept outside a temp folder still holds on remove --force",
           s.judge(git("worktree", "remove", "--force", copy_wt), cwd=copy_repo), [("history", copy_wt)])

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
