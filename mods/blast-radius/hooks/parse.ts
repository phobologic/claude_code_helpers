// Blast Radius, part 1: reads a shell command line and lists what it could destroy.
//
// Text only, no filesystem: each effect names its paths as the shell would after the
// expansions this file can do (quotes, variables set earlier on the line, `cd` along the
// line, $HOME, mktemp). bin/judge.py then expands globs, resolves links and asks git
// what is at stake. A path this file cannot know becomes an `unknown` effect, which the
// judge always holds.
//
// Following `cd`, `pushd`/`popd` and `( ... )` scopes along a line is an idea from the
// Blast Radius mod in anthropics/claude-code-playground (Apache-2.0).

// Where a command runs: null for the shell's working directory, else a path relative to
// it or absolute (placeholders allowed).
export type Dir = string | null

export type Effect =
  | { op: 'delete'; dir: Dir; paths: string[]; recursive: boolean; cmd: string }
  | { op: 'overwrite'; dir: Dir; paths: string[]; cmd: string }
  | {
      op: 'copy'
      dir: Dir
      mode: 'mv' | 'cp' | 'ln'
      sources: string[]
      dest: string[]
      intoDir: boolean
      noTargetDir: boolean
      noClobber: boolean
      cmd: string
    }
  | { op: 'find'; dir: Dir; argv: string[]; recursive: boolean; cmd: string }
  | { op: 'git'; dir: Dir; argv: string[]; cmd: string }
  | { op: 'unknown'; what: string; cmd: string }

// Values only the judge knows, by name: judge.py substitutes them. The control
// characters keep them apart from anything a command could spell.
export const ph = (name: string): string => `\u0001${name}\u0001`
const ENV_VARS = new Set(['HOME', 'TMPDIR', 'USER'])

const DELETE_CMDS = new Set(['rm', 'grm', 'unlink', 'shred', 'srm'])
const COPY_CMDS: Record<string, 'mv' | 'cp' | 'ln'> = {
  mv: 'mv', gmv: 'mv', cp: 'cp', gcp: 'cp', install: 'cp', ginstall: 'cp', ln: 'ln', gln: 'ln',
}
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh'])
const INTERPRETERS = /^(python[0-9.]*|pypy[0-9.]*|node|nodejs|perl|ruby|deno|bun|php|osascript)$/
// Inline code that deletes files: unknown, since its targets are only known when it runs.
const CODE_DELETES =
  /rmtree|unlink|\brmSync|\brmdir|rimraf|remove_dir_all|removedirs|os\.remove|Deno\.remove|FileUtils\.rm|File\.delete|\bfs\.rm\b|promises\.rm\b|shutil\.move|send2trash|\brm\s+-|['"]rm['"]/
// Where a write loses nothing: the null device, the terminal and the command's own
// streams. Any other /dev path (a disk, say) goes to the judge like any other file.
const SINK = /\/dev\/(?:null|stdout|stderr|tty|fd\/[0-9]+)/
const SINK_PATH = new RegExp(`^${SINK.source}$`)
const isSink = (p: string): boolean => SINK_PATH.test(p)
// Text that could delete or clobber, for a command whose words cannot be expanded.
const DESTRUCTIVE = new RegExp(
  String.raw`\b(rm|unlink|shred|rmtree|truncate|dd)\b|-delete\b|>(?![>&]|\s*${SINK.source}(?=[\s;&|()<>'"\`]|$))`,
)
// Command text that can't be expanded and could do anything: it looks destructive, or
// the command itself is a variable or substitution (`sh -c "$CMD"`).
const opaque = (raw: string): boolean => DESTRUCTIVE.test(raw) || /^["']?(\$|`)/.test(raw.trim())

const MAX_VALUES = 64
const MAX_DEPTH = 4

// ---------- lexing ----------

type Part =
  | { kind: 'lit'; text: string; quoted: boolean }
  | { kind: 'var'; name: string; quoted: boolean }
  | { kind: 'sub'; inner: string; arith: boolean }
interface Word {
  parts: Part[]
  raw: string
}
interface Redir {
  op: string
  target: Word | null
  // quoted: any part of the delimiter is quoted, so bash leaves the body as written.
  heredoc?: { delim: string; strip: boolean; quoted: boolean; body: string }
}
type Tok = ({ t: 'word'; w: Word } | { t: 'op'; op: string } | { t: 'redir'; r: Redir }) & {
  start: number
  end: number
}

const OPS = ['&&', '||', ';;', '|&', '&', '|', ';', '(', ')']
const REDIR = /^(\d*)(&>>|&>|>>|>\||>&|>|<<<|<<-|<<|<>|<&|<)/
const WORD_END = /[ \t\r\n;&|()<>]/

function lex(s: string): Tok[] {
  const toks: Tok[] = []
  const pending: Redir[] = []
  let i = 0
  while (i < s.length) {
    const c = s[i] as string
    const start = i
    if (c === ' ' || c === '\t' || c === '\r') {
      i += 1
    } else if (c === '\\' && s[i + 1] === '\n') {
      i += 2
    } else if (c === '\n') {
      toks.push({ t: 'op', op: ';', start, end: i + 1 })
      i += 1
      for (const r of pending) i = readHeredoc(s, i, r)
      pending.length = 0
    } else if (c === '#') {
      while (i < s.length && s[i] !== '\n') i += 1
    } else if ((c === '<' || c === '>') && s[i + 1] === '(') {
      // Process substitution: a word whose command runs.
      const end = closeParen(s, i + 2)
      const sub: Part = { kind: 'sub', inner: s.slice(i + 2, Math.max(i + 2, end - 1)), arith: false }
      toks.push({ t: 'word', w: { parts: [sub], raw: s.slice(i, end) }, start, end })
      i = end
    } else {
      const m = REDIR.exec(s.slice(i, i + 12))
      if (m) {
        i += m[0].length
        while (s[i] === ' ' || s[i] === '\t') i += 1
        const r: Redir = { op: m[2] as string, target: null }
        if (i < s.length && !WORD_END.test(s[i] as string)) {
          const w = readWord(s, i)
          r.target = w.word
          i = w.end
        }
        if (r.op === '<<' || r.op === '<<-') {
          const quoted = /['"\\]/.test(r.target?.raw ?? '')
          r.heredoc = { delim: r.target ? litText(r.target) : '', strip: r.op === '<<-', quoted, body: '' }
          pending.push(r)
        }
        toks.push({ t: 'redir', r, start, end: i })
        continue
      }
      const op = OPS.find(o => s.startsWith(o, i))
      if (op) {
        toks.push({ t: 'op', op, start, end: i + op.length })
        i += op.length
        continue
      }
      const w = readWord(s, i)
      toks.push({ t: 'word', w: w.word, start, end: w.end })
      i = Math.max(w.end, i + 1)
    }
  }
  return toks
}

function readHeredoc(s: string, i: number, r: Redir): number {
  const doc = r.heredoc
  if (!doc) return i
  const lines: string[] = []
  while (i < s.length) {
    const nl = s.indexOf('\n', i)
    const end = nl < 0 ? s.length : nl
    const line = s.slice(i, end)
    i = nl < 0 ? s.length : nl + 1
    if ((doc.strip ? line.replace(/^\t+/, '') : line) === doc.delim) break
    lines.push(line)
  }
  doc.body = lines.join('\n')
  return i
}

// An unquoted heredoc's body is expanded as a double-quoted string is, except that `"` is
// plain text in it. Its $( ) and ` ` run before the command reads it.
function heredocSubs(body: string): Part[] {
  const parts: Part[] = []
  for (let i = 0; i < body.length; ) i = readDouble(body, i, parts, () => {})
  return parts
}

// The text a shell or interpreter reading an unquoted heredoc gets, as far as escapes go:
// bash drops `\` before `\`, `$` and `` ` ``, and joins lines ending in `\`. A `\\` just
// before an expansion goes too, so the reader still expands it: in bash the expansion's
// value is what it reads there, after a `\` that quotes nothing in a path.
function heredocText(body: string): string {
  return body.replace(/\\\\(?=[$`])|\\([\\$`\n])/g, (_, c?: string) => (c === undefined || c === '\n' ? '' : c))
}

function readWord(s: string, start: number): { word: Word; end: number } {
  const parts: Part[] = []
  const lit = (text: string, quoted: boolean): void => {
    const last = parts[parts.length - 1]
    if (last && last.kind === 'lit' && last.quoted === quoted) last.text += text
    else parts.push({ kind: 'lit', text, quoted })
  }
  let i = start
  while (i < s.length) {
    const c = s[i] as string
    if (WORD_END.test(c)) break
    if (c === '\\') {
      if (s[i + 1] !== '\n' && i + 1 < s.length) lit(s[i + 1] as string, true)
      i += 2
    } else if (c === "'") {
      const j = s.indexOf("'", i + 1)
      const end = j < 0 ? s.length : j
      lit(s.slice(i + 1, end), true)
      i = end + 1
    } else if (c === '"') {
      i = readDouble(s, i + 1, parts, lit)
    } else if (c === '$') {
      i = readDollar(s, i, parts, lit, false)
    } else if (c === '`') {
      const end = closeBacktick(s, i + 1)
      parts.push({ kind: 'sub', inner: s.slice(i + 1, Math.max(i + 1, end - 1)).replace(/\\`/g, '`'), arith: false })
      i = end
    } else {
      lit(c, false)
      i += 1
    }
  }
  return { word: { parts, raw: s.slice(start, i) }, end: i }
}

type Lit = (text: string, quoted: boolean) => void

function readDouble(s: string, i: number, parts: Part[], lit: Lit): number {
  while (i < s.length && s[i] !== '"') {
    const c = s[i] as string
    if (c === '\\' && i + 1 < s.length) {
      const n = s[i + 1] as string
      if (n === '\n') {
        i += 2
      } else if ('$`"\\'.includes(n)) {
        lit(n, true)
        i += 2
      } else {
        lit('\\', true)
        i += 1
      }
    } else if (c === '$') {
      i = readDollar(s, i, parts, lit, true)
    } else if (c === '`') {
      const end = closeBacktick(s, i + 1)
      parts.push({ kind: 'sub', inner: s.slice(i + 1, Math.max(i + 1, end - 1)), arith: false })
      i = end
    } else {
      lit(c, true)
      i += 1
    }
  }
  return i + 1
}

function readDollar(s: string, i: number, parts: Part[], lit: Lit, quoted: boolean): number {
  const n = s[i + 1]
  if (n === '(' && s[i + 2] === '(') {
    const end = closeParen(s, i + 3, 2)
    parts.push({ kind: 'sub', inner: s.slice(i + 3, Math.max(i + 3, end - 2)), arith: true })
    return end
  }
  if (n === '(') {
    const end = closeParen(s, i + 2)
    parts.push({ kind: 'sub', inner: s.slice(i + 2, Math.max(i + 2, end - 1)), arith: false })
    return end
  }
  if (n === '{') {
    const end = closeBrace(s, i + 2)
    const expr = s.slice(i + 2, Math.max(i + 2, end - 1))
    parts.push({ kind: 'var', name: /^[A-Za-z_][A-Za-z0-9_]*$/.test(expr) ? expr : `{${expr}}`, quoted })
    return end
  }
  if (n === "'" && !quoted) {
    // $'...': ANSI-C quoting, kept as a quoted literal (escapes are not decoded).
    let j = i + 2
    while (j < s.length && s[j] !== "'") j += s[j] === '\\' ? 2 : 1
    lit(s.slice(i + 2, j), true)
    return j + 1
  }
  if (n === '"' && !quoted) return readDouble(s, i + 2, parts, lit)
  const m = /^([A-Za-z_][A-Za-z0-9_]*|[0-9@*#?$!-])/.exec(s.slice(i + 1))
  if (m) {
    parts.push({ kind: 'var', name: m[1] as string, quoted })
    return i + 1 + (m[1] as string).length
  }
  lit('$', quoted)
  return i + 1
}

// Each returns the index just past its closer (or the end of the text when unclosed).
function closeParen(s: string, j: number, depth = 1): number {
  const heredocs: string[] = [] // delimiters whose bodies start at the next line
  while (j < s.length) {
    const c = s[j]
    if (c === '\\') {
      j += 2
      continue
    }
    if (c === '<' && s[j + 1] === '<' && s[j + 2] !== '<') {
      const m = /^<<-?\s*(['"]?)([A-Za-z0-9_.-]+)\1/.exec(s.slice(j))
      if (m) {
        heredocs.push(m[2] as string)
        j += m[0].length
        continue
      }
    }
    if (c === '\n' && heredocs.length > 0) {
      // A heredoc's body is text: quotes and parens in it close nothing.
      j += 1
      for (const delim of heredocs) {
        while (j < s.length) {
          const nl = s.indexOf('\n', j)
          const line = s.slice(j, nl < 0 ? s.length : nl)
          j = nl < 0 ? s.length : nl + 1
          if (line.replace(/^\t+/, '') === delim) break
        }
      }
      heredocs.length = 0
      continue
    }
    if (c === "'") {
      const k = s.indexOf("'", j + 1)
      j = k < 0 ? s.length : k + 1
      continue
    }
    if (c === '"') {
      j = skipDouble(s, j + 1)
      continue
    }
    if (c === '`') {
      j = closeBacktick(s, j + 1)
      continue
    }
    if (c === '(') depth += 1
    if (c === ')') {
      depth -= 1
      if (depth === 0) return j + 1
    }
    j += 1
  }
  return s.length
}

function closeBrace(s: string, j: number): number {
  let depth = 1
  while (j < s.length) {
    const c = s[j]
    if (c === '\\') {
      j += 2
      continue
    }
    if (c === "'") {
      const k = s.indexOf("'", j + 1)
      j = k < 0 ? s.length : k + 1
      continue
    }
    if (c === '"') {
      j = skipDouble(s, j + 1)
      continue
    }
    if (c === '{') depth += 1
    if (c === '}') {
      depth -= 1
      if (depth === 0) return j + 1
    }
    j += 1
  }
  return s.length
}

function skipDouble(s: string, j: number): number {
  while (j < s.length && s[j] !== '"') {
    if (s[j] === '\\') j += 2
    else if (s[j] === '$' && s[j + 1] === '(') j = closeParen(s, j + 2)
    else if (s[j] === '`') j = closeBacktick(s, j + 1)
    else j += 1
  }
  return j + 1
}

function closeBacktick(s: string, j: number): number {
  while (j < s.length && s[j] !== '`') j += s[j] === '\\' ? 2 : 1
  return j + 1
}

function litText(w: Word): string {
  return w.parts.map(p => (p.kind === 'lit' ? p.text : p.kind === 'var' ? `$${p.name}` : '')).join('')
}

// The word's text when it is all literal, else null.
function text(w: Word | undefined): string | null {
  if (!w || w.parts.some(p => p.kind !== 'lit')) return null
  return w.parts.map(p => (p.kind === 'lit' ? p.text : '')).join('')
}

// ---------- expansion ----------

type DirState = string | null | { unknown: string }
interface Val {
  text: string
  pattern: boolean // glob characters in it stay globs even where the variable is quoted
}
type VarValue = { values: Val[] } | { unknown: string }
type Expanded = { values: string[] } | { unknown: string }

interface Ctx {
  dir: DirState
  vars: Map<string, VarValue>
  pushed: DirState[]
  out: Effect[]
  depth: number
}

export function escapeGlob(s: string): string {
  return s.replace(/[*?[]/g, c => `[${c}]`)
}

export const isAbs = (p: string): boolean => p.startsWith('/') || p.startsWith('~') || p.startsWith('\u0001')
const isUnknown = (d: DirState): d is { unknown: string } => d !== null && typeof d === 'object'
const short = (s: string): string => (s.length > 60 ? `${s.slice(0, 57)}...` : s).replace(/\s+/g, ' ')

// The directory a command runs in as an absolute path, for $PWD and $(pwd).
function absDir(dir: DirState): string | null {
  if (isUnknown(dir)) return null
  if (dir === null) return ph('BR_CWD')
  return isAbs(dir) ? dir : `${ph('BR_CWD')}/${dir}`
}

function joinDir(dir: DirState, arg: string): DirState {
  if (isAbs(arg)) return arg
  // A fresh object: a folder that moved never compares equal to the one it moved from.
  if (isUnknown(dir)) return { unknown: dir.unknown }
  return dir === null ? arg : `${dir}/${arg}`
}

function subValue(p: Extract<Part, { kind: 'sub' }>, ctx: Ctx): string | null {
  const inner = p.inner.trim()
  // mktemp with no template, or a bare -t prefix, makes its file under $TMPDIR.
  if (/^mktemp(\s+(-[dqu]+|-t(\s+[^\s/-]\S*)?|--tmpdir(=\S+)?|--directory|--quiet))*$/.test(inner)) {
    return `${ph('BR_TMP')}/mktemp`
  }
  if (/^git\s+rev-parse\s+--show-toplevel$/.test(inner) && ctx.dir === null) return ph('BR_TOPLEVEL')
  if (/^pwd(\s+-[LP])?$/.test(inner)) return absDir(ctx.dir)
  return null
}

function varValue(name: string, ctx: Ctx): VarValue {
  const set = ctx.vars.get(name)
  if (set) return set
  if (ENV_VARS.has(name)) return { values: [{ text: ph(name), pattern: false }] }
  if (name === 'PWD') {
    const d = absDir(ctx.dir)
    return d === null ? { unknown: '$PWD after a cd that cannot be followed' } : { values: [{ text: d, pattern: false }] }
  }
  // ${HOME:-x} and kin: the environment's own variables are always set.
  const m = /^\{([A-Za-z_][A-Za-z0-9_]*):?[-=?+]/.exec(name)
  if (m && ENV_VARS.has(m[1] as string)) return { values: [{ text: ph(m[1] as string), pattern: false }] }
  return { unknown: `$${name} is not set on this command line` }
}

function expand(w: Word, ctx: Ctx, mode: 'path' | 'plain'): Expanded {
  let acc = ['']
  for (const p of w.parts) {
    let vals: string[]
    if (p.kind === 'lit') {
      vals = [mode === 'path' && p.quoted ? escapeGlob(p.text) : p.text]
    } else if (p.kind === 'sub') {
      const v = p.arith ? null : subValue(p, ctx)
      if (v === null) return { unknown: `$(${short(p.inner)}) is only known when it runs` }
      vals = [v]
    } else {
      const v = varValue(p.name, ctx)
      if ('unknown' in v) return v
      vals = v.values.map(x => (mode === 'path' && p.quoted && !x.pattern ? escapeGlob(x.text) : x.text))
    }
    acc = acc.flatMap(a => vals.map(v => a + v))
    if (acc.length > MAX_VALUES) return { unknown: `${short(w.raw)} has too many values to check` }
  }
  return { values: acc }
}

function expandAll(words: Word[], ctx: Ctx, mode: 'path' | 'plain'): Expanded {
  const values: string[] = []
  for (const w of words) {
    const v = expand(w, ctx, mode)
    if ('unknown' in v) return v
    values.push(...v.values)
  }
  return { values }
}

// ---------- walking the line ----------

interface Cmd {
  words: Word[]
  redirs: Redir[]
  raw: string
  inPipeline: boolean // a stage of a pipeline runs in a subshell, so its cd doesn't last
  find?: { dir: DirState; argv: string[] } // a find whose output a following xargs reads
}

export interface Line {
  effects: Effect[]
  // Where the shell is after the line: null when no cd outlives it, else the folder
  // relative to where the line started (or absolute), or unknown.
  endDir: Dir | { unknown: string }
}

export function analyzeLine(command: string): Line {
  const ctx: Ctx = { dir: null, vars: new Map(), pushed: [], out: [], depth: 0 }
  walk(command, ctx)
  const seen = new Set<string>()
  const effects = ctx.out.filter(e => {
    const key = JSON.stringify(e)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
  return { effects, endDir: ctx.dir }
}

export function analyze(command: string): Effect[] {
  return analyzeLine(command).effects
}

// True for any command line worth a second look: the guard's answer when its own check fails.
export function looksDestructive(command: string): boolean {
  return /\b(rm|unlink|shred|find|xargs|git|mv|cp|ln|install|tee|dd|truncate|rsync|curl|wget|eval|bash|sh|zsh|python[0-9.]*|node|perl|ruby)\b|>/.test(
    command,
  )
}

function child(ctx: Ctx): Ctx {
  return { dir: ctx.dir, vars: new Map(ctx.vars), pushed: [], out: ctx.out, depth: ctx.depth + 1 }
}

function walk(s: string, ctx: Ctx): void {
  if (ctx.depth > MAX_DEPTH) {
    if (DESTRUCTIVE.test(s)) ctx.out.push({ op: 'unknown', what: 'commands nested too deep to read', cmd: short(s) })
    return
  }
  const toks = lex(s)
  const scopes: DirState[] = []
  let cur: Tok[] = []
  let prev: Cmd | null = null
  let piped = false
  const flush = (op: string): void => {
    const first = cur[0]
    const last = cur[cur.length - 1]
    if (first && last) {
      const inPipeline = piped || op === '|' || op === '|&'
      const cmd: Cmd = { words: [], redirs: [], raw: s.slice(first.start, last.end).trim(), inPipeline }
      for (const t of cur) {
        if (t.t === 'word') cmd.words.push(t.w)
        else if (t.t === 'redir') cmd.redirs.push(t.r)
      }
      handle(cmd, ctx, piped ? prev : null)
      prev = cmd
    } else {
      prev = null
    }
    piped = op === '|' || op === '|&'
    cur = []
  }
  for (const t of toks) {
    if (t.t !== 'op') {
      cur.push(t)
    } else if (t.op === '(') {
      flush(';')
      scopes.push(ctx.dir)
    } else if (t.op === ')') {
      flush(';')
      // A cd inside ( ... ) does not outlive it.
      if (scopes.length > 0) ctx.dir = scopes.pop() as DirState
    } else {
      flush(t.op)
    }
  }
  flush(';')
}

function isAssign(w: Word): boolean {
  const p = w.parts[0]
  return p !== undefined && p.kind === 'lit' && !p.quoted && /^[A-Za-z_][A-Za-z0-9_]*\+?=/.test(p.text)
}

function assign(w: Word, ctx: Ctx): void {
  const first = w.parts[0] as Extract<Part, { kind: 'lit' }>
  const eq = first.text.indexOf('=')
  const name = first.text.slice(0, eq).replace(/\+$/, '')
  if (first.text[eq - 1] === '+') {
    ctx.vars.set(name, { unknown: `$${name} was appended to` })
    return
  }
  const rest: Part[] = [{ kind: 'lit', text: first.text.slice(eq + 1), quoted: false }, ...w.parts.slice(1)]
  const v = expand({ parts: rest, raw: w.raw }, ctx, 'plain')
  ctx.vars.set(name, 'unknown' in v ? v : { values: v.values.map(t => ({ text: t, pattern: false })) })
}

const KEYWORDS = new Set(['if', 'then', 'else', 'elif', 'do', 'while', 'until', '!', '{', '}', 'fi', 'done', 'esac'])
const DECLARE = new Set(['export', 'local', 'declare', 'typeset', 'readonly'])

// What a command's own expansions run: $( ), ` ` and <( ) in its words, its redirect
// targets and the body of a heredoc whose delimiter is unquoted.
function substitutions(cmd: Cmd): string[] {
  const parts = cmd.words.flatMap(w => w.parts)
  for (const r of cmd.redirs) {
    if (r.target) parts.push(...r.target.parts)
    if (r.heredoc?.quoted === false) parts.push(...heredocSubs(r.heredoc.body))
  }
  return parts.flatMap(p => (p.kind === 'sub' && !p.arith ? [p.inner] : []))
}

function handle(cmd: Cmd, ctx: Ctx, piped: Cmd | null): void {
  // Commands inside $( ), ` ` and <( ) run too, each in a subshell of this one.
  for (const inner of substitutions(cmd)) walk(inner, child(ctx))
  for (const r of cmd.redirs) redirect(r, ctx, cmd.raw)

  let words = cmd.words
  let k = 0
  while (k < words.length && isAssign(words[k] as Word)) k += 1
  if (k === words.length) {
    // Assignments alone set variables for the rest of the line.
    for (const w of words) assign(w, ctx)
    return
  }
  words = words.slice(k)
  while (words.length > 0 && KEYWORDS.has(text(words[0]) ?? '')) words = words.slice(1)
  const head = text(words[0])
  if (head === null || words.length === 0) return
  if (head === 'for' || head === 'select') {
    const name = text(words[1])
    if (name && text(words[2]) === 'in') {
      const items = expandAll(words.slice(3), ctx, 'path')
      ctx.vars.set(name, 'unknown' in items ? items : { values: items.values.map(t => ({ text: t, pattern: true })) })
    } else if (name) {
      ctx.vars.set(name, { unknown: `$${name} loops over the script's arguments` })
    }
    return
  }
  if (head === 'case' || head === 'function') return
  if (DECLARE.has(head)) {
    for (const w of words.slice(1)) if (isAssign(w)) assign(w, ctx)
    return
  }
  if (head === 'unset' || head === 'read') {
    for (const w of words.slice(1)) {
      const name = text(w)
      if (name && !name.startsWith('-')) ctx.vars.set(name, { unknown: `$${name} is read or unset at run time` })
    }
    return
  }

  const unwrapped = unwrap(words, ctx)
  if (unwrapped === null) return
  run(cmd, unwrapped.words, unwrapped.dir, ctx, piped)
}

function redirect(r: Redir, ctx: Ctx, raw: string): void {
  if (r.target === null) return
  const truncates = r.op === '>' || r.op === '>|' || r.op === '&>'
  // >&word with a word that is no file descriptor writes to that file, as &> does.
  const toFile = r.op === '>&' && !/^(\d+-?|-)$/.test(litText(r.target))
  if (!truncates && !toFile) return
  const v = expand(r.target, ctx, 'path')
  if ('unknown' in v) {
    ctx.out.push({ op: 'unknown', what: `writes to ${short(r.target.raw)}: ${v.unknown}`, cmd: short(raw) })
    return
  }
  const paths = v.values.filter(p => !isSink(p))
  if (paths.length > 0) emit(ctx, ctx.dir, paths, raw, dir => ({ op: 'overwrite', dir, paths, cmd: short(raw) }))
}

// Pushes the effect `make` builds, or an unknown one when relative paths sit under a cd
// that cannot be followed.
function emit(ctx: Ctx, dir: DirState, paths: string[], raw: string, make: (dir: Dir) => Effect): void {
  if (isUnknown(dir)) {
    if (paths.length > 0 && paths.every(isAbs)) ctx.out.push(make(null))
    else ctx.out.push({ op: 'unknown', what: `paths relative to ${dir.unknown}`, cmd: short(raw) })
    return
  }
  ctx.out.push(make(dir))
}

function pathsOf(words: Word[], ctx: Ctx, raw: string): string[] | null {
  const v = expandAll(words, ctx, 'path')
  if ('unknown' in v) {
    ctx.out.push({ op: 'unknown', what: v.unknown, cmd: short(raw) })
    return null
  }
  return v.values
}

const SUDO_VALUE = new Set(['-u', '-g', '-C', '-D', '-h', '-p', '-r', '-t', '-T', '-U'])
const TIMEOUT_VALUE = new Set(['-s', '-k', '--signal', '--kill-after'])

// Strips the wrappers that run another command unchanged (sudo, env, timeout, ...).
function unwrap(words: Word[], ctx: Ctx): { words: Word[]; dir: DirState } | null {
  let dir = ctx.dir
  for (;;) {
    const name = cmdName(words[0])
    let k = 1
    const opt = (): string | null => text(words[k])
    if (name === 'sudo' || name === 'doas') {
      while (opt()?.startsWith('-')) {
        const t = opt() as string
        k += SUDO_VALUE.has(t) ? 2 : 1
        if (t === '--') break
      }
    } else if (name === 'env') {
      while (k < words.length) {
        const t = opt()
        if (t === '--') {
          k += 1
          break
        }
        if (t === '-C' || t === '--chdir') {
          const d = text(words[k + 1])
          dir = d === null ? { unknown: 'env -C with an expansion' } : joinDir(dir, d)
          k += 2
        } else if (t?.startsWith('--chdir=')) {
          dir = joinDir(dir, t.slice(8))
          k += 1
        } else if (t === '-S' || t === '--split-string') {
          const v = words[k + 1] ? expand(words[k + 1] as Word, ctx, 'plain') : { values: [] }
          if ('unknown' in v) ctx.out.push({ op: 'unknown', what: `env -S: ${v.unknown}`, cmd: '' })
          else walk(v.values.join(' '), child(ctx))
          return null
        } else if (t === '-u' || t === '--unset') {
          k += 2
        } else if (t?.startsWith('-') || isAssign(words[k] as Word)) {
          k += 1
        } else {
          break
        }
      }
    } else if (name === 'command') {
      if (opt() === '-v' || opt() === '-V') return null
      if (opt() === '-p') k += 1
    } else if (name === 'exec') {
      while (opt()?.startsWith('-')) k += opt() === '-a' ? 2 : 1
    } else if (name === 'time') {
      if (opt() === '-p') k += 1
    } else if (name === 'nice') {
      if (opt() === '-n') k += 2
      else if (/^(-\d+|--adjustment=.*)$/.test(opt() ?? '')) k += 1
    } else if (name === 'timeout' || name === 'gtimeout') {
      while (opt()?.startsWith('-')) k += TIMEOUT_VALUE.has(opt() as string) ? 2 : 1
      k += 1 // the duration
    } else if (name === 'stdbuf') {
      while (opt()?.startsWith('-')) k += /^-[ioe]$/.test(opt() as string) ? 2 : 1
    } else if (name === 'caffeinate') {
      while (opt()?.startsWith('-')) k += opt() === '-t' || opt() === '-w' ? 2 : 1
    } else if (name !== 'builtin' && name !== 'nohup' && name !== 'chronic' && name !== 'unbuffer') {
      return { words, dir }
    }
    words = words.slice(k)
    if (words.length === 0) return null
  }
}

function cmdName(w: Word | undefined): string | null {
  const t = text(w)
  if (t === null) return null
  return t.replace(/^\\/, '').split('/').pop() ?? null
}

// Options and positionals; `--` ends the options.
function split(words: Word[]): { opts: string[]; args: Word[] } {
  const opts: string[] = []
  const args: Word[] = []
  let ended = false
  for (const w of words) {
    const t = text(w)
    if (!ended && t === '--') ended = true
    else if (!ended && t !== null && t.startsWith('-') && t !== '-') opts.push(t)
    else args.push(w)
  }
  return { opts, args }
}

function run(cmd: Cmd, words: Word[], dir: DirState, ctx: Ctx, piped: Cmd | null): void {
  const name = cmdName(words[0])
  if (name === null) return
  const args = words.slice(1)
  const raw = cmd.raw
  const local: Ctx = dir === ctx.dir ? ctx : { ...ctx, dir }

  if (name === 'cd' || name === 'pushd') {
    if (cmd.inPipeline) return
    if (name === 'pushd') ctx.pushed.push(ctx.dir)
    const target = split(args).args[0]
    if (target === undefined) {
      ctx.dir = name === 'cd' ? '~' : { unknown: 'pushd with no folder' }
      return
    }
    if (text(target) === '-') {
      ctx.dir = { unknown: 'cd -' }
      return
    }
    const v = expand(target, ctx, 'plain')
    ctx.dir = 'unknown' in v || v.values.length !== 1 ? { unknown: `cd ${short(target.raw)}` } : joinDir(ctx.dir, v.values[0] as string)
    return
  }
  if (name === 'popd') {
    ctx.dir = ctx.pushed.length > 0 ? (ctx.pushed.pop() as DirState) : { unknown: 'popd' }
    return
  }

  if (DELETE_CMDS.has(name)) {
    const recursive = recursiveDelete(name, args)
    const paths = pathsOf(split(args).args, local, raw)
    if (paths && paths.length > 0) {
      emit(ctx, dir, paths, raw, d => ({ op: 'delete', dir: d, paths, recursive, cmd: short(raw) }))
    }
    return
  }
  if (name === 'find') return find(cmd, args, dir, local)
  if (name === 'xargs') return xargs(args, dir, local, piped, raw)
  if (name === 'git') return git(args, dir, local, raw)
  if (name in COPY_CMDS) return copy(COPY_CMDS[name] as 'mv' | 'cp' | 'ln', name, args, dir, local, raw)
  if (name === 'tee') {
    const { opts, args: files } = split(args)
    if (opts.some(o => o === '--append' || /^-[^-]*a/.test(o))) return
    return overwrite(files, dir, local, raw)
  }
  if (name === 'dd') {
    const files: Word[] = []
    for (const w of args) {
      const first = w.parts[0]
      if (first?.kind === 'lit' && first.text.startsWith('of=')) {
        files.push({ parts: [{ ...first, text: first.text.slice(3) }, ...w.parts.slice(1)], raw: w.raw })
      }
    }
    return overwrite(files, dir, local, raw)
  }
  if (name === 'truncate') return overwrite(positionals(args, new Set(['-s', '-r', '--size', '--reference'])), dir, local, raw)
  if (name === 'rsync') return rsync(args, dir, local, raw)
  if (name === 'curl') return outputFile(args, /^-[a-zA-Z]*o$/, ['--output'], dir, local, raw)
  if (name === 'wget') return outputFile(args, /^-[a-zA-Z]*O$/, ['--output-document'], dir, local, raw)
  if (SHELLS.has(name)) return shell(cmd, args, local, raw)
  if (name === 'eval') {
    const v = expandAll(args, ctx, 'plain')
    if ('unknown' in v) {
      if (opaque(args.map(w => w.raw).join(' '))) ctx.out.push({ op: 'unknown', what: `eval: ${v.unknown}`, cmd: short(raw) })
    } else {
      walk(v.values.join(' '), { ...ctx, depth: ctx.depth + 1 })
    }
    return
  }
  if (INTERPRETERS.test(name)) return interpreter(cmd, name, args, ctx, raw)
}

// Whether a delete command's options make it recursive.
function recursiveDelete(name: string, args: Word[]): boolean {
  return name !== 'unlink' && split(args).opts.some(o => o === '--recursive' || /^-[^-]*[rR]/.test(o))
}

function positionals(args: Word[], valued: Set<string>): Word[] {
  const out: Word[] = []
  for (let k = 0; k < args.length; k += 1) {
    const t = text(args[k])
    if (t !== null && valued.has(t)) k += 1
    else if (t === null || !t.startsWith('-')) out.push(args[k] as Word)
  }
  return out
}

function overwrite(files: Word[], dir: DirState, ctx: Ctx, raw: string): void {
  const paths = pathsOf(files, ctx, raw)
  const kept = (paths ?? []).filter(p => p !== '-' && !isSink(p))
  if (kept.length > 0) emit(ctx, dir, kept, raw, d => ({ op: 'overwrite', dir: d, paths: kept, cmd: short(raw) }))
}

function outputFile(args: Word[], short_: RegExp, long: string[], dir: DirState, ctx: Ctx, raw: string): void {
  const files: Word[] = []
  for (let k = 0; k < args.length; k += 1) {
    const t = text(args[k]) ?? ''
    if (short_.test(t) || long.includes(t)) {
      if (args[k + 1]) files.push(args[k + 1] as Word)
      k += 1
    } else {
      const eq = long.find(l => t.startsWith(`${l}=`))
      if (eq) files.push({ parts: [{ kind: 'lit', text: t.slice(eq.length + 1), quoted: true }], raw: t })
    }
  }
  overwrite(files, dir, ctx, raw)
}

const FIND_ACTIONS = new Set(['-exec', '-execdir', '-ok', '-okdir'])
const FIND_WRITES: Record<string, number> = { '-fprint': 1, '-fprint0': 1, '-fls': 1, '-fprintf': 2 }

// What xargs reads, or each path find -exec puts in place of {}: an argument only known
// when it runs, held in a variable no command line can name. A shell or interpreter whose
// code holds it, in whole or in part, is held as `sh -c "$CMD"` is.
const INPUT = '<input>'
const INPUT_RAW = '"$@"'
const inputPart: Part = { kind: 'var', name: INPUT, quoted: true }
const inputWord = (): Word => ({ parts: [inputPart], raw: INPUT_RAW })
const isInput = (w: Word): boolean => w.parts.some(p => p.kind === 'var' && p.name === INPUT)
// The word is the input and nothing else, as `{}` or xargs's own trailing input is.
const isBareInput = (w: Word): boolean => {
  const ps = w.parts.filter(p => !(p.kind === 'lit' && p.text === ''))
  return ps.length === 1 && ps[0]?.kind === 'var' && ps[0].name === INPUT
}

// The words with the input in place of each `token` in them, or after them when `token`
// is null. A variable whose value holds the token counts as that value: the shell expands
// it before xargs looks for the token.
function withInput(words: Word[], token: string | null, ctx: Ctx): Word[] {
  if (token === null) return [...words, inputWord()]
  const cut = (p: Extract<Part, { kind: 'lit' }>): Part[] => {
    const [first = '', ...rest] = p.text.split(token)
    return [{ ...p, text: first }, ...rest.flatMap(text => [inputPart, { ...p, text }])]
  }
  const fill = (p: Part): Part[] => {
    if (p.kind === 'lit') return cut(p)
    if (p.kind !== 'var') return [p]
    const v = varValue(p.name, ctx)
    if ('unknown' in v || !v.values.some(x => x.text.includes(token))) return [p]
    const [one, ...more] = v.values
    // Several values, some holding the token: the word is only known when it runs.
    if (one === undefined || more.length > 0) return [p, inputPart]
    return cut({ kind: 'lit', text: one.text, quoted: p.quoted && !one.pattern })
  }
  return words.map(w => ({ parts: w.parts.flatMap(fill), raw: w.raw.split(token).join(INPUT_RAW) }))
}

// Where the command xargs or find -exec runs is read: a child process of the line's
// shell, in `dir`, whose input `what` describes.
function fedCtx(ctx: Ctx, dir: DirState, what: string): Ctx {
  const fed = { ...child(ctx), dir }
  fed.vars.set(INPUT, { unknown: what })
  return fed
}

// Reads the command xargs or find -exec runs the way any command on the line is read,
// wrappers such as sudo and env included. With `listDir`, its input is the paths a find
// prints from that folder: a delete given them there leaves them to the find's dry run,
// and the result says whether it recurses. Its other words are judged either way.
function runFed(words: Word[], fed: Ctx, raw: string, listDir?: DirState): { recursive: boolean } | null {
  const u = unwrap(words, fed)
  if (u === null) return null
  const name = cmdName(u.words[0]) ?? ''
  const args = u.words.slice(1)
  // Only a word that is the input alone is one of the find's paths: `~/backup/{}` or
  // `{}.bak` is some other path, which the dry run does not show.
  const listed = DELETE_CMDS.has(name) && u.dir === listDir && args.some(isBareInput)
  const cmd: Cmd = { words: u.words, redirs: [], raw, inPipeline: true }
  run(cmd, listed ? [...u.words.slice(0, 1), ...args.filter(w => !isBareInput(w))] : u.words, u.dir, fed, null)
  return listed ? { recursive: recursiveDelete(name, args) } : null
}

interface FindPlan {
  argv: string[]
  deletes: boolean
  recursive: boolean
  writes: string[]
}
// Reads the command an -exec or -ok runs, and says whether it deletes the paths found.
type FindExec = (action: string, sub: string[]) => { recursive: boolean } | null

// A find's dry run: the same search, with each deleting action printing instead and
// every other side effect dropped, so the judge can run it and see what would go.
function findPlan(argv: string[], exec: FindExec): FindPlan {
  const plan: FindPlan = { argv: [], deletes: false, recursive: false, writes: [] }
  for (let k = 0; k < argv.length; k += 1) {
    const a = argv[k] as string
    if (a === '-delete') {
      plan.deletes = true
      plan.argv.push('-print')
    } else if (FIND_ACTIONS.has(a)) {
      k = findAction(argv, k, plan, exec)
    } else if (a in FIND_WRITES) {
      plan.writes.push(argv[k + 1] ?? '')
      plan.argv.push('-true')
      k += FIND_WRITES[a] as number
    } else {
      plan.argv.push(a)
    }
  }
  return plan
}

// The -exec or -ok at argv[k], in the dry run: it prints when its command deletes the
// paths found, and does nothing otherwise. Returns the index of its closing ; or +.
function findAction(argv: string[], k: number, plan: FindPlan, exec: FindExec): number {
  let j = k + 1
  while (j < argv.length && argv[j] !== ';' && argv[j] !== '+') j += 1
  const del = exec(argv[k] as string, argv.slice(k + 1, j))
  plan.deletes ||= del !== null
  plan.recursive ||= del?.recursive === true
  plan.argv.push(del ? '-print' : '-true')
  return j
}

// An argument find passes to what -exec runs, as the shell left it. Unquoted, so a glob
// character in it is read as a pattern: the shell's quoting is gone by now, and the
// pattern is the reading that holds more.
const argWord = (s: string): Word => ({ parts: [{ kind: 'lit', text: s, quoted: false }], raw: s })

function find(cmd: Cmd, args: Word[], dir: DirState, ctx: Ctx): void {
  const raw = cmd.raw
  const v = expandAll(args, ctx, 'plain')
  if ('unknown' in v) {
    if (/-delete\b|-exec|-ok/.test(raw)) ctx.out.push({ op: 'unknown', what: `find: ${v.unknown}`, cmd: short(raw) })
    return
  }
  // -execdir and -okdir run their command in the folder of each path found.
  const plan = findPlan(v.values, (action, sub) => {
    const where = action.endsWith('dir') ? { unknown: `each folder find ${action} runs in` } : dir
    const fed = fedCtx(ctx, where, `{} in find ${action} is each path it finds`)
    return runFed(withInput(sub.map(argWord), '{}', fed), fed, raw, fed.dir)
  })
  if (plan.writes.length > 0) {
    emit(ctx, dir, plan.writes, raw, d => ({ op: 'overwrite', dir: d, paths: plan.writes.map(escapeGlob), cmd: short(raw) }))
  }
  if (plan.deletes) {
    emit(ctx, dir, [], raw, d => ({ op: 'find', dir: d, argv: plan.argv, recursive: plan.recursive, cmd: short(raw) }))
  } else {
    cmd.find = { dir, argv: plan.argv }
  }
}

// xargs options that take a value, joined (-n1, -I{}) or as the next word; GNU's -e and
// -i, which take one only joined; and the long ones that take the next word when no `=`
// gives it (--replace, --eof and --max-lines take one only after `=`).
const XARGS_VALUE = 'adEIJLnPRsS'
const XARGS_JOINED = 'ei'
const XARGS_LONG_VALUE = new Set(['--arg-file', '--delimiter', '--max-args', '--max-chars', '--max-procs', '--process-slot-var'])

interface XargsOpts {
  k: number // where the command starts
  replace: Word | null // what the input replaces (-I, -J, -i, --replace), or null to add it after
  whole: boolean // BSD's -J: the input replaces only the first word that is exactly `replace`
  fromFile: boolean // the input comes from -a's file, not from stdin
  unread: boolean // an option has an expansion in it, so where the command starts is unknown
}

// An option word: it starts with a literal `-`, expansions after it or not.
const isOption = (w: Word): boolean => {
  const p = w.parts[0]
  return p?.kind === 'lit' && p.text.startsWith('-')
}

function xargsOpts(args: Word[]): XargsOpts {
  const o: XargsOpts = { k: 0, replace: null, whole: false, fromFile: false, unread: false }
  for (let w = args[0]; w !== undefined && isOption(w); w = args[o.k]) {
    o.k += 1
    const t = text(w)
    if (t === null) {
      o.unread = true
      break
    }
    if (t.startsWith('--')) xargsLong(t, o)
    else xargsShort(t, args, o)
  }
  return o
}

// The last of -I, -J, -i and --replace is the one xargs uses.
function setReplace(o: XargsOpts, w: Word, whole: boolean): void {
  o.replace = w
  o.whole = whole
}

function xargsLong(t: string, o: XargsOpts): void {
  const eq = t.indexOf('=')
  const name = eq < 0 ? t : t.slice(0, eq)
  if (name === '--replace') setReplace(o, argWord(eq < 0 ? '{}' : t.slice(eq + 1)), false)
  if (name === '--arg-file') o.fromFile = true
  if (eq < 0 && XARGS_LONG_VALUE.has(name)) o.k += 1
}

// Combined short options (-0r, -0n 1, -rI{}): flags, up to the first option that takes
// a value, which is the rest of the word or else the next word.
const XARGS_SHORT = new RegExp(`^-[^${XARGS_VALUE}${XARGS_JOINED}]*([${XARGS_VALUE}${XARGS_JOINED}])(.*)$`, 's')

function xargsShort(t: string, args: Word[], o: XargsOpts): void {
  const m = XARGS_SHORT.exec(t)
  if (m === null) return // flags only
  const ch = m[1] as string
  const joined = m[2] as string
  if (ch === 'i') setReplace(o, argWord(joined || '{}'), false)
  if (XARGS_JOINED.includes(ch)) return
  // A missing value reads as empty, which fedWords() holds.
  const value = joined ? argWord(joined) : (args[o.k++] ?? argWord(''))
  if (ch === 'I' || ch === 'J') setReplace(o, value, ch === 'J')
  if (ch === 'a') o.fromFile = true
}

// Whether the word expands to exactly `s`.
function expandsTo(w: Word, ctx: Ctx, s: string): boolean {
  const v = expand(w, ctx, 'plain')
  return !('unknown' in v) && v.values.length === 1 && v.values[0] === s
}

// The words xargs runs, with its input where its options put it, or why that can't be read.
function fedWords(words: Word[], o: XargsOpts, fed: Ctx): { words: Word[] } | { unknown: string } {
  if (o.unread) return { unknown: 'xargs options only known when it runs' }
  if (o.replace === null) return { words: withInput(words, null, fed) }
  const v = expand(o.replace, fed, 'plain')
  const token = 'unknown' in v || v.values.length !== 1 ? '' : (v.values[0] as string)
  if (token === '') return { unknown: 'what xargs -I or -J replaces is only known when it runs' }
  if (!o.whole) return { words: withInput(words, token, fed) }
  // BSD's -J puts the input in place of the first word that is the token, else after the words.
  const at = words.findIndex(w => expandsTo(w, fed, token))
  if (at < 0) return { words: withInput(words, null, fed) }
  return { words: [...words.slice(0, at), inputWord(), ...words.slice(at + 1)] }
}

function xargs(args: Word[], dir: DirState, ctx: Ctx, piped: Cmd | null, raw: string): void {
  const o = xargsOpts(args)
  const fed = fedCtx(ctx, dir, 'what xargs passes comes from its input')
  const words = fedWords(args.slice(o.k), o, fed)
  if ('unknown' in words) {
    ctx.out.push({ op: 'unknown', what: words.unknown, cmd: short(raw) })
    return
  }
  // find ... | xargs rm: the find's own output is the list, so dry-run the find.
  const found = o.fromFile ? undefined : piped?.find
  const list = found && !isUnknown(found.dir) ? { dir: found.dir, argv: found.argv } : undefined
  const del = runFed(words.words, fed, raw, list?.dir)
  if (del && list) {
    const argv = list.argv.map(a => (a === '-print0' || a === '-ls' ? '-print' : a))
    ctx.out.push({ op: 'find', dir: list.dir, argv, recursive: del.recursive, cmd: short(raw) })
  }
}

const GIT_VALUE = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--config-env', '--super-prefix'])

// Whether a git command can discard work at all, so the safe majority never reaches the judge.
export function gitRisky(argv: string[]): boolean {
  let k = 0
  while (k < argv.length && (argv[k] as string).startsWith('-')) k += GIT_VALUE.has(argv[k] as string) ? 2 : 1
  const sub = argv[k]
  const rest = argv.slice(k + 1)
  const has = (...flags: string[]): boolean => rest.some(a => flags.includes(a))
  switch (sub) {
    case 'reset':
      return has('--hard')
    case 'checkout':
      return !has('-b', '-B', '--orphan') || has('-f', '--force')
    case 'restore':
      return !has('-S', '--staged') || has('-W', '--worktree')
    case 'switch':
      return has('-f', '--force', '--discard-changes')
    case 'clean':
      return !has('-n', '--dry-run')
    case 'stash':
      return rest[0] === 'drop' || rest[0] === 'clear'
    case 'branch':
      return has('-D') || (has('-d', '--delete') && has('-f', '--force'))
    case 'worktree':
      return rest[0] === 'remove'
    case 'rm':
      return !has('--cached') && rest.some(a => a === '--force' || /^-[a-z]*f/.test(a))
    case 'reflog':
      return rest[0] === 'expire' || rest[0] === 'delete'
    case 'gc':
      return rest.some(a => /^--prune(=|$)/.test(a))
    case 'prune':
    case 'filter-branch':
    case 'filter-repo':
      return true
    default:
      return false
  }
}

function git(args: Word[], dir: DirState, ctx: Ctx, raw: string): void {
  // Judge only what can discard work; an argument that cannot be expanded counts as unknown text.
  const texts = args.map(w => {
    const v = expand(w, ctx, 'plain')
    return 'unknown' in v ? null : v.values
  })
  if (!gitRisky(texts.map(t => (t === null ? '\u0000' : t.join(' '))))) return
  if (texts.some(t => t === null)) {
    ctx.out.push({ op: 'unknown', what: 'git with an argument only known when it runs', cmd: short(raw) })
    return
  }
  const argv = texts.flatMap(t => t as string[])
  emit(ctx, dir, [], raw, d => ({ op: 'git', dir: d, argv, cmd: short(raw) }))
}

function copy(mode: 'mv' | 'cp' | 'ln', name: string, args: Word[], dir: DirState, ctx: Ctx, raw: string): void {
  let targetDir: Word | null = null
  let noTargetDir = false
  let noClobber = false
  let force = false
  const pos: Word[] = []
  let ended = false
  const valued = name.endsWith('install') ? 'tSmog' : 'tS'
  for (let k = 0; k < args.length; k += 1) {
    const w = args[k] as Word
    const t = text(w)
    if (ended || t === null || !t.startsWith('-') || t === '-') {
      pos.push(w)
      continue
    }
    if (t === '--') ended = true
    else if (t === '--target-directory') targetDir = args[++k] ?? null
    else if (t.startsWith('--target-directory=')) targetDir = { parts: [{ kind: 'lit', text: t.slice(19), quoted: true }], raw: t }
    else if (t === '--no-target-directory') noTargetDir = true
    else if (t === '--no-clobber' || t.startsWith('--backup')) noClobber = true
    else if (t === '--force') force = true
    else if (/^--(suffix|mode|owner|group)$/.test(t)) k += 1
    else if (!t.startsWith('--')) {
      // Combined short options: -fv, -t DIR, -tDIR.
      for (let j = 1; j < t.length; j += 1) {
        const ch = t[j] as string
        if (valued.includes(ch)) {
          const value = t.slice(j + 1)
          const valueWord = value ? { parts: [{ kind: 'lit' as const, text: value, quoted: true }], raw: value } : (args[++k] ?? null)
          if (ch === 't') targetDir = valueWord
          break
        }
        if (ch === 'T') noTargetDir = true
        if (ch === 'n' || ch === 'b') noClobber = true
        if (ch === 'f') force = true
        if (ch === 'd' && name.endsWith('install')) return // install -d makes folders
      }
    }
  }
  if (mode === 'ln' && !force) noClobber = true
  let sources = pos
  let dest: Word[]
  if (targetDir) {
    dest = [targetDir]
  } else {
    if (pos.length < 2) return
    sources = pos.slice(0, -1)
    dest = [pos[pos.length - 1] as Word]
  }
  if (mode !== 'mv' && noClobber) return
  const src = pathsOf(sources, ctx, raw)
  const dst = pathsOf(dest, ctx, raw)
  if (src === null || dst === null) return
  emit(ctx, dir, [...src, ...dst], raw, d => ({
    op: 'copy', dir: d, mode, sources: src, dest: dst, intoDir: targetDir !== null, noTargetDir, noClobber, cmd: short(raw),
  }))
}

const RSYNC_VALUE = new Set(['-e', '--rsh', '--exclude', '--include', '--filter', '-f', '--exclude-from', '--include-from', '--files-from', '--rsync-path', '-T', '--temp-dir', '--partial-dir', '--backup-dir', '--compare-dest', '--copy-dest', '--link-dest', '--suffix', '--chmod', '--chown', '--timeout', '--port', '-B', '--block-size', '--max-size', '--min-size', '--bwlimit', '-M', '--out-format', '--log-file', '--password-file', '--info', '--debug'])

function rsync(args: Word[], dir: DirState, ctx: Ctx, raw: string): void {
  const pos: Word[] = []
  let deletes = false
  for (let k = 0; k < args.length; k += 1) {
    const t = text(args[k])
    if (t !== null && RSYNC_VALUE.has(t)) k += 1
    else if (t !== null && t.startsWith('--del')) deletes = true
    else if (t === null || !t.startsWith('-')) pos.push(args[k] as Word)
  }
  const dest = pos[pos.length - 1]
  if (pos.length < 2 || dest === undefined) return
  if (/^[^/]*:/.test(text(dest) ?? '') || (text(dest) ?? '').startsWith('rsync://')) return // a remote
  const paths = pathsOf([dest], ctx, raw)
  if (!paths) return
  // --delete removes what the source lacks; plain rsync replaces what both have.
  if (deletes) emit(ctx, dir, paths, raw, d => ({ op: 'delete', dir: d, paths, recursive: true, cmd: short(raw) }))
  else emit(ctx, dir, paths, raw, d => ({ op: 'overwrite', dir: d, paths, cmd: short(raw) }))
}

function stdinText(cmd: Cmd, ctx: Ctx): string | null {
  for (const r of cmd.redirs) {
    if (r.heredoc) return r.heredoc.quoted ? r.heredoc.body : heredocText(r.heredoc.body)
    if (r.op === '<<<' && r.target) {
      const v = expand(r.target, ctx, 'plain')
      return 'unknown' in v ? r.target.raw : v.values.join(' ')
    }
  }
  return null
}

function shell(cmd: Cmd, args: Word[], ctx: Ctx, raw: string): void {
  for (let k = 0; k < args.length; k += 1) {
    const t = text(args[k])
    if (t !== null && /^-[a-zA-Z]*c[a-zA-Z]*$/.test(t)) {
      const body = args[k + 1]
      if (body) shellCode(body, ctx, raw)
      return
    }
    if (t === '-o' || t === '+o') k += 1
    else if (t === null || !/^[-+]/.test(t)) return // a script: its commands are not on this line
  }
  const body = stdinText(cmd, ctx)
  if (body !== null) walk(body, child(ctx))
}

// A shell's -c code: read as commands when it can be expanded, else held when it could
// do anything.
function shellCode(body: Word, ctx: Ctx, raw: string): void {
  const v = expand(body, ctx, 'plain')
  if (!('unknown' in v)) {
    for (const s of v.values) walk(s, child(ctx))
  } else if (isInput(body) || opaque(body.raw)) {
    // Code with xargs's or -exec's input in it is held wherever the input sits.
    ctx.out.push({ op: 'unknown', what: v.unknown, cmd: short(raw) })
  }
}

const CODE_FLAGS = new Set(['-c', '-e', '-E', '--eval', '-r'])

// Where an interpreter's code comes from: the word after -c, -e and kin, a script, or
// else stdin.
function codeSource(name: string, args: Word[]): { code: Word | undefined } | 'script' | 'stdin' {
  for (let k = 0; k < args.length; k += 1) {
    const t = text(args[k])
    if ((t !== null && CODE_FLAGS.has(t)) || (name === 'deno' && t === 'eval')) return { code: args[k + 1] }
    if (t === null || !t.startsWith('-')) return 'script'
    if (t === '-m' || t === '-W' || t === '-X') k += 1
  }
  return 'stdin'
}

function interpreter(cmd: Cmd, name: string, args: Word[], ctx: Ctx, raw: string): void {
  const src = codeSource(name, args)
  const word = typeof src === 'object' ? src.code : undefined
  // Code made from xargs's or -exec's input could do anything: held as `sh -c` with it is.
  const fromInput = word !== undefined && isInput(word) ? expand(word, ctx, 'plain') : null
  if (fromInput !== null && 'unknown' in fromInput) {
    ctx.out.push({ op: 'unknown', what: fromInput.unknown, cmd: short(raw) })
    return
  }
  const code = typeof src === 'object' ? (word?.raw ?? '') : src === 'stdin' ? stdinText(cmd, ctx) : null
  if (code !== null && CODE_DELETES.test(code)) {
    ctx.out.push({ op: 'unknown', what: `inline ${name} code that deletes files`, cmd: short(raw) })
  }
}
