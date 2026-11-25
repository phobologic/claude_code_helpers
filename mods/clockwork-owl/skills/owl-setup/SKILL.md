---
name: owl-setup
description: Set up or revise a repo's config for the clockwork-owl mod (the sarcastic brass owl beside the prompt), .claude/owl.local.json or the committed .claude/owl.json. Surveys the repo to learn what it is and which commands, skills and tools matter, then writes the owl's voice note, repo-flavored lines and rules, and checks every rule against real sample calls with the owl_check tool. Use when the user asks to set up, tune or fix the owl for a repo, or to make the owl react to something in this repo.
---

# Owl setup

The **clockwork-owl** mod draws a brass owl beside the prompt. Its mood follows the session, and now and then it makes a remark in a bubble: canned lines for common moments, and a Haiku line written from a digest of recent activity. A repo tunes it with two optional files in `<repo root>/.claude/`:

- `owl.local.json`: personal, kept out of git. **The default this skill writes.**
- `owl.json`: committed, so everyone who clones the repo gets it. Write it only when the user asks for that.

When both exist the local file wins: its `voice` and `testCommands` replace the committed ones, its `lines` add to them, and its `rules` are tried first.

Nothing in either file runs. They are data: their text goes only into the owl's bubble and its Haiku prompt.

## The format

```json
{
  "voice": "One to three sentences about the repo and what is worth teasing.",
  "lines": { "greeting": ["Firmware again? My joints ache already."] },
  "rules": [
    { "label": "flash", "match": "make flash|esptool", "mood": "working",
      "pass": ["Flashed. Nothing smoked."], "fail": ["The board said no."] },
    { "label": "deploy", "tool": "Skill", "match": "^deploy$",
      "pass": ["Shipped. Brace yourself."] }
  ],
  "testCommands": true
}
```

- `voice` (at most 600 characters): goes into the Haiku prompt as "About this repo, from its owner". Describe what the repo is and what is worth noticing, not how to be funny; the owl already has a personality.
- `lines`: extra canned lines per moment, added to the built-in ones. Moments: `greeting`, `testFail`, `testFailAgain` (third failure in a row), `testPass` (green after red), `permission`, `longTurn` (over 8 minutes), `lazyPrompt` ("continue", "yes", "do it"), `interrupt`, `compact`, `sleepy` (15 idle minutes), `agents` (four subagents in a turn).
- `rules` (at most 30): each watches one tool call.
  - `tool`: `Bash` when left out. Any tool name works; `mcp__server__*` matches by prefix.
  - `match`: a JavaScript regular expression, tested against the call's **subject**: Bash's command; a Skill's skill name; Edit, Write, Read and NotebookEdit's file path; an Agent call's `subagent_type` and description; any other tool's arguments as JSON.
  - `mood` (optional): shown while the call runs: `idle`, `working`, `waiting`, `failed`, `happy`, `sleepy`.
  - When the call ends the owl turns `happy` or `failed` by its result and may say one of `pass` or `fail` (60% odds, at most one remark every 4 minutes).
  - `label`: what the digest calls it ("flash passed"), so Haiku can riff on it.
  - The first rule that matches wins.
- `testCommands`: `false` turns off the built-in test-run detection (Bash commands containing `test`, `pytest`, `vitest`, `go test` and so on), for repos where those words mean something else.

The owl only sees tool calls made in a Claude Code session. Something the user does in their own terminal, or a step that happens inside another program, is invisible to it.

## How the lines should sound

Every line you write, in `lines`, `pass` or `fail`:

- One line, at most 90 characters. Dry, sarcastic, a little smug, but on the user's side.
- Tease the behavior or the situation, never the person's intelligence or worth.
- Specific to this repo where you can: its hardware, its domain, its rituals. A line that would fit any repo adds nothing to the built-in ones.
- No em dashes, no emoji, no hashtags, no questions that need an answer.
- Don't invent facts about the repo. Only reference what you saw in the survey.

## Steps

1. **Check the ground.** Find the repo root (`git rev-parse --show-toplevel`). Read `.claude/owl.json` and `.claude/owl.local.json` if they exist: this is a revision. Keep the user's existing lines and voice unless they asked to change them, and add rather than replace.

2. **Pick the file.** `owl.local.json` unless the user asked for the committed one. For the local file, make sure git ignores it: `git check-ignore -q .claude/owl.local.json`. If that fails, add the line `.claude/owl.local.json` to `$(git rev-parse --git-common-dir)/info/exclude`, which ignores it in this clone only and changes no committed file. Say that you did.

3. **Survey.** Read, without writing anything:
   - `CLAUDE.md` (and what it includes) and `README.md`: what the repo is, its workflows and rituals.
   - `Makefile`, `justfile`, `package.json` scripts, `pyproject.toml`, `Cargo.toml`, `bin/` or `scripts/`: the commands people actually run.
   - CI config (`.github/workflows/`): how tests and builds really run.
   - `.claude/skills/*/SKILL.md` and `.claude/agents/`: workflows that run as skills or agents rather than Bash.
   - `git log --oneline -30`: what is being worked on lately, for flavor.

   Look for moments with real stakes or a clear outcome: deploys, releases, flashing hardware, migrations, long builds, publishing, benchmarks, data pulls. Note how the repo runs its tests, and whether "test" appears in commands that are not test runs.

4. **Draft.**
   - `voice`: what the repo is, in plain words, and what is worth teasing or noticing in it.
   - `rules`: only for moments that matter, usually 2 to 6. Each gets a `label`, a `match` precise enough not to catch everyday commands (no bare `make` or `python`), a `mood` if a running state is worth showing, and 3 to 5 lines for each of `pass` and `fail`.
   - `lines`: 3 to 5 repo-flavored `greeting` lines, plus a few for any moment where this repo has its own spin.
   - `testCommands: false` only if test detection would misfire here.

5. **Check it.** Call `mcp__clockwork-owl__owl_check` (load it with ToolSearch if it isn't listed) with the draft as `config` and `samples` drawn from what you saw in the survey: for every rule, at least one real call that should match, and one or two near misses that should not (an everyday command that shares a word). Fix the draft until the check reports no problems and every sample lands where you meant. If the tool isn't available, the mod isn't loaded in this session: check the JSON with `python3 -m json.tool`, and tell the user the rules weren't tested.

6. **Write and load.** Write the file. If the user asked for the committed `owl.json`, show them the draft first and wait for their OK, since everyone who clones the repo gets it. Then call `owl_check` with no `config`: it re-reads both files from disk, reports each, and loads the result into the running owl.

7. **Hand off.** Tell the user, briefly:
   - which file you wrote, and whether you added it to `info/exclude`
   - the voice note
   - each rule: what triggers it, in plain words
   - anything worth reacting to that the owl can't see, because it isn't a tool call in a session
   - that `/owl config` re-reads the files after a hand edit, and running this skill again revises them

   Leave committing `owl.json` to the user's usual flow.
