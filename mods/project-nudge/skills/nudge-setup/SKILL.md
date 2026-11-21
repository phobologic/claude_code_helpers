---
name: nudge-setup
description: Set up or revise a repo's .claude/nudge/run script for the project-nudge mod (the band above the prompt that says what to do next). Surveys the repo's skills, CLAUDE.md, scripts and file patterns, proposes nudges keyed to workflows, timelines and dependencies, then writes the script, its trust file, a README and a check. Use when the user asks to add a nudge, set up project-nudge for a repo, fix a nudge error, or improve an existing nudge.
---

# Nudge setup

The **project-nudge** mod runs `<repo root>/.claude/nudge/run` at session start and after each main-loop turn, in repos the user has allowed (answers kept in `~/.claude/project-nudge.json`), and shows the result in a band above the prompt. This skill helps a repo write a good `run`. The mod knows nothing about any project; every rule about *what* is worth a nudge lives in the repo.

If the argument is an error message from the mod's red band, this is a fix: go to step 1, read the error against the contract below, fix that, and run step 6.

## The contract (version 1)

`.claude/nudge/` holds two required files:

- `run`: any executable (shebang, `chmod +x`), a regular file, not a symbolic link.
- `trust`: the repo files `run` relies on, one repo-relative path per line (blank lines and lines starting with `#` ignored). It may list nothing, but it must exist. Each entry is a regular file inside the repo: no folders, no symbolic links, no absolute paths, no `..`.

When the user allows the repo, the mod pins the git blob hash of `run`, `trust` and every listed file. If any of them changes (a merged PR, a local edit), it stops running the script and asks again. So list **everything `run` executes or imports from the repo**, transitively: a file left out can change without a re-ask. Keep the set small, since every edit to a listed file costs the user a re-approval.

The mod runs `run` with the repo root as cwd, a 5 s timeout (a session's start waits for it, so a slow script delays every launch), and these variables set:

- `PYTHONSAFEPATH=1`: Python does not put the script's own folder on `sys.path`, so a sibling module is not importable by name. This is deliberate: an unlisted file beside the script would otherwise run unpinned. Load helpers by path, or keep the script one file.
- `PYTHONDONTWRITEBYTECODE=1`: no `__pycache__` written into the repo.
- `GIT_OPTIONAL_LOCKS=0`: `git status` and similar do not take the index lock while the user's own git commands run.

It must exit 0 and print exactly one JSON object:

```json
{ "version": 1, "nudge": null }
```

```json
{
  "version": 1,
  "nudge": {
    "title": "Short label",
    "lines": ["Headline, shown bold", "Further lines"],
    "command": "/the-next-command args"
  },
  "context": "Optional text handed to Claude at session start."
}
```

- `nudge: null` is the explicit "nothing to do". Empty output is an **error**, not silence.
- `lines` is a non-empty array of non-empty strings; the first is the headline. `command` is optional; when set, the band offers a Load button that fills the prompt with it.
- `context` is read only at session start, `/clear`, resume and compaction, not after each turn. Use it for an instruction to Claude ("in your first reply, tell the user ..."), not a copy of `lines`.
- Non-zero exit, timeout, bad JSON, wrong shape, or an unusable `run` or `trust` all show a red error band with stderr. A contract error offers "Fix with /project-nudge:nudge-setup", which starts this skill with the error as its argument. Let real failures fail; never `|| true` them away.

## Rules every nudge script follows

- **Self-contained.** Plain shell, or `python3` with only the standard library. Never `uv run`, `npx`, `bundle exec`, `poetry run` or anything else that resolves or installs packages: those read lockfiles and package folders that `trust` does not pin, and may reach the network. Calling an existing repo script is fine when it is listed in `trust` along with everything it imports.
- **Fast.** It runs after every turn. Aim for well under a second: file existence, names, mtimes, `git` plumbing. Never read large files, walk huge trees, or start heavy runtimes when a shell check would do.
- **Read-only.** It reports; it never fixes, writes, fetches or commits.
- **No network.** No API calls, no `git fetch`.
- **Deterministic.** The same tree gives the same answer.
- **One command.** Offer the single most important next step. List the rest in `lines` if they help.
- **Quiet by default.** `nudge: null` unless something is genuinely pending. A band that is always up gets ignored.
- **Machine-aware where needed.** If a nudge only applies on some machines (an optional checkout present, a tool installed), check for it and emit `nudge: null` elsewhere.

## Steps

1. **Check the ground.** Find the repo root (`git rev-parse --show-toplevel`). If `.claude/nudge/` exists, read `run`, `trust` and `README.md` first: this is a revision, not a fresh start.
2. **Survey.** Read, without writing anything:
   - `CLAUDE.md` (and any it includes): workflows, "after X, run Y", ordered cycles, release or review rituals.
   - Project skills (`.claude/skills/*/SKILL.md`) and agents: what each produces, what it reads, and which skill's output another needs.
   - `scripts/`, `Makefile`, `package.json` scripts, hooks (`.githooks/`, `.claude/settings.json`): existing status or check scripts worth calling rather than re-implementing.
   - Recurring file patterns: numbered or dated folders (`sessions/<NN>/`, `docs/adr/`), generated outputs beside their sources, stamp files.
   - `tk` or other ticket state, if the repo uses it and a check is cheap.
3. **Find candidate nudges.** Look for state that is visible on disk:
   - **Dependencies:** a chain where step B needs A's output (A's file exists, B's does not).
   - **Staleness:** an output older than its sources (compare mtimes, or a recorded marker).
   - **Timelines:** something due relative to a date in the repo (next meeting, release, session).
   - **Rituals:** an audit or stamp that must follow certain changes (a stamp file older than the last commit touching some paths).
   For each, note the signal, what the band would say, the command it would offer, and its cost.
4. **Propose, then ask.** Present the candidates as a short table (signal, message, command, cost) with a recommendation, and ask the user which to build and in what priority. Do not write before they choose.
5. **Write.** Create `.claude/nudge/run` (thin: call an existing status script if there is one, adding a JSON mode to it rather than duplicating its logic), `.claude/nudge/trust` (every repo file `run` executes or imports, traced transitively), and `.claude/nudge/README.md` (what it nudges about, the signals, the rules above in brief). `chmod +x` the script.
6. **Check it.** Re-read `run` and each file in `trust` and confirm nothing it executes or imports from the repo is missing from `trust`. Run it the way the mod does, from the repo root: `PYTHONSAFEPATH=1 PYTHONDONTWRITEBYTECODE=1 GIT_OPTIONAL_LOCKS=0 .claude/nudge/run | python3 -m json.tool`; time it; confirm `git status` shows nothing new afterwards. Exercise the `nudge: null` path too, ideally by a real state rather than by editing files. If the repo has tests for its scripts, add one for the JSON mode.
7. **Hand off.** Tell the user: the next session in this repo shows an Allow / Never / View script band; allowing it pins the files in `~/.claude/project-nudge.json`, and any later change to them brings back a "nudge changed" band with View changes. Editing these files now means the band asks again, which is expected. If the repo takes outside pull requests, suggest reviewing any that touch the trusted files. Leave committing to the user's usual flow.

## Example

A repo that runs an ordered cycle after each meeting (notes, then summary, then follow-up tickets) keeps each step's output in `meetings/<NN>/`. Its `run` is two lines of shell that call `scripts/meeting-status.py --nudge`; `trust` lists that one file. The script finds the newest `meetings/<NN>/`, sees `notes.md` but no `summary.md`, and prints a nudge titled "Meeting 12" with the headline "Notes are in; the summary is next" and the command `/summarize 12`. With every step done it prints `"nudge": null`.
