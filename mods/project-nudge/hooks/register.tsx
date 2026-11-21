import { atom, read, update } from 'claude-code'
import type { Hook, Register } from 'claude-code'

import type { Hashes, NudgeView } from '../types'

// project-nudge: a project opts in by shipping .claude/nudge/run (executable)
// and .claude/nudge/trust (the repo files run relies on, one path per line,
// relative to the repo root; blank lines and lines starting with # ignored; may
// list nothing). When the person allows the repo, the mod pins the git blob
// hash of run, trust and every file trust lists, plus the commit, in
// ~/.claude/project-nudge.json. It runs the script at session start and after
// each main-loop turn, and shows what it says in a band above the prompt. If
// any pinned file changes, it stops running the script and asks again.
//
// The script's contract (version 1): exit 0 and print one JSON object.
//   { "version": 1, "nudge": null }                    nothing to do, no band
//   { "version": 1, "nudge": { "title": "...", "lines": ["..."], "command": "/x" },
//     "context": "..." }                               show a band; context goes
//                                                      to Claude at session start
// Anything else (non-zero exit, no output, bad JSON, wrong shape, timeout, a
// missing run or trust) is an error, shown in a red band so it gets looked at
// rather than swallowed.

const view = atom({ plugin: 'project-nudge', key: 'view' } as const, { kind: 'none' } as NudgeView)
const dismissed = atom({ plugin: 'project-nudge', key: 'dismissed' } as const, null)

const ACCENT = '#d4a017'
const ERROR = '#d0453a'
const HINT = 'ctrl+x tab to focus · esc back'
const TIMEOUT_MS = 5000
const ALLOWLIST = '.claude/project-nudge.json'
const RUN = '.claude/nudge/run'
const TRUST = '.claude/nudge/trust'
const SETUP = '/project-nudge:nudge-setup'

// Set for the script on every run. Python must not import from the script's
// own folder (a file there that trust does not list would run unpinned) or
// write .pyc files into the repo, and git must not take the index lock while
// the person's own git commands may be running.
export const RUN_ENV: Record<string, string> = {
  PYTHONSAFEPATH: '1',
  PYTHONDONTWRITEBYTECODE: '1',
  GIT_OPTIONAL_LOCKS: '0',
}

type Dollar = Parameters<Hook<'session.start'>>[0]
type Pinned = { answer: 'allow'; files: Hashes; commit: string | null }
type Entry = 'never' | Pinned
type Allowlist = { version: 1; repos: Record<string, Entry> }
type Outcome = { view: NudgeView; context: string | null }

const NONE: Outcome = { view: { kind: 'none' }, context: null }

class NudgeError extends Error {
  constructor(
    message: string,
    readonly detail: string[] = [],
    readonly setup = false,
  ) {
    super(message)
  }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function firstLines(text: string): string[] {
  return text
    .split('\n')
    .map(l => l.trimEnd())
    .filter(Boolean)
    .slice(0, 6)
}

function fail(root: string, summary: string, detail: string[] = [], setup = false): Outcome {
  return { view: { kind: 'error', root, summary, detail: detail.slice(0, 6), setup }, context: null }
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

// ---- locating things -------------------------------------------------------

async function repoRoot($: Dollar): Promise<string> {
  const cwd = await $.session.cwd()
  try {
    const git = await $.process.run(['git', 'rev-parse', '--show-toplevel'], { cwd, timeoutMs: 5000 })
    const top = git.stdout.trim()
    if (git.exitCode === 0 && top) return top
  } catch {
    // git is missing: the session directory is the root.
  }
  return cwd
}

async function allowlistPath($: Dollar): Promise<string> {
  const home = await $.env.get('HOME')
  if (!home) throw new Error('HOME is not set')
  return `${home}/${ALLOWLIST}`
}

// A session another tool opened beside the main one (a ticket pane, say) has a
// narrower job: the repo's next-step nudge and its context would pull it off
// that job. Any launcher marks such a session by setting this to its own name.
async function isSideSession($: Dollar): Promise<boolean> {
  return Boolean(await $.env.get('CLAUDE_SIDE_SESSION'))
}

// ---- the pinned files ------------------------------------------------------

/** The paths a trust file lists: blank lines and lines starting with # are skipped. */
export function parseTrust(text: string): string[] {
  return text
    .split('\n')
    .map(l => l.trim())
    .filter(l => l && !l.startsWith('#'))
}

/** A pinned file must be a regular file, not a link: git hashes a link's target path, not what it points at. */
async function checkFile($: Dollar, root: string, path: string, what: string) {
  const stat = await $.fs.stat(`${root}/${path}`).catch(() => null)
  if (stat === null) throw new NudgeError(`${what}, which does not exist`, [], true)
  if (stat.isLink) throw new NudgeError(`${what}, which is a symbolic link; pin the file itself`, [], true)
  if (stat.kind !== 'file') throw new NudgeError(`${what}, which is not a file; list each file on its own line`, [], true)
}

/** run, trust, and every path trust lists, repo-relative. Throws NudgeError when one is unusable. */
export async function pinnedFiles($: Dollar, root: string): Promise<string[]> {
  await checkFile($, root, RUN, '.claude/nudge/ needs a run script')
  const x = await $.process.run(['test', '-x', `${root}/${RUN}`])
  if (x.exitCode !== 0) throw new NudgeError('.claude/nudge/run is not executable (chmod +x it)', [], true)
  if (!(await $.fs.exists(`${root}/${TRUST}`))) {
    throw new NudgeError('.claude/nudge/ has no trust file', ['List the repo files run relies on, one per line (it may list none).'], true)
  }
  await checkFile($, root, TRUST, '.claude/nudge/ needs a trust file')
  const listed = parseTrust(await $.fs.read(`${root}/${TRUST}`))
  for (const p of listed) {
    if (p.startsWith('/') || p.split('/').includes('..')) {
      throw new NudgeError(`trust lists "${p}"; paths must be inside the repo and relative to its root`, [], true)
    }
    await checkFile($, root, p, `trust lists "${p}"`)
  }
  return [...new Set([RUN, TRUST, ...listed])]
}

async function hashFiles($: Dollar, root: string, files: string[]): Promise<Hashes> {
  const out = await $.process.run(['git', 'hash-object', '--', ...files], { cwd: root, timeoutMs: 5000 })
  const hashes = out.stdout.trim().split('\n')
  if (out.exitCode !== 0 || hashes.length !== files.length) {
    throw new NudgeError('could not hash the nudge files', firstLines(out.stderr))
  }
  return Object.fromEntries(files.map((f, i) => [f, hashes[i] ?? '']))
}

/** The paths whose hash differs between two pins, including ones only one of them has. */
export function changedFiles(now: Hashes, was: Hashes): string[] {
  return [...new Set([...Object.keys(now), ...Object.keys(was)])].filter(f => now[f] !== was[f])
}

async function headCommit($: Dollar, root: string): Promise<string | null> {
  const out = await $.process.run(['git', 'rev-parse', 'HEAD'], { cwd: root, timeoutMs: 5000 })
  return out.exitCode === 0 ? out.stdout.trim() : null
}

// ---- the allowlist ---------------------------------------------------------

async function readAllowlist($: Dollar): Promise<Allowlist> {
  const path = await allowlistPath($)
  if (!(await $.fs.exists(path))) return { version: 1, repos: {} }
  const parsed: unknown = JSON.parse(await $.fs.read(path))
  if (!isObject(parsed) || !isObject(parsed.repos)) {
    throw new Error(`${path} is not a { "version": 1, "repos": { ... } } object`)
  }
  return { version: 1, repos: parsed.repos as Record<string, Entry> }
}

/** Writes beside the allowlist, then renames over it, so a reader never sees half a file. */
async function writeAllowlist($: Dollar, list: Allowlist) {
  const path = await allowlistPath($)
  const tmp = await $.process.run(['mktemp', `${path}.XXXXXX`])
  const tmpPath = tmp.stdout.trim()
  if (tmp.exitCode !== 0 || !tmpPath) throw new Error(`could not make a temporary file beside ${path}`)
  await $.fs.write(tmpPath, `${JSON.stringify(list, null, 2)}\n`)
  const mv = await $.process.run(['mv', '-f', tmpPath, path])
  if (mv.exitCode !== 0) {
    await $.process.run(['rm', '-f', tmpPath])
    throw new Error(firstLines(mv.stderr)[0] ?? `could not replace ${path}`)
  }
}

/**
 * Saves the answer. Allow pins `expected`, the hashes the band showed; when the
 * files no longer match them it saves nothing and returns false, so the person
 * is asked again about what is there now.
 */
async function remember($: Dollar, root: string, answer: 'allow' | 'never', expected: Hashes | null): Promise<boolean> {
  let entry: Entry = 'never'
  if (answer === 'allow') {
    const files = await pinnedFiles($, root)
    const now = await hashFiles($, root, files)
    if (expected === null || changedFiles(now, expected).length > 0) return false
    entry = { answer: 'allow', files: now, commit: await headCommit($, root) }
  }
  // Read again just before writing, to keep another session's answers.
  const list = await readAllowlist($)
  list.repos[root] = entry
  await writeAllowlist($, list)
  return true
}

// ---- running the script ----------------------------------------------------

/** Reads the script's output against the contract. */
export function parse(root: string, stdout: string): Outcome {
  if (!stdout.trim()) return fail(root, 'run exited 0 but printed nothing; "nothing to do" must be {"version": 1, "nudge": null}', [], true)
  let out: unknown
  try {
    out = JSON.parse(stdout)
  } catch (err) {
    return fail(root, `run printed something that is not JSON (${errorText(err)})`, firstLines(stdout), true)
  }
  if (!isObject(out)) return fail(root, 'run must print a JSON object', firstLines(stdout), true)
  if (out.version !== 1) return fail(root, `unsupported "version": ${JSON.stringify(out.version)} (this mod reads version 1)`, [], true)
  if (!('nudge' in out)) return fail(root, 'the output has no "nudge" key; "nothing to do" is "nudge": null', [], true)
  if (out.context !== undefined && out.context !== null && typeof out.context !== 'string') {
    return fail(root, '"context" must be a string when given', [], true)
  }
  const context = typeof out.context === 'string' && out.context.trim() ? out.context : null

  const n = out.nudge
  if (n === null) return { view: { kind: 'none' }, context }
  if (!isObject(n)) return fail(root, '"nudge" must be null or an object', [], true)
  if (typeof n.title !== 'string' || !n.title.trim()) return fail(root, '"nudge.title" must be a non-empty string', [], true)
  if (!Array.isArray(n.lines) || n.lines.length === 0 || !n.lines.every(l => typeof l === 'string' && l.trim())) {
    return fail(root, '"nudge.lines" must be a non-empty array of non-empty strings', [], true)
  }
  if (n.command !== undefined && n.command !== null && typeof n.command !== 'string') {
    return fail(root, '"nudge.command" must be a string or null when given', [], true)
  }
  const command = typeof n.command === 'string' && n.command.trim() ? n.command.trim() : null
  return { view: { kind: 'nudge', root, title: n.title.trim(), lines: n.lines as string[], command }, context }
}

async function evaluate($: Dollar): Promise<Outcome> {
  if (await isSideSession($)) return NONE
  const root = await repoRoot($)
  if (!(await $.fs.exists(`${root}/.claude/nudge`))) return NONE

  let entry: Entry | undefined
  try {
    entry = (await readAllowlist($)).repos[root]
  } catch (err) {
    return fail(root, `could not read ~/${ALLOWLIST}`, [errorText(err)])
  }
  if (entry === 'never') return NONE

  let files: string[]
  let now: Hashes
  try {
    files = await pinnedFiles($, root)
    now = await hashFiles($, root, files)
  } catch (err) {
    if (err instanceof NudgeError) return fail(root, err.message, err.detail, err.setup)
    throw err
  }

  // No answer yet, or one this mod cannot read: ask.
  if (!isObject(entry) || !isObject(entry.files)) return { view: { kind: 'ask', root, files, hashes: now }, context: null }

  const changed = changedFiles(now, entry.files as Hashes)
  if (changed.length > 0) {
    return { view: { kind: 'changed', root, files, hashes: now, changed, since: entry.commit ?? null }, context: null }
  }

  let res
  try {
    res = await $.process.run([`${root}/${RUN}`], { cwd: root, env: RUN_ENV, timeoutMs: TIMEOUT_MS })
  } catch (err) {
    return fail(root, `run did not finish within ${TIMEOUT_MS / 1000}s, or could not start`, [errorText(err)])
  }
  if (res.exitCode !== 0) {
    return fail(root, `run exited ${res.exitCode}`, firstLines(res.stderr || res.stdout))
  }
  return parse(root, res.stdout)
}

function keyOf(v: NudgeView): string {
  return JSON.stringify(v)
}

async function refresh($: Dollar): Promise<Outcome> {
  let outcome: Outcome
  try {
    outcome = await evaluate($)
  } catch (err) {
    outcome = fail(await $.session.cwd(), 'project-nudge itself failed', [errorText(err)])
  }
  const before = await read($, view)
  await update($, view, () => outcome.view)
  if (outcome.view.kind === 'error' && keyOf(before) !== keyOf(outcome.view)) {
    $.ui.toast(`nudge: ${outcome.view.summary}`)
  }
  return outcome
}

// A launch may raise both session.start and classic.SessionStart, and a hot
// reload raises only session.start. The first of them runs the script; the
// second takes that run's outcome instead of running it again. A finished turn
// clears it, so a later classic.SessionStart (a /clear) runs the script afresh.
let launch: Promise<Outcome> | null = null

function startOnce($: Dollar): Promise<Outcome> {
  if (launch !== null) {
    const shared = launch
    launch = null
    return shared
  }
  launch = refresh($)
  return launch
}

// After a turn the script runs in the background, so a slow script never holds
// up the turn's end or a queued message. Turns that end while it runs ask for
// one more run when it finishes, not one each.
let running: Promise<void> | null = null
let again = false

function refreshSoon($: Dollar): Promise<void> {
  if (running !== null) {
    again = true
    return running
  }
  running = (async () => {
    do {
      again = false
      await refresh($)
    } while (again)
  })().finally(() => {
    running = null
  })
  return running
}

async function dismiss($: Dollar) {
  const v = await read($, view)
  await update($, dismissed, () => keyOf(v))
}

async function decide($: Dollar, root: string, answer: 'allow' | 'never', expected: Hashes | null) {
  let saved: boolean
  try {
    saved = await remember($, root, answer, expected)
  } catch (err) {
    await update($, view, () => fail(root, 'could not save the answer', [errorText(err)]).view)
    return
  }
  if (!saved) $.ui.toast('nudge: the files changed after this band appeared; look again before allowing')
  await refresh($)
}

// ---- hooks -----------------------------------------------------------------

export const register: Register = on => {
  // Launch, /clear, resume and compaction: hand the script's context to Claude.
  on('classic.SessionStart', async ($, e, next) => {
    const result = await next(e)
    const { context } = await startOnce($)
    if (!context) return result
    return { ...result, additionalContext: [...(result.additionalContext ?? []), context] }
  }).catch(($, e, next) => next(e)) // never let the nudge hold up a session's start

  // Not awaited: only classic.SessionStart needs the outcome, for its context.
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    void startOnce($)
    return result
  })

  // A finished main-loop turn may have changed what the script would say. A
  // subagent's turns end here too; they don't move the band, so they don't run
  // it. Not awaited, so the turn ends without waiting for the script.
  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId === undefined) {
      launch = null
      void refreshSoon($)
    }
    return result
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const v = await read($, view)
    if (e.props.hasSurvey || v.kind === 'none' || (await read($, dismissed)) === keyOf(v)) {
      return next(e)
    }
    const { Box, Button, Text } = $.ui.resolve(e)

    if (v.kind === 'ask' || v.kind === 'changed') {
      const asking = v.kind === 'ask'
      const list = v.files.join(', ')
      const message = asking
        ? `${v.root} has a nudge script. Run it at session start and after each turn? Trusts: ${list}`
        : `The nudge script for ${v.root} changed since you allowed it (${v.changed.join(', ')}). It will not run until you approve it again.`
      const viewText = asking
        ? `Show me these files in ${v.root} and tell me what the nudge script does, before I allow it: ${list}`
        : `In ${v.root}, show me what changed in ${v.changed.join(', ')}${v.since ? ` since commit ${v.since} (committed and uncommitted)` : ''}, and tell me whether the nudge script is still safe to run.`
      return (
        <Box flexDirection="column" borderStyle="round" borderColor={ACCENT} paddingX={1}>
          <Text color={ACCENT} bold>
            {asking ? '⚑ NUDGE' : '⚑ NUDGE CHANGED'}
          </Text>
          <Text>{message}</Text>
          <Box gap={2} marginTop={1}>
            <Button
              key="view"
              hotkey="v"
              label={asking ? 'View script' : 'View changes'}
              onPress={() => $.prompt.fill({ text: viewText, mode: 'replace' })}
            />
            <Button key="allow" variant="primary" hotkey="a" label="Allow" onPress={() => decide($, v.root, 'allow', v.hashes)} />
            <Button key="never" hotkey="x" label="Never for this repo" onPress={() => decide($, v.root, 'never', null)} />
            <Button key="later" hotkey="n" label="Not now" onPress={() => dismiss($)} />
          </Box>
          <Text dimColor>{HINT}</Text>
        </Box>
      )
    }

    if (v.kind === 'error') {
      return (
        <Box flexDirection="column" borderStyle="round" borderColor={ERROR} paddingX={1}>
          <Box>
            <Text color={ERROR} bold>
              ⚠ NUDGE ERROR{'  '}
            </Text>
            <Text bold>{v.summary}</Text>
          </Box>
          {v.detail.map((line: string, i: number) => (
            <Text key={`d${i}`} dimColor>
              {line}
            </Text>
          ))}
          <Box gap={2} marginTop={1}>
            <Button
              key="look"
              variant="primary"
              hotkey="i"
              label="Investigate"
              onPress={() =>
                $.prompt.fill({
                  text: `The nudge script at ${v.root}/${RUN} failed: ${v.summary}${v.detail.length ? `\n\n${v.detail.join('\n')}` : ''}\n\nInvestigate and fix it.`,
                  mode: 'replace',
                })
              }
            />
            {v.setup && (
              <Button
                key="setup"
                hotkey="s"
                label={`Fix with ${SETUP}`}
                onPress={() => $.prompt.fill({ text: `${SETUP} ${v.summary}`, mode: 'replace' })}
              />
            )}
            <Button key="hide" hotkey="n" label="Dismiss" onPress={() => dismiss($)} />
          </Box>
          <Text dimColor>{HINT}</Text>
        </Box>
      )
    }

    const [headline, ...rest] = v.lines
    const cmd = v.command
    return (
      <Box flexDirection="column" borderStyle="round" borderColor={ACCENT} paddingX={1}>
        <Box>
          <Text color={ACCENT} bold>
            ⚑ {v.title.toUpperCase()}
            {'  '}
          </Text>
          <Text bold>{headline}</Text>
        </Box>
        {rest.map((line: string, i: number) => (
          <Text key={`l${i}`}>{line}</Text>
        ))}
        <Box gap={2} marginTop={1}>
          {cmd !== null && (
            <Button
              key="go"
              variant="primary"
              hotkey="l"
              label={`Load ${cmd}`}
              onPress={async () => {
                await $.prompt.fill({ text: cmd, mode: 'replace' })
                await dismiss($)
              }}
            />
          )}
          <Button key="hide" hotkey="n" label="Not now" onPress={() => dismiss($)} />
        </Box>
        <Text dimColor>{HINT}</Text>
      </Box>
    )
  })
}
