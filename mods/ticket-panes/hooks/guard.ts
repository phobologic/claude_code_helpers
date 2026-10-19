import type { EngineInterface, FsStat, On } from 'claude-code'

import { knownRole, resolveRole, role } from './role'
import type { Role } from './role'
import { unfinishedRunFor } from './runs'

// The side agent's tool guard (D5, D6, E16). In a side session (R4) it refuses what the side
// agent may not do: write outside the session root's `.tmp/`, make or publish commits, and, while
// its ticket is in a running /run-tickets run (R2), use tk beyond reading tickets, adding notes
// and filing follow-ups under the backlog epic. In a main session every call goes on untouched.
// It is a guard against mistakes, not a sandbox: it reads what a call names, and Bash text only
// as far as E16 says.

// What a guard that failed answers in a side session.
const GUARD_FAILED = 'ticket side agent guard failed'

// The tk subcommands a side agent may run while its ticket is in a running run (D6, E16), with
// `--help` and `-h`, which tk runs as `help`. `dep tree`, `dep cycle` and a `create` under the
// backlog epic are allowed too (tkUseOf).
const TK_ALLOWED = new Set([
  'show',
  'ls',
  'list',
  'query',
  'ready',
  'blocked',
  'closed',
  'help',
  '--help',
  '-h',
  'add-note',
  'backlog',
  'show-multi',
  'epic-status',
  'epic-tree',
  'triage',
])
const TK_DEP_ALLOWED = new Set(['tree', 'cycle'])
// The options of `tk create` that take the next word as their value, as tk's cmd_create reads
// them, so a value is never read as `--parent`.
const TK_CREATE_VALUE_OPTIONS = new Set([
  '-d',
  '--description',
  '--design',
  '--acceptance',
  '-p',
  '--priority',
  '-t',
  '--type',
  '-a',
  '--assignee',
  '--external-ref',
  '--parent',
  '--tags',
])

// The git subcommands that make or publish commits: always refused in a side session (E16).
const GIT_DENIED = new Set(['commit', 'push', 'merge', 'revert', 'cherry-pick', 'am', 'rebase'])
// git's global options that may take their value as the next word. Any other word before the
// subcommand that starts with `-` (`--no-pager`, `--git-dir=<dir>`, `-p`) is an option alone.
const GIT_VALUE_OPTIONS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--super-prefix', '--config-env'])

// A word that sets a variable for the command after it (`ID=...`), read after quote removal.
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/
// What a tk id can be, as tickets.ts reads one; an empty answer from `tk backlog` is none.
const TICKET_ID = /^[A-Za-z0-9._-]+$/

const BACKLOG_TIMEOUT_MS = 10_000

// ---------- Bash text (E16) ----------

// The simple commands in Bash text, each as its words with quotes removed: split on newlines,
// `;`, `&&`, `||`, `|`, `|&`, a lone `&` and the parentheses of a group, with the commands
// inside every `$(...)` and backtick group (unquoted or in double quotes) listed as well. A word
// holding a substitution keeps the substitution's text. A `#` that starts a word comments out
// the rest of its line. Undefined when the text can't be split: a quote, `$(` or backtick left
// open. Heredocs are not told apart, so a heredoc's lines are read as commands too (E16).
export function commandsIn(text: string): string[][] | undefined {
  const out: string[][] = []
  return scan(text, 0, false, out) === undefined ? undefined : out
}

// Scans `text` from `from`, adding each command it ends to `out`. Inside a `$(...)` (`isInner`)
// it stops after the `)` that closes it and answers the index after it; at the top it reads to
// the end. Undefined when the text can't be split.
function scan(text: string, from: number, isInner: boolean, out: string[][]): number | undefined {
  let words: string[] = []
  let word: string | undefined
  let depth = 0
  const endWord = () => {
    if (word !== undefined) words.push(word)
    word = undefined
  }
  const endCommand = () => {
    endWord()
    if (words.length > 0) out.push(words)
    words = []
  }
  const add = (part: string) => {
    word = (word ?? '') + part
  }
  let i = from
  while (i < text.length) {
    const c = text[i] ?? ''
    const after = text[i + 1] ?? ''
    if (c === '\\') {
      // A backslash and newline join two lines; any other character after it is taken as is.
      if (after !== '\n') add(after)
      i += 2
    } else if (c === "'") {
      const close = text.indexOf("'", i + 1)
      if (close < 0) return undefined
      add(text.slice(i + 1, close))
      i = close + 1
    } else if (c === '"') {
      const close = doubleQuoted(text, i + 1, out)
      if (close === undefined) return undefined
      add(close.text)
      i = close.end
    } else if (c === '$' && after === '(') {
      const end = scan(text, i + 2, true, out)
      if (end === undefined) return undefined
      add(text.slice(i, end))
      i = end
    } else if (c === '`') {
      const end = backticks(text, i, out)
      if (end === undefined) return undefined
      add(text.slice(i, end))
      i = end
    } else if (c === '#' && word === undefined) {
      const eol = text.indexOf('\n', i)
      i = eol < 0 ? text.length : eol
    } else if (c === ' ' || c === '\t') {
      endWord()
      i += 1
    } else if (c === '\n' || c === ';') {
      endCommand()
      i += 1
    } else if (c === '&' || c === '|') {
      // `&&`, `||`, `|&` (each character ending the command in turn), or one `&` or `|`. An `&`
      // in a redirection (`2>&1`, `&>file`) is part of its word.
      const before = text[i - 1] ?? ''
      if (c === '&' && after !== '&' && (before === '>' || before === '<' || after === '>')) add(c)
      else endCommand()
      i += 1
    } else if (c === '(') {
      endCommand()
      depth += 1
      i += 1
    } else if (c === ')') {
      endCommand()
      i += 1
      if (depth > 0) depth -= 1
      else if (isInner) return i
    } else {
      add(c)
      i += 1
    }
  }
  if (isInner) return undefined
  endCommand()
  return i
}

// A double-quoted string from just after its opening quote: its text with quotes removed, and the
// index after its closing quote. A `$(...)` or backtick group inside it is scanned for commands
// and kept as text. Undefined when the string, or a group in it, is left open.
function doubleQuoted(text: string, from: number, out: string[][]): { text: string; end: number } | undefined {
  let value = ''
  let i = from
  while (i < text.length) {
    const c = text[i] ?? ''
    const after = text[i + 1] ?? ''
    if (c === '"') return { text: value, end: i + 1 }
    if (c === '\\' && '"\\$`\n'.includes(after)) {
      if (after !== '\n') value += after
      i += 2
    } else if (c === '$' && after === '(') {
      const end = scan(text, i + 2, true, out)
      if (end === undefined) return undefined
      value += text.slice(i, end)
      i = end
    } else if (c === '`') {
      const end = backticks(text, i, out)
      if (end === undefined) return undefined
      value += text.slice(i, end)
      i = end
    } else {
      value += c
      i += 1
    }
  }
  return undefined
}

// A backtick group at `at`: scans its commands (with `\``, `\\` and `\$` unescaped, as the shell
// reads them) and answers the index after its closing backtick; undefined when it is left open.
function backticks(text: string, at: number, out: string[][]): number | undefined {
  let inner = ''
  let i = at + 1
  while (i < text.length && text[i] !== '`') {
    const c = text[i] ?? ''
    const after = text[i + 1] ?? ''
    if (c === '\\') {
      inner += after === '`' || after === '\\' || after === '$' ? after : c + after
      i += 2
    } else {
      inner += c
      i += 1
    }
  }
  if (i >= text.length) return undefined
  return scan(inner, 0, false, out) === undefined ? undefined : i + 1
}

function basename(word: string): string {
  return word.slice(word.lastIndexOf('/') + 1)
}

// A command's words from its name on: `(`, `{` and `!` stripped from the front, and variable
// assignments and `env` (with the assignments after it) passed over.
function fromName(words: readonly string[]): string[] {
  const rest = [...words]
  while (rest.length > 0) {
    const head = (rest[0] ?? '').replace(/^[({!]+/, '')
    if (head !== '' && !ASSIGNMENT.test(head) && basename(head) !== 'env') {
      rest[0] = head
      break
    }
    rest.shift()
  }
  return rest
}

// The commit-making git subcommand a command runs, or undefined when it runs none: git found by
// its basename, its global options passed over.
export function deniedGitOf(words: readonly string[]): string | undefined {
  const cmd = fromName(words)
  if (basename(cmd[0] ?? '') !== 'git') return undefined
  let at = 1
  while ((cmd[at] ?? '').startsWith('-')) at += GIT_VALUE_OPTIONS.has(cmd[at] ?? '') ? 2 : 1
  const sub = cmd[at] ?? ''
  return GIT_DENIED.has(sub) ? sub : undefined
}

// A tk command that the allow-list does not let through by itself: how the refusal names it and,
// for `create`, the parent it files under (undefined without one). Undefined for a command that
// is not tk, and for one the allow-list takes: tk found by its basename, `tk super <sub>` read as
// `<sub>`, a bare `tk` being its help.
export type TkUse = { label: string; parent?: string }

export function tkUseOf(words: readonly string[]): TkUse | undefined {
  const cmd = fromName(words)
  if (basename(cmd[0] ?? '') !== 'tk') return undefined
  const at = cmd[1] === 'super' ? 2 : 1
  const sub = cmd[at]
  if (sub === undefined || TK_ALLOWED.has(sub)) return undefined
  if (sub === 'dep' && TK_DEP_ALLOWED.has(cmd[at + 1] ?? '')) return undefined
  if (sub === 'create') return { label: 'tk create', parent: createParent(cmd.slice(at + 1)) }
  return { label: `tk ${sub}` }
}

// The `--parent` a `tk create` names, read as tk reads its arguments: each option that takes a
// value takes the next word, and the last `--parent` wins.
function createParent(args: readonly string[]): string | undefined {
  let parent: string | undefined
  let i = 0
  while (i < args.length) {
    const arg = args[i] ?? ''
    if (arg === '--parent') parent = args[i + 1]
    i += TK_CREATE_VALUE_OPTIONS.has(arg) ? 2 : 1
  }
  return parent
}

// ---------- the refusals ----------

function writeReason(ticket: string, tmp: string, path: string): string {
  return `This is the side agent for ticket ${ticket}: it may write files only under \`.tmp/\` (${tmp}), and ${path} is not there. Other changes are for the main session.`
}

function gitReason(ticket: string, sub: string): string {
  return `This is the side agent for ticket ${ticket}: it may not make or publish commits, so \`git ${sub}\` is refused here. Commits are for the main session.`
}

function tkReason(ticket: string, runId: string, label: string, backlog: string | undefined): string {
  const followUps =
    backlog === undefined
      ? '`tk create ... --parent <backlog id>`, the id `tk backlog` prints; when there is no backlog epic, `tk backlog ensure` makes one'
      : `\`tk create ... --parent ${backlog}\``
  return [
    `This is the side agent for ticket ${ticket}, which is in the running /run-tickets run ${runId}, so \`${label}\` is refused while the run lasts.`,
    'Allowed: reading tickets (tk show, ls, list, query, ready, blocked, closed, help, show-multi, epic-status, epic-tree, triage, dep tree, dep cycle),',
    `notes (\`tk add-note ${ticket} ...\`), and follow-ups under the backlog epic (${followUps}).`,
  ].join(' ')
}

// ---------- the checks ----------

// The side ticket of a role, or undefined when it is not a side session's: the kind decides, and
// a side role names its ticket (as side.ts reads it).
function sideTicketOf(known: Role): string | undefined {
  return known.kind === 'side' && known.sideTicket ? known.sideTicket : undefined
}

async function statOf($: EngineInterface, path: string): Promise<FsStat | undefined> {
  try {
    return await $.fs.stat(path, { resolve: true })
  } catch {
    return undefined // not there
  }
}

// Where an absolute path lands: the real path of its nearest existing ancestor (the path itself
// included) followed by the rest of the path. Undefined when it can't be placed: a path that is
// not absolute (a `~` included), one with a `..` in it, or an ancestor that exists but leads
// nowhere (a dangling link), which the tool would follow. This build's `$.fs.stat` folds `.` and
// `..` by spelling before it looks; the folding and the `..` refusal here keep the answer the same
// for a stat that does not.
export async function placeOf($: EngineInterface, path: string): Promise<string | undefined> {
  if (!path.startsWith('/')) return undefined
  const parts = path.split('/').filter(part => part !== '' && part !== '.')
  if (parts.includes('..')) return undefined
  for (let n = parts.length; n >= 0; n -= 1) {
    const stat = await statOf($, `/${parts.slice(0, n).join('/')}`)
    if (stat === undefined) continue
    if (stat.realPath === undefined) return undefined
    return `/${[...stat.realPath.split('/').filter(part => part !== ''), ...parts.slice(n)].join('/')}`
  }
  return undefined
}

// The refusal for an Edit, Write or NotebookEdit on `path`, or undefined when the path lands
// inside the session root's `.tmp/`, both resolved (D5). A root that can't be read throws.
async function judgeWrite($: EngineInterface, ticket: string, path: string): Promise<string | undefined> {
  const root = await $.session.root()
  const base = await placeOf($, root)
  const place = await placeOf($, path)
  const isInside = base !== undefined && place !== undefined && place.startsWith(`${base.replace(/\/$/, '')}/.tmp/`)
  return isInside ? undefined : writeReason(ticket, `${root.replace(/\/$/, '')}/.tmp/`, path)
}

// The backlog epic's id (`tk backlog`, run in the session root), or undefined when there is none
// or it can't be told.
async function backlogId($: EngineInterface): Promise<string | undefined> {
  try {
    const cwd = await $.session.root()
    const out = await $.process.run(['tk', 'backlog'], { cwd, timeoutMs: BACKLOG_TIMEOUT_MS })
    const id = out.stdout.trim()
    return out.exitCode === 0 && TICKET_ID.test(id) ? id : undefined
  } catch {
    return undefined
  }
}

// The refusal for a Bash command, or undefined when it may run (E16). A commit-making git
// subcommand is refused whatever the run. A tk command the allow-list doesn't take is refused only
// while the side ticket is in a running run (R2); a lookup that fails counts as not in one. Text
// that can't be split runs.
async function judgeBash($: EngineInterface, ticket: string, command: string): Promise<string | undefined> {
  const commands = commandsIn(command)
  if (commands === undefined) return undefined
  const uses: TkUse[] = []
  for (const words of commands) {
    const sub = deniedGitOf(words)
    if (sub !== undefined) return gitReason(ticket, sub)
    const use = tkUseOf(words)
    if (use !== undefined) uses.push(use)
  }
  if (uses.length === 0) return undefined
  const lookup = await unfinishedRunFor($, ticket)
  if (!('runId' in lookup)) return undefined
  const backlog = await backlogId($)
  for (const use of uses) {
    if (backlog !== undefined && use.parent === backlog) continue
    return tkReason(ticket, lookup.runId, use.label, backlog)
  }
  return undefined
}

// Whether a guard that failed refuses its call: in a side session it does. The role is the one
// this load resolved; before one is, the one R4's owner resolves now (role.ts).
export async function isSideOnFailure($: EngineInterface): Promise<boolean> {
  const known = knownRole() ?? (await resolveRole($))
  return known !== undefined && sideTicketOf(known) !== undefined
}

// The guard's `.catch`: a call it already let through goes on as it went (`next` replays it);
// otherwise a side session refuses the call and a main one lets it run. A main session's guard
// calls `next` before anything that can throw, so only this function reaches its second branch.
export async function onGuardFailure<E, R>(
  $: EngineInterface,
  e: E,
  next: { (e: E): Promise<R>; readonly called: boolean },
): Promise<R | { deny: string }> {
  if (next.called) return next(e)
  return (await isSideOnFailure($)) ? { deny: GUARD_FAILED } : next(e)
}

// This module's hooks, registered by register.tsx.
export function registerGuard(on: On): void {
  on('tool.call', { tool: ['Edit', 'Write', 'NotebookEdit', 'Bash'] }, async ($, e, next) => {
    const ticket = sideTicketOf(await role($))
    if (ticket === undefined) return next(e)
    const reason =
      e.tool === 'Bash'
        ? await judgeBash($, ticket, e.command)
        : await judgeWrite($, ticket, e.tool === 'NotebookEdit' ? e.notebook_path : e.file_path)
    return reason === undefined ? next(e) : { deny: reason }
  }).catch(($, e, next) => onGuardFailure($, e, next))
}

// This module's ready step: register.tsx's `runReady` calls it once per load, when the role is
// first known, possibly inside a draw, so it may start timers but never write `$.state`. The
// guard needs none: it resolves the role on each call.
export async function guardReady($: EngineInterface, known: Role): Promise<void> {}
