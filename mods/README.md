# Mods

Claude Code mods: plugins whose hooks module changes Claude Code's own interface or
behaviour (panes, status lines, hooks on tool calls). This folder is a plugin
marketplace, `claude-mods`, like `languages/`.

| Mod | What it does |
|---|---|
| `workflow-monitor` | A live band above the prompt, full width, under the transcript. It shows the newest `/run-tickets` run of the session's repo (from `run-tickets-status --json`): its progress and each ticket not merged yet, with when its current step started. Below that, a count of the agents workflow scripts started in the session, and each one still running with its start time and how long it has run. Shows on the first workflow agent of a session. `/workflow-monitor` shows or hides it, and once hidden it stays hidden for the session until shown again. When it is taller than its room (at most half the terminal) it scrolls; its `[-]` mark collapses it. |
| `blast-radius` | Holds a Bash command or Write that could destroy something and asks you first, in Claude Code's own question dialog: deleting or overwriting anything outside the repository, touching `.git` or the repository folder, or losing work git can't give back (untracked or modified files, an ignored `.env` or database, a nested repository, unmerged commits, stashes). Everything else inside the repository runs as normal, and so does anything in an agent's scratch worktree or a temp folder. Any answer but "Run it" refuses the command. |

## Install

Once per machine, then once per mod. The user scope loads it in every session:

```
claude plugin marketplace add ~/git/claude_code/mods
claude plugin install workflow-monitor@claude-mods --scope user
claude plugin install blast-radius@claude-mods --scope user
```

`--scope project` instead installs it for one repo only. `/plugin` lists, disables and
uninstalls it like any other plugin.

The marketplace is a folder and each entry a relative path, so an installed mod is
read from this repo, not from a copy: edit it here and run `/reload-plugins`.

## Developing

```
claude plugin validate mods/<mod>   # what the engine would refuse, and what the module hooks and calls
claude plugin test mods/<mod>       # the mod's *.test.ts(x) files, run against the engine
```

The mod API's types are written next to a mod (`.claude-plugin/types/`) the first time
a session loads it from a folder you own.

`workflow-monitor` notes:
- It sees only agents started in its own session, after it loaded. A resumed run's
  replayed agents are not shown.
- The run section needs `run-tickets-status` on the session's `PATH`, and reads the run
  of the repo the session was started in. It refreshes every 30 seconds while something
  runs and every 5 minutes otherwise, and only while the band is being drawn.
- It gives way to a survey, which uses the same band.
- Hooks modules have no `Date`, so local times come from the UTC offset `date +%z`
  gives at session start.

`blast-radius` notes:
- Two parts. `hooks/parse.ts` reads the command text and lists what it could delete or
  overwrite (following `cd`, subshells, variables set on the line and how they split
  into words, brace expansion, `$'...'`, `$HOME`, mktemp, heredocs, `$(...)`, `bash -c`,
  `find -delete`, `find | xargs rm`, and git commands that can discard work). `bin/judge.py` expands globs, resolves links, and asks git
  what is at stake. Its own checks: `python3 mods/blast-radius/bin/judge.test.py`.
- It judges by where the files are, not where the command runs. A linked worktree
  inside the repository folder (`.worktrees/*`, `.claude/worktrees/*`) is an agent's
  scratch space, so `/run-tickets` agents undoing their test mutations with
  `git checkout -- <file>` are never asked about. The worktree the session itself runs
  in, and worktrees kept outside the repository folder, get full protection. Branches,
  stashes, reflogs and objects belong to the whole repository, so `git branch -D`,
  `git stash clear` and the like are judged the same from a scratch worktree as from
  the main checkout, and `git worktree remove` by the worktree it removes.
- Ignored files are free to delete except `.env*` (not `.env.example` and kin),
  `*.db`, `*.sqlite` and `*.sqlite3`. Folders like `node_modules` and `.venv` are never
  searched.
- When it checks a delete or `git worktree remove`, git only runs in the session's own
  repository and its worktrees. git run in another one (a clone or submodule inside the
  project, or an archive extracted with its own `.git`) would read that repository's
  config, which can run commands (`core.fsmonitor`, clean filters) before you are even
  asked. So deleting anything inside another repository, or `git worktree remove` of a
  folder with its own `.git` that isn't one of the session's worktrees, is always held.
  git commands that name another repository are still checked by running git there (see
  cc-8res).
- What it can't expand (`xargs rm`, `rm "$VAR"` with a variable from an earlier call,
  `sh -c "$CMD"`, inline Python or Node that deletes files) is held, since it could be
  anything. What it can't see at all runs: scripts (`make clean`, `./cleanup.sh`),
  `sed -i`, inline code that writes files, archive extraction. It is a safety net, not
  a sandbox; Claude Code's Bash sandbox is the hard limit on writes outside the repo.
- The Edit tool is never held. Write is held only when it replaces an existing file
  outside the repository or in `.git`.
- Subagents and workflow agents are checked like the session, and the question names the
  agent. A held agent waits for your answer while the others keep running; questions
  come one at a time. If the dialog times out, is dismissed, or the turn is interrupted,
  the command is refused. Under `claude -p` there is no one to ask, so every held
  command is refused.
- Claude Code follows the session's own shell folder but not a subagent's. A subagent's
  starting folder comes from its spawn or Claude Code's SubagentStart event (a worktree
  of its own included), and its relative paths are also measured from its last `cd`;
  one whose starting folder is unknown is measured from the session's root too. Any of
  them holding holds the command, and a finding only another folder has says which
  (`(if it runs in ...)`). After a `cd` it can't follow (`cd "$VAR"`, `cd -`), that
  subagent's relative paths are held until it `cd`s somewhere known. A reload of the
  mod mid-session forgets the subagents already running, so those are measured as if
  their folder were unknown.
  `/run-tickets` agents start every command with `cd <worktree> && `, so they are
  always measured in the right place.
- Needs `python3` and `git` on the session's `PATH`. If the judge can't run, a command
  with effects is held with the reason.
- The idea is from the Blast Radius mod in anthropics/claude-code-playground, which
  holds by command name; this one holds by where the files are and whether git can
  restore them.
