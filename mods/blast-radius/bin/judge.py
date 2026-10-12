#!/usr/bin/env python3
"""Blast Radius, part 2: decides which of a command's effects need the person.

Reads one JSON request on stdin, written by hooks/register.ts:

    {"sessionRoot": "/abs", "cwd": "/abs", "effects": [...],
     "altCwds": ["/abs", ...], "lostCwd": "why"}

each effect being what hooks/parse.ts found in the command. For a subagent, whose
shell Claude Code doesn't follow, `altCwds` are other folders it could be in: an effect
with relative paths is judged from each of them too. `lostCwd` says its folder can't be
known, which holds any such effect. Writes one verdict:

    {"hold": bool, "findings": [{"kind", "path", "detail", "cmd"}], "notes": [...]}

The policy goes by where the affected files are, not where the command runs:
- git's own data (.git), the repository folder, or a folder holding it: always held.
- The session's repository: held only when work would be lost that git can't give
  back: untracked or modified files, ignored files that look like secrets or local
  data, a nested repository's history, commits on no other branch, stashes.
- An agent's scratch worktree (a linked worktree inside the repository folder, other
  than the one the session runs in), and what temp folders and Claude's memory folders
  hold: free. A temp or memory folder itself is held like anywhere else.
  Only a worktree's own files are its alone: branches, stashes, reflogs and objects
  belong to the whole repository, so git commands on them count where its main
  checkout is, whichever worktree they run in.
- Anywhere else: held.

Run it with `python3 -I`, so nothing in the working directory is imported.
"""

import glob
import json
import os
import re
import subprocess
import sys
import tempfile
from fnmatch import fnmatchcase

LIST_MAX = 8
WALK_LIMIT = 200_000
SIZE_WALK_LIMIT = 20_000
# Ignored files that are usually someone's data rather than build output.
PROTECTED = (".env", ".env.*", "*.db", "*.sqlite", "*.sqlite3")
NOT_PROTECTED = {".env.example", ".env.sample", ".env.template", ".env.dist"}
# Installed or generated folders: never searched for protected files or nested
# repositories, since they are rebuilt rather than kept.
VENDORED = {
    "node_modules", ".venv", "venv", ".tox", "__pycache__", ".mypy_cache", ".pytest_cache",
    ".ruff_cache", "target", ".gradle", ".next", ".nuxt", ".svelte-kit", ".cache", "Pods",
    "DerivedData", "site-packages",
}
FIND_ACTIONS = {"-delete", "-exec", "-execdir", "-ok", "-okdir", "-fprint", "-fprint0", "-fprintf", "-fls"}
PLACEHOLDER = re.compile("\x01(\\w+)\x01")
# Where files are free to lose (see Ctx.where).
FREE = ("scratch", "temp")
# git subcommands that change what every worktree of a repository shares rather than
# one worktree's files. `worktree remove` isn't one: it is judged by the worktree it
# removes.
SHARED = {"stash", "branch", "reflog", "gc", "prune", "filter-branch", "filter-repo"}

# git runs without the caller's repository overrides, and never takes index.lock for
# a refresh, so a check never collides with an agent's own git command.
GIT_ENV = {k: v for k, v in os.environ.items() if not k.startswith("GIT_")}
GIT_ENV["GIT_OPTIONAL_LOCKS"] = "0"


class Unresolved(Exception):
    """Something the command depends on can't be known before it runs."""


def under(path, root):
    return path == root or path.startswith(root.rstrip("/") + "/")


def decode(b):
    return b.decode("utf-8", "surrogateescape")


def git(args, cwd, timeout=60):
    try:
        return subprocess.run(["git", *args], cwd=cwd, env=GIT_ENV, capture_output=True, timeout=timeout)
    except (OSError, subprocess.TimeoutExpired):
        return None


def git_out(args, cwd):
    r = git(args, cwd)
    return decode(r.stdout) if r is not None and r.returncode == 0 else None


def toplevel(path):
    d = path if os.path.isdir(path) else os.path.dirname(path)
    t = git_out(["rev-parse", "--show-toplevel"], d)
    return os.path.realpath(t.strip()) if t and t.strip() else None


def main_checkout(top):
    """The main working tree of the repository `top` belongs to, which every one of its
    worktrees shares branches, stashes and history with."""
    listing = git_out(["worktree", "list", "--porcelain"], top) or ""
    paths = [line[9:] for line in listing.splitlines() if line.startswith("worktree ")]
    if not paths:
        raise Unresolved(f"git worktree list failed in {top}, so whose branches and history these are is unknown")
    return os.path.realpath(paths[0])


def finding(kind, path, detail):
    return {"kind": kind, "path": path, "detail": detail}


def size(n):
    for unit in ("B", "KB", "MB", "GB"):
        if n < 1024 or unit == "GB":
            return f"{n:.0f} {unit}" if unit == "B" or n >= 10 else f"{n:.1f} {unit}"
        n /= 1024
    return f"{n:.0f} TB"


class Ctx:
    def __init__(self, req):
        self.cwd = os.path.realpath(req["cwd"])
        self.home = os.path.expanduser("~")
        self.home_real = os.path.realpath(self.home)
        tmp = tempfile.gettempdir()
        self.vars = {
            "HOME": self.home,
            "TMPDIR": os.environ.get("TMPDIR") or tmp,
            "USER": os.environ.get("USER", ""),
            "BR_TMP": tmp,
            "BR_CWD": self.cwd,
        }
        roots = os.environ.get("BLAST_RADIUS_TEMP_ROOTS")  # tests only
        temp = roots.split(os.pathsep) if roots else ["/tmp", "/var/tmp", tmp, os.environ.get("TMPDIR", "")]
        self.temp = sorted({os.path.realpath(p) for p in temp if p})
        self.memory = os.path.realpath(os.path.join(self.home, ".claude", "projects"))
        self.project = os.path.realpath(req["sessionRoot"])
        self.top = toplevel(self.project)  # the session's own working copy
        self.main = None
        self.worktrees = []
        if self.top:
            listing = git_out(["worktree", "list", "--porcelain"], self.top) or ""
            paths = [os.path.realpath(line[9:]) for line in listing.splitlines() if line.startswith("worktree ")]
            self.main = paths[0] if paths else self.top
            self.worktrees = paths or [self.top]
        # Linked worktrees inside the repository folder are agents' scratch space.
        self.scratch = [w for w in self.worktrees[1:] if under(w, self.main) and w != self.top] if self.main else []
        self.notes = []

    def where(self, rp):
        if ".git" in rp.split("/"):
            return "gitdir"
        for root in (self.main, self.top) if self.main else (self.project,):
            if under(root, rp):
                return "root"
        if any(under(rp, s) for s in self.scratch):
            return "scratch"
        if self.main and any(under(rp, w) for w in self.worktrees):
            return "inside"
        if not self.main and under(rp, self.project):
            return "nogit"
        if any(under(rp, t) and rp != t for t in self.temp):
            return "temp"
        # What a project's memory folder holds is free, like a temp folder's contents,
        # but the folder itself is not: deleting it loses every memory at once.
        rel = rp[len(self.memory) + 1 :].split("/") if under(rp, self.memory) else []
        if len(rel) >= 3 and rel[1] == "memory":
            return "temp"
        return "outside"

    def show(self, rp):
        for root in (self.main, self.top):
            if root and under(rp, root) and rp != root:
                return os.path.relpath(rp, root)
        if under(rp, self.home_real):
            return "~" + rp[len(self.home_real) :]
        return rp


# ---------- paths ----------


def subst(ctx, s):
    def value(m):
        name = m.group(1)
        if name == "BR_TOPLEVEL":
            t = toplevel(ctx.cwd)
            if not t:
                raise Unresolved("git rev-parse --show-toplevel outside a repository")
            return t
        v = ctx.vars.get(name)
        if not v:
            raise Unresolved(f"${name} is not set")
        return v

    s = PLACEHOLDER.sub(value, s)
    return os.path.expanduser(s) if s.startswith("~") else s


def base_dir(ctx, d):
    return ctx.cwd if d is None else os.path.normpath(os.path.join(ctx.cwd, subst(ctx, d)))


def expand(ctx, base, word, must_exist=True):
    w = subst(ctx, word)
    if glob.has_magic(w):
        pattern = w if os.path.isabs(w) else os.path.join(glob.escape(base), w)
        return sorted(glob.glob(pattern))  # like bash: * skips dotfiles
    p = w if os.path.isabs(w) else os.path.join(base, w)
    return [p] if not must_exist or os.path.lexists(p) else []


def resolve_delete(p):
    # rm removes the last name itself, never what a link there points to, unless the
    # path ends in a slash.
    if p.endswith("/") or os.path.basename(p) in ("", ".", ".."):
        return os.path.realpath(p)
    parent, name = os.path.split(p)
    return os.path.join(os.path.realpath(parent), name)


def describe(rp):
    if os.path.islink(rp):
        return "a symlink"
    if not os.path.isdir(rp):
        return "a file, " + size(os.lstat(rp).st_size)
    files, total, capped = 0, 0, False
    for dirpath, _, filenames in os.walk(rp):
        for f in filenames:
            files += 1
            try:
                total += os.lstat(os.path.join(dirpath, f)).st_size
            except OSError:
                pass
        if files > SIZE_WALK_LIMIT:
            capped = True
            break
    if files == 0:
        return "an empty folder"
    return f"a folder, {'over ' if capped else ''}{files:,} file{'s' if files != 1 else ''}, {size(total)}"


def is_protected(name):
    return name not in NOT_PROTECTED and any(fnmatchcase(name, p) for p in PROTECTED)


def tracked(path):
    out = git_out(["--literal-pathspecs", "ls-files", "-z", "--", os.path.basename(path)], os.path.dirname(path))
    return bool(out)


def changes(repo, untracked):
    """Files in `repo` whose content isn't in HEAD, as (path, what) pairs."""
    r = git(["-c", "core.quotePath=false", "status", "--porcelain=v1", "-z", f"--untracked-files={'all' if untracked else 'no'}"], repo)
    if r is None or r.returncode != 0:
        raise Unresolved(f"git status failed in {repo}")
    items = r.stdout.split(b"\0")
    found = []
    i = 0
    while i < len(items):
        entry = items[i]
        i += 1
        if len(entry) < 4:
            continue
        xy, path = decode(entry[:2]), decode(entry[3:]).rstrip("/")
        if xy[0] in "RC":
            i += 1  # the rename's source
        if xy == "??":
            what = "untracked"
        elif xy == "!!" or xy[1] == "D" or xy == "D ":
            continue  # nothing on disk to lose
        elif xy[1] == " ":
            what = "staged, not committed"
        else:
            what = "modified, not committed"
        found.append((os.path.join(repo, path), what))
    return found


def walk(ctx, top, protected, nested):
    """Collects protected files and nested repositories under `top`; True if cut short."""
    seen = 0
    for dirpath, dirnames, filenames in os.walk(top):
        if ".git" in dirnames or ".git" in filenames:
            real = os.path.realpath(dirpath)
            if real in ctx.scratch:
                dirnames[:] = []
                continue
            if ".git" in dirnames:
                nested.append((real, "repo"))
                dirnames[:] = []  # its history is the finding; its files go with it
                continue
            nested.append((real, "worktree"))
        for f in filenames:
            if is_protected(f):
                protected.append(os.path.join(dirpath, f))
        seen += len(filenames) + len(dirnames)
        if seen > WALK_LIMIT:
            return True
        dirnames[:] = [d for d in dirnames if d not in VENDORED]
    return False


# ---------- judging ----------


def judge_deletes(ctx, items):
    findings = []
    inside = {}
    for p, recursive in items:
        rp = resolve_delete(p)
        if not os.path.lexists(rp):
            continue
        isdir = os.path.isdir(rp) and not os.path.islink(rp)
        if isdir and not recursive:
            continue  # without -r, rm, unlink and find -delete leave a full folder alone
        w = ctx.where(rp)
        if w == "gitdir":
            if not isdir and rp.endswith(".lock"):
                continue  # a stale lock git left behind
            findings.append(finding("git", ctx.show(rp), "git's own data"))
        elif w == "root":
            own = rp in (ctx.main, ctx.top, ctx.project)
            findings.append(finding("git", ctx.show(rp), "the repository folder itself" if own else "a folder that holds the repository"))
        elif w == "outside":
            findings.append(finding("outside", ctx.show(rp), describe(rp)))
        elif w == "nogit":
            findings.append(finding("uncommitted", ctx.show(rp), "not in a git repository, so it can't be restored"))
        elif w == "inside":
            owner = toplevel(os.path.dirname(rp)) or (rp if rp in ctx.worktrees else None)
            if owner is None:
                findings.append(finding("uncommitted", ctx.show(rp), "not in git, so it can't be restored"))
            else:
                inside.setdefault(owner, []).append((rp, isdir))
    for owner, entries in inside.items():
        findings += judge_in_repo(ctx, owner, entries)
    return findings


def judge_in_repo(ctx, owner, entries):
    findings = []
    targets = [rp for rp, _ in entries]
    lost = {}
    for path, what in changes(owner, untracked=True):
        if any(under(path, t) for t in targets):
            lost[path] = what
    protected, nested = [], []
    for rp, isdir in entries:
        if VENDORED & set(os.path.relpath(rp, owner).split("/")):
            continue  # installed files: rebuilt, never kept
        if not isdir:
            if is_protected(os.path.basename(rp)):
                protected.append(rp)
        elif walk(ctx, rp, protected, nested):
            ctx.notes.append(f"{ctx.show(rp)} is too large to search fully for .env files and nested repositories.")
    for repo, kind in nested:
        if kind == "repo":
            findings.append(finding("history", ctx.show(repo), "a separate git repository: its history would be deleted"))
        else:
            for path, what in changes(repo, untracked=True):
                lost[path] = what
    for path in protected:
        if path not in lost and not tracked(path):
            lost[path] = "ignored by git, so it can't be restored"
    findings += [finding("uncommitted", ctx.show(p), what) for p, what in sorted(lost.items())]
    return findings


def judge_overwrite(ctx, p):
    if p.startswith("/dev/"):
        return []
    rp = os.path.realpath(p)  # a write goes through links to their target
    if not os.path.exists(rp):
        return []
    w = ctx.where(rp)
    if w == "gitdir":
        return [finding("git", ctx.show(rp), "git's own data would be overwritten")]
    if w == "outside":
        return [finding("outside", ctx.show(rp), f"would be overwritten ({describe(rp)})")]
    return []


def judge_copy(ctx, base, eff):
    findings = []
    # A link's source need not exist; a missing mv or cp source just fails.
    srcs = [p for w in eff["sources"] for p in expand(ctx, base, w, must_exist=eff["mode"] != "ln")]
    if eff["mode"] == "mv":
        for s in srcs:
            rp = resolve_delete(s)
            if ctx.where(rp) in ("gitdir", "root"):
                findings.append(finding("git", ctx.show(rp), "would be moved away"))
    if eff["noClobber"]:
        return findings
    for d in [p for w in eff["dest"] for p in expand(ctx, base, w, must_exist=False)]:
        rd = os.path.realpath(d)
        if eff["intoDir"] or (os.path.isdir(rd) and not eff["noTargetDir"]):
            targets = [os.path.join(rd, os.path.basename(os.path.normpath(s))) for s in srcs]
        else:
            targets = [rd]
        for t in targets:
            findings += judge_overwrite(ctx, t)
    return findings


def judge_find(ctx, base, eff):
    argv = [subst(ctx, a) for a in eff["argv"]]
    if FIND_ACTIONS & set(argv):
        raise Unresolved("a find with an action Blast Radius can't dry-run")
    try:
        r = subprocess.run(["find", *argv], cwd=base, capture_output=True, timeout=60)
    except subprocess.TimeoutExpired:
        raise Unresolved("find took too long to dry-run") from None
    except OSError as e:
        raise Unresolved(f"couldn't dry-run find: {e}") from None
    paths = [line for line in decode(r.stdout).split("\n") if line]
    return judge_deletes(ctx, [(os.path.join(base, p), eff["recursive"]) for p in paths])


# ---------- git ----------


def spec_path(cwd, top, spec):
    if spec.startswith(":/"):
        return os.path.join(top, spec[2:])
    if spec.startswith(":"):
        return top  # other pathspec magic: count the whole repository
    return os.path.realpath(os.path.join(cwd, spec))


def discard(ctx, top, cwd, pathspecs):
    """Tracked files with uncommitted changes that a discard of `pathspecs` (None: all) loses."""
    if ctx.where(top) in FREE:
        return []  # an agent's scratch checkout, or a throwaway copy
    specs = None if pathspecs is None else [spec_path(cwd, top, p) for p in pathspecs]
    found = []
    for path, what in changes(top, untracked=False):
        if specs is None or any(under(path, s) or (glob.has_magic(s) and fnmatchcase(path, s)) for s in specs):
            found.append(finding("uncommitted", ctx.show(path), f"{what}; the change would be discarded"))
    return found


def positionals(rest, valued=()):
    """Arguments that aren't options, and those after `--`."""
    out = []
    i = 0
    while i < len(rest):
        a = rest[i]
        if a == "--":
            return out, rest[i + 1 :], True
        if a.startswith("--pathspec-from-file"):
            raise Unresolved("git with --pathspec-from-file")
        if a in valued:
            i += 2
            continue
        if not a.startswith("-"):
            out.append(a)
        i += 1
    return out, [], False


def is_commitish(cwd, name):
    r = git(["rev-parse", "--verify", "-q", f"{name}^{{commit}}"], cwd)
    return r is not None and r.returncode == 0


def git_reset(ctx, top, cwd, rest):
    return discard(ctx, top, cwd, None) if "--hard" in rest else []


def git_checkout(ctx, top, cwd, rest):
    force = any(a in ("-f", "--force") for a in rest)
    pos, paths, dashdash = positionals(rest, ("-b", "-B", "--orphan"))
    if dashdash:
        if pos and not paths:
            return []
        return discard(ctx, top, cwd, paths) if paths else []
    if not pos:
        return discard(ctx, top, cwd, None) if force else []
    if is_commitish(cwd, pos[0]):
        if len(pos) == 1:
            return discard(ctx, top, cwd, None) if force else []  # a switch: git refuses to clobber
        return discard(ctx, top, cwd, pos[1:])
    return discard(ctx, top, cwd, pos)


def git_switch(ctx, top, cwd, rest):
    return discard(ctx, top, cwd, None) if any(a in ("-f", "--force", "--discard-changes") for a in rest) else []


def git_restore(ctx, top, cwd, rest):
    staged = any(a in ("-S", "--staged") for a in rest)
    worktree = any(a in ("-W", "--worktree") for a in rest)
    if staged and not worktree:
        return []  # only unstages: the file keeps its content
    pos, paths, _ = positionals(rest, ("-s", "--source"))
    specs = pos + paths
    return discard(ctx, top, cwd, specs) if specs else []


def git_rm(ctx, top, cwd, rest):
    if "--cached" in rest or not any(a == "--force" or re.match(r"^-[a-z]*f", a) for a in rest):
        return []  # without -f git refuses to drop changes
    pos, paths, _ = positionals(rest)
    return discard(ctx, top, cwd, pos + paths)


def git_clean(ctx, top, cwd, rest):
    force, dry = 0, False
    flags, excludes, paths = [], [], []
    i = 0
    while i < len(rest):
        a = rest[i]
        if a == "--":
            paths += rest[i + 1 :]
            break
        if a in ("-e", "--exclude"):
            excludes += ["-e", rest[i + 1] if i + 1 < len(rest) else ""]
            i += 2
            continue
        if a.startswith("--exclude="):
            excludes.append(a)
        elif a in ("-n", "--dry-run"):
            dry = True
        elif a == "--force":
            force += 1
        elif re.match(r"^-[a-zA-Z]+$", a):
            letters = a[1:]
            for j, ch in enumerate(letters):
                if ch == "e":
                    pattern = letters[j + 1 :]
                    if not pattern and i + 1 < len(rest):
                        i += 1
                        pattern = rest[i]
                    excludes += ["-e", pattern]
                    break
                force += ch == "f"
                dry |= ch == "n"
                if ch in "dxX":
                    flags.append("-" + ch)
        elif not a.startswith("-"):
            paths.append(a)
        i += 1
    if dry:
        return []
    if force == 0 and (git_out(["config", "--get", "clean.requireForce"], cwd) or "").strip() != "false":
        return []  # git refuses without -f
    r = git(["-c", "core.quotePath=false", "clean", "-n", *flags, *(["-f", "-f"] if force > 1 else []), *excludes, "--", *paths], cwd)
    if r is None or r.returncode != 0:
        raise Unresolved("git clean -n failed, so what it removes is unknown")
    prefix = "Would remove "
    listed = [line[len(prefix) :] for line in decode(r.stdout).splitlines() if line.startswith(prefix)]
    return judge_deletes(ctx, [(os.path.join(cwd, p), True) for p in listed])


def git_stash(ctx, top, cwd, rest):
    if not rest or rest[0] not in ("drop", "clear"):
        return []
    entries = (git_out(["stash", "list"], top) or "").splitlines()
    if rest[0] == "drop":
        ref = next((a for a in rest[1:] if not a.startswith("-")), "stash@{0}")
        if ref.isdigit():
            ref = f"stash@{{{ref}}}"
        entries = [e for e in entries if e.startswith(ref + ":")]
    return [finding("history", e.split(":", 1)[0], e.split(":", 1)[-1].strip() + " (a stash, dropped)") for e in entries]


def git_branch(ctx, top, cwd, rest):
    delete = force = remote = False
    names = []
    for a in rest:
        if a in ("-r", "--remotes"):
            remote = True
        elif a in ("-d", "--delete"):
            delete = True
        elif a in ("-f", "--force"):
            force = True
        elif re.match(r"^-[a-zA-Z]+$", a):
            delete |= "d" in a or "D" in a
            force |= "f" in a or "D" in a
            remote |= "r" in a
        elif not a.startswith("-"):
            names.append(a)
    if not (delete and force) or remote:
        return []  # git branch -d refuses to drop unmerged commits
    findings = []
    for name in names:
        others = ["--not", f"--exclude={name}", "--branches", "--tags", "--remotes", "HEAD"]
        r = git(["log", "--format=%h %s", name, *others], top)
        if r is None or r.returncode != 0:
            continue  # no such branch: git refuses
        commits = [line for line in decode(r.stdout).splitlines() if line]
        if commits:
            n = len(commits)
            findings.append(finding("history", name, f"{n} commit{'s' if n != 1 else ''} on no other branch, newest: {commits[0]}"))
    return findings


def git_worktree(ctx, top, cwd, rest):
    if not rest or rest[0] != "remove":
        return []
    pos, _, _ = positionals(rest[1:])
    if not pos:
        return []
    p = os.path.realpath(os.path.join(cwd, os.path.expanduser(pos[0])))
    if not os.path.isdir(p) or ctx.where(p) in FREE:
        return []
    findings = []
    if any(a in ("-f", "--force") for a in rest):
        findings += [finding("uncommitted", ctx.show(path), what) for path, what in changes(p, untracked=True)]
    protected = []
    walk(ctx, p, protected, [])
    findings += [finding("uncommitted", ctx.show(f), "ignored by git, so it can't be restored") for f in protected if not tracked(f)]
    return findings


def git_reflog(ctx, top, cwd, rest):
    if rest and rest[0] == "delete":
        return [finding("history", "reflog", "deletes reflog entries, which git uses to find lost commits")]
    if rest and rest[0] == "expire" and any(re.match(r"^--expire(-unreachable)?=(now|all)$", a) for a in rest):
        return [finding("history", "reflog", "expires reflog entries now, so lost commits can't be found again")]
    return []


def git_gc(ctx, top, cwd, rest):
    if any(re.match(r"^--prune=(now|all)$", a) for a in rest):
        return [finding("history", "unreachable commits", "pruned now, so lost commits can't be recovered")]
    return []


def git_prune(ctx, top, cwd, rest):
    if any(a in ("-n", "--dry-run") for a in rest):
        return []
    return [finding("history", "unreachable commits", "pruned, so lost commits can't be recovered")]


def git_filter(ctx, top, cwd, rest):
    return [finding("history", "history", "rewrites the repository's history")]


GIT = {
    "reset": git_reset, "checkout": git_checkout, "switch": git_switch, "restore": git_restore,
    "rm": git_rm, "clean": git_clean, "stash": git_stash, "branch": git_branch,
    "worktree": git_worktree, "reflog": git_reflog, "gc": git_gc, "prune": git_prune,
    "filter-branch": git_filter, "filter-repo": git_filter,
}


def git_start(base, args):
    """The folder git runs in, after its options before the subcommand, and the subcommand's index."""
    cwd = base
    i = 0
    while i < len(args) and args[i].startswith("-"):
        a = args[i]
        if a == "-C" and i + 1 < len(args):
            cwd = os.path.join(cwd, args[i + 1])
            i += 2
        elif a in ("-c", "--config-env", "--namespace", "--super-prefix"):
            i += 2
        elif a.startswith(("--git-dir", "--work-tree")):
            raise Unresolved("git with --git-dir or --work-tree")
        else:
            i += 1
    return os.path.realpath(cwd), i


def judge_git(ctx, base, eff):
    args = [subst(ctx, a) for a in eff["argv"]]
    cwd, i = git_start(base, args)
    if i >= len(args):
        return []
    top = toplevel(cwd) if os.path.isdir(cwd) else None
    if top is None:
        return []  # not a repository: git refuses
    handler = GIT.get(args[i])
    if handler is None:
        return []
    # Each handler judges a worktree's own files by where they are (discard, git clean's
    # deletes, the worktree remove takes). Shared state is free only when the whole
    # repository is a throwaway copy, never because a scratch worktree runs the command.
    if args[i] in SHARED and ctx.where(main_checkout(top)) in FREE:
        return []
    return handler(ctx, top, cwd, args[i + 1 :])


# ---------- main ----------


def judge(ctx, eff):
    op = eff.get("op")
    try:
        if op == "unknown":
            return [finding("unknown", "", eff.get("what", "can't tell what it changes"))]
        base = base_dir(ctx, eff.get("dir"))
        if not os.path.isdir(base):
            return [finding("unknown", ctx.show(base), "it runs in a folder that doesn't exist yet, so it can't be checked")]
        if op == "delete":
            return judge_deletes(ctx, [(p, eff["recursive"]) for w in eff["paths"] for p in expand(ctx, base, w)])
        if op == "overwrite":
            return [f for w in eff["paths"] for p in expand(ctx, base, w) for f in judge_overwrite(ctx, p)]
        if op == "copy":
            return judge_copy(ctx, base, eff)
        if op == "find":
            return judge_find(ctx, base, eff)
        if op == "git":
            return judge_git(ctx, base, eff)
        return [finding("unknown", "", f"an effect Blast Radius doesn't know: {op}")]
    except Unresolved as e:
        return [finding("unknown", "", str(e))]


def is_abs(s):
    return s.startswith(("/", "~", "\x01"))


def uses_cwd(eff):
    """Whether where the effect lands depends on the folder the command starts in."""
    if eff.get("dir") is not None and is_abs(eff["dir"]):
        return False
    if eff.get("op") in ("find", "git"):
        return True
    words = eff.get("paths", []) + eff.get("sources", []) + eff.get("dest", [])
    return any(not is_abs(w) for w in words)


def alternates(ctx, req):
    """A context per other folder the command could start in."""
    out = []
    for c in req.get("altCwds", []):
        try:
            p = os.path.realpath(base_dir(ctx, c))
        except Unresolved:
            continue
        if p != ctx.cwd and os.path.isdir(p) and p not in [a.cwd for a in out]:
            out.append(Ctx({**req, "cwd": p}))
    return out


def main():
    try:
        req = json.load(sys.stdin)
        ctx = Ctx(req)
        alts = alternates(ctx, req)
        findings, seen = [], set()
        for eff in req.get("effects", []):
            found = judge(ctx, eff)
            if uses_cwd(eff):
                here = {(f["kind"], f["path"], f["detail"]) for f in found}
                for alt in alts:
                    # Say which folder a finding comes from when only another one has it.
                    found += [{**f, "detail": f"{f['detail']} (if it runs in {ctx.show(alt.cwd)})"}
                              for f in judge(alt, eff) if (f["kind"], f["path"], f["detail"]) not in here]
                if req.get("lostCwd"):
                    found.append(finding("unknown", "", f"{req['lostCwd']}, so where its relative paths land is unknown"))
            for f in found:
                key = (f["kind"], f["path"], f["detail"])
                if key not in seen:
                    seen.add(key)
                    findings.append({**f, "cmd": eff.get("cmd", "")})
        notes = ctx.notes + [n for alt in alts for n in alt.notes if n not in ctx.notes]
        verdict = {"hold": bool(findings), "findings": findings, "notes": notes}
    except Exception as e:  # any failure holds the command rather than letting it through
        verdict = {"hold": True, "findings": [finding("unknown", "", f"Blast Radius hit an error checking it: {e!r}")], "notes": []}
    json.dump(verdict, sys.stdout)


if __name__ == "__main__":
    main()
