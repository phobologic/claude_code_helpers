# Mods

Claude Code mods: plugins whose hooks module changes Claude Code's own interface or
behaviour (panes, status lines, hooks on tool calls). This folder is a plugin
marketplace, `claude-mods`, like `languages/`.

| Mod | What it does |
|---|---|
| `workflow-monitor` | A live band above the prompt, full width, under the transcript. It shows the newest `/run-tickets` run of the session's repo (from `run-tickets-status --json`): its progress and each ticket not merged yet, with when its current step started. Below that, a count of the agents workflow scripts started in the session, and each one still running with its start time and how long it has run. Shows on the first workflow agent of a session. `/workflow-monitor` shows or hides it, and once hidden it stays hidden for the session until shown again. When it is taller than its room (at most half the terminal) it scrolls; its `[-]` mark collapses it. |

## Install

Once per machine, then once per mod. The user scope loads it in every session:

```
claude plugin marketplace add ~/git/claude_code/mods
claude plugin install workflow-monitor@claude-mods --scope user
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
