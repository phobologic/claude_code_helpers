# Mods

Claude Code mods: plugins whose hooks module changes Claude Code's own interface or
behaviour (panes, status lines, hooks on tool calls). This folder is a plugin
marketplace, `claude-mods`, like `languages/`.

| Mod | What it does |
|---|---|
| `workflow-monitor` | A live band above the prompt, full width, under the transcript. It shows the newest `/run-tickets` run of the session's repo (from `run-tickets-status --json`): its progress and each ticket not merged yet, with when its current step started. Below that, a count of the agents workflow scripts started in the session, and each one still running with its start time and how long it has run. Shows on the first workflow agent of a session. `/workflow-monitor` shows or hides it, and once hidden it stays hidden for the session until shown again. When it is taller than its room (at most half the terminal) it scrolls; its `[-]` mark collapses it. While `ticket-panes` is loaded, each of those tickets' ids is a button that opens the ticket, as a reply's ticket button does. It draws its rows above what the hooks beneath it draw (another mod's band, such as `ticket-panes`' ticket band in a side pane), not in its place, so both show. |
| `blast-radius` | Holds a Bash command or Write that could destroy something and asks you first, in Claude Code's own question dialog: deleting or overwriting anything outside the repository, touching `.git` or the repository folder, or losing work git can't give back (untracked or modified files, an ignored `.env` or database, a nested repository, unmerged commits, stashes). Everything else inside the repository runs as normal, and so does anything in an agent's scratch worktree or a temp folder. Any answer but "Run it" refuses the command. |
| `ticket-panes` | Makes tk tickets clickable. A reply that mentions tickets gets a dim `tickets:` row under it, a button per ticket. In a session running in herdr, a button opens a Claude agent for that ticket in a side pane to the right, with the ticket drawn in a band above its prompt and, while a `/run-tickets` run is working on the ticket, the run's live status for it in a pane below. Outside herdr, and inside a side pane, a button opens a read-only ticket pane in Claude Code instead. |

## Install

Once per machine, then once per mod. The user scope loads it in every session:

```
claude plugin marketplace add ~/git/claude_code/mods
claude plugin install workflow-monitor@claude-mods --scope user
claude plugin install blast-radius@claude-mods --scope user
claude plugin install ticket-panes@claude-mods --scope user
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
- It gives way to a survey, which uses the same band. It keeps what the hooks beneath
  it draw in the band, under its own rows, so both show.
- Hooks modules have no `Date`, so local times come from the UTC offset `date +%z`
  gives at session start.
- With `ticket-panes` loaded, each unmerged ticket's id in the run section is a button
  that opens the ticket through `$.ticketPanes.open`, the way a reply's ticket button
  does (see the `ticket-panes` notes). It declares no dependency on that mod: it asks
  whether `ticket-panes` is there at session start, and on its first draw after a
  reload, and draws the rows as plain text when it is not. A `ticket-panes` enabled
  later turns the ids into buttons after `/reload-plugins`. Clicks need the
  fullscreen layout, as for `ticket-panes`' own buttons.

`blast-radius` notes:
- Two parts. `hooks/parse.ts` reads the command text and lists what it could delete or
  overwrite (following `cd`, subshells, variables set on the line, `$HOME`, mktemp,
  heredocs, `$(...)`, `bash -c`, `find -delete`, `find | xargs rm`, and git commands
  that can discard work). `bin/judge.py` expands globs, resolves links, and asks git
  what is at stake. Its own checks: `python3 mods/blast-radius/bin/judge.test.py`.
- It judges by where the files are, not where the command runs. A linked worktree
  inside the repository folder (`.worktrees/*`, `.claude/worktrees/*`) is an agent's
  scratch space, so `/run-tickets` agents undoing their test mutations with
  `git checkout -- <file>` are never asked about. Git commands there on branches,
  stashes or objects (`branch -D`, `stash drop`, `gc --prune=now`) are still judged,
  since every worktree shares them. The worktree the session itself runs in, and
  worktrees kept outside the repository folder, get full protection.
- A folder that doesn't exist yet (`mkdir -p x && cd x && ...`) holds only what the
  command makes, so what runs there passes. It still holds when the command links or
  moves files there, a path climbs out with `..`, or a git command could reach work or
  history that exists now (a new subfolder of a checkout, `git branch -D` in a worktree
  the command adds).
- Ignored files are free to delete except `.env*` (not `.env.example` and kin),
  `*.db`, `*.sqlite` and `*.sqlite3`. Folders like `node_modules` and `.venv` are never
  searched.
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

`ticket-panes` notes:
- Clicks need Claude Code's fullscreen layout: the buttons are pressed with a click,
  and clicks reach a mod only there. On the main screen (`CLAUDE_CODE_NO_FLICKER=0`)
  the rows still draw, but a click on them does nothing.
- The button row. Each block of a reply on the terminal that mentions tk tickets gets
  one row under it: a dim `tickets:`, a button per ticket in order of first mention,
  each once, at most 8, then a dim `+N more`. A word shaped like a tk id (a prefix,
  `-` and four lowercase letters or digits, not inside a path) counts as a ticket when
  `<tickets dir>/<word>.md` exists, the tickets dir being `TICKETS_DIR` when set, else
  the first `.tickets/` folder up from the session's root, as tk finds it. Ids only
  inside fenced code blocks don't count (those are mostly commands and logs); ids in
  inline code and plain text do. The reply's own text is drawn as before, its ids
  plain. A ticket file found is remembered until a reload; one not found is looked for
  again after 60 seconds.
- One open at a time: a click while another ticket is opening toasts
  `still opening <id>` and does nothing else. What one click has to say comes as one
  toast when it is done.
- A click in herdr (a session with `HERDR_ENV=1` and a `HERDR_PANE_ID`, not itself a
  side pane) opens the ticket's side pane: one per session, split to the right of the
  session's pane without taking focus, running `claude` on the default model under
  the herdr agent name `tp-<id>` and the session name `ticket <id>`.
  - The same ticket again focuses its agent. If its Claude has exited (`/exit` in the
    pane), the click starts it again in the same pane.
  - Another ticket, while the side agent is idle: the agent is ended and its pane
    closed, and the clicked ticket opens in a fresh pane. Ending it sends ctrl+c, which
    clears anything typed in the side pane and not sent, then `/exit`.
  - Another ticket, while the side agent is working or blocked: nothing changes, and
    the toast names the side pane's ticket:
    `<id> is still working; click again to switch anyway`. A second click on the same
    ticket within 15 seconds switches, interrupting the turn with Esc first.
  - herdr shows an agent as working only a moment after a prompt is sent, so a click
    right after you send one in the side pane can switch away from an agent that has
    just started its turn.
  - A live agent for the ticket in another pane (another session's side pane, say) is
    focused instead of starting a second Claude on the same conversation.
  - When herdr fails, the toast says `no side pane for <id>: <step>: <reason>` and the
    read-only pane opens instead.
- Each ticket of a repo keeps one conversation: a click resumes it, in the folder it
  ran in while that is still there, or starts a new one. A side session records
  itself on the first prompt you type in it (not a slash command), so a side pane left
  before you typed anything leaves the next click to start afresh. `/clear` in the
  side pane starts a new conversation, and once you type a prompt in it, the next
  click resumes that one; the older ones stay in `/resume`. When the recorded
  conversation can't be resumed, the click starts a new one and toasts
  `<id>: earlier conversation not found; started a new one`.
- A startup question: when the side Claude starts on a question (folder trust, say),
  the pane stays open on it and the click toasts
  `<id> needs an answer in the side pane`. Answer it there.
- The side session shows its ticket in a band above the prompt, drawn from the
  ticket's file, never by the model, and drawn again within 5 seconds of a change to
  the file. It opens compact (id, status, type, priority, title, parent, description,
  acceptance criteria and how many notes) and collapses to one row,
  `[+] <id> · <status> · <title>`, on the first message you send (after start or
  `/clear`); the row's `+` brings compact back. `Show all` adds the notes and
  `Show less` takes them away. The engine's `[-]` mark hides the whole band, as for
  any band.
- The side agent's system prompt carries its rules and the ticket's file as the
  conversation started. A change to the ticket after that reaches it as a note on your
  next message.
- Where an organization manages Claude Code, `prompt.compose` and `session.compact`
  hooks don't run in a plugin a person installs, as
  `claude plugin validate mods/ticket-panes` says. There the side agent's system
  prompt has neither its rules nor the ticket's text, so tell it which ticket it is
  for or have it run `tk show <id>`. The tool guard and the band work as elsewhere.
- In a side pane, every ticket button, its own ticket's included, opens the read-only
  pane: a side pane never opens another side pane.
- The side agent's limits are a guard against mistakes, not a sandbox. In a side
  session it refuses, with a reason that says what is allowed:
  - Edit, Write and NotebookEdit on a path outside the session root's `.tmp/`, both
    resolved through links. A relative path, or one with `..` in it, is refused too.
    Bash commands that write files (`>`, `sed -i`, `cp`) are not checked.
  - `git commit`, `push`, `merge`, `revert`, `cherry-pick`, `am`, `rebase` and `pull`,
    always. git is found by its basename and past its global options (`-C <dir>`,
    `-c <k=v>`, `--git-dir=...`, `--no-pager`).
  - While the ticket is in a running `/run-tickets` run, any tk command but reading
    tickets (`show`, `ls`, `list`, `query`, `ready`, `blocked`, `closed`, `help`,
    `show-multi`, `epic-status`, `epic-tree`, `triage`, `backlog`, `dep tree`,
    `dep cycle`), `add-note`, and `create` with `--parent` the backlog epic (the id
    `tk backlog` prints). The ticket is in a run when a run of the repo whose state is
    `running` (one whose workflow died without finishing included) holds it unmerged,
    as `run-tickets-status --find-ticket` says. A run whose merges halted starts no
    more tickets, but the ones already in flight run on until they reach their merge
    step. Until the run ends, its unmerged tickets (the halted one included) still
    count as in it. Once it ends, tk is unlimited again. Outside a run tk is unlimited, and so it is when the
    lookup fails.
  - Any call the guard itself fails on (`ticket side agent guard failed`).
- How the guard reads Bash: it splits the text on newlines, `;`, `&&`, `||`, `|`, a
  lone `&` and a group's parentheses, reads the commands inside every `$(...)` and
  backtick group, strips a leading `(`, `{` or `!`, and reads past `env`, `K=V`
  assignments and the reserved words `if`, `then`, `elif`, `else`, `do`, `while`,
  `until` and `time`, so `for t in ...; do tk close "$t"; done` is judged. tk is found
  by its basename (`/path/tk`), and `tk super <sub>` as `<sub>`. A heredoc's lines
  are read as commands too, which errs on the safe side. It does not see `time -p ...`,
  `function f { ...; }`, `coproc ...`, `xargs ... tk close`, the `command`, `exec` and
  `nohup` wrappers, `sh -c` bodies or git aliases, and text it can't split (a quote
  left open, such as an apostrophe in a heredoc body) runs.
- The activity pane: while a `/run-tickets` run is working on the ticket, a click
  that opens or focuses its side pane also opens a pane below it running
  `run-tickets-status --ticket <id> --watch 30 <run-id>`, the run's opening lines and
  the ticket's block, drawn again every 30 seconds. It is checked on each click only,
  so a click after the run is done closes it, and a switch to another ticket closes it
  with the side pane. When the lookup fails, or the new pane can't be split or given
  its command, the side pane stays and the toast says
  `no run activity for <id>: <what failed>`.
- Outside herdr the button opens the read-only pane: the ticket from its file with
  everything shown, notes included, and no agent. Esc closes it. Another ticket
  replaces it, with a toast `Showing <new> (replaced <old>)`.
- Needs on the session's `PATH`: `herdr` for side panes, `run-tickets-status` for the
  activity pane and the guard's run lookup, and `tk` for the guard's backlog lookup;
  and `/usr/bin/uuidgen` for new conversations. A side pane starts with
  `TICKET_PANES_TICKET` and `TICKETS_DIR` set, and `CLAUDE_CODE_PLUGIN_DIRS` passed on
  when the session has it.
- For other plugins: `$.ticketPanes.open({ id })` opens a ticket the same way, and
  `$.ticketPanes.available({})` answers true while the mod is loaded. Call both in a
  try/catch with no `dependencies` entry, which would stop the caller loading without
  this mod; workflow-monitor's `hooks/ticket-panes.d.ts` declares their types.
