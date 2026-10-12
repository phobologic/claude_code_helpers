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
const WRITE_CMDS = new Set([...Object.keys(COPY_CMDS), 'tee', 'dd', 'truncate', 'rsync'])
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
  if (isUnknown(dir)) return dir
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

// ---------- wrappers ----------

// A command a wrapper runs and the folder it runs in; no words when it runs none.
interface Wrapped {
  words: Word[]
  dir: DirState
}
type Wrapper = (words: Word[], dir: DirState, ctx: Ctx) => Wrapped

// How a wrapper's own words are laid out before the command it runs.
interface Grammar {
  short?: string // short options whose value can be the next word: `-u root`, `-Eu root`
  long?: string[] // long ones whose value can be the next word: `--user root`
  chdir?: string[] // options whose value is the folder the command runs in
  operands?: number // words between the options and the command: timeout's duration
  sub?: string // the subcommand that runs a command (`uv run`); any other runs none
  stdin?: string // the interpreter a lone `-` runs on stdin (`uv run -`)
}

interface Opt {
  name: string // `-u` or `--user`, without its value
  value?: Word | undefined // none for a flag, or for an option that ends the line
}

const literal = (s: string): Word => ({ parts: [{ kind: 'lit', text: s, quoted: false }], raw: s })

// The word with its first n characters, all of them in its leading literal, cut off.
function after(w: Word, n: number): Word {
  const [head, ...rest] = w.parts as [Extract<Part, { kind: 'lit' }>, ...Part[]]
  return { parts: [{ ...head, text: head.text.slice(n) }, ...rest], raw: w.raw }
}

// The options in one word (`-Eu`, `-uroot`, `--user=root`), and the name of a last one
// whose value is the next word.
function optionWord(w: Word, flag: string, g: Grammar): { opts: Opt[]; next: string | null } {
  if (flag.startsWith('--')) {
    const eq = flag.indexOf('=')
    if (eq >= 0) return { opts: [{ name: flag.slice(0, eq), value: after(w, eq + 1) }], next: null }
    return g.long?.includes(flag) ? { opts: [], next: flag } : { opts: [{ name: flag }], next: null }
  }
  const opts: Opt[] = []
  for (let j = 1; j < flag.length; j += 1) {
    const name = `-${flag[j]}`
    if (g.short?.includes(flag[j] as string)) {
      if (j + 1 === flag.length && w.parts.length === 1) return { opts, next: name }
      opts.push({ name, value: after(w, j + 1) })
      return { opts, next: null }
    }
    opts.push({ name })
  }
  return { opts, next: null }
}

// The options from words[k], up to the first word that isn't one or just past `--`, and
// the index after them. A lone `-` is an operand, as getopt reads it: env takes it as -i,
// `uv run -` runs stdin as Python, and in zsh `exec -` is the `-` wrapper below.
function readOpts(words: Word[], k: number, g: Grammar): { opts: Opt[]; k: number } {
  const opts: Opt[] = []
  while (k < words.length) {
    const w = words[k] as Word
    const head = w.parts[0]
    const flag = head?.kind === 'lit' ? head.text : ''
    if (!flag.startsWith('-') || text(w) === '-') break
    k += 1
    if (text(w) === '--') break
    const found = optionWord(w, flag, g)
    opts.push(...found.opts)
    if (found.next !== null) {
      opts.push({ name: found.next, value: words[k] })
      k += 1
    }
  }
  return { opts, k }
}

// The folder a wrapper's command runs in once its chdir options (`sudo -D`) are applied.
function moveDir(dir: DirState, wrapper: string, opts: Opt[], chdir: string[]): DirState {
  for (const o of opts) {
    if (!chdir.includes(o.name)) continue
    const d = text(o.value)
    dir = d === null ? { unknown: `${wrapper} ${o.name} with an expansion` } : joinDir(dir, d)
  }
  return dir
}

// A wrapper whose words a Grammar describes.
function grammar(g: Grammar): Wrapper {
  return (words, dir) => {
    let { opts, k } = readOpts(words, 1, g)
    if (g.sub !== undefined) {
      // `uv sync` and the like run nothing this file judges.
      if (text(words[k]) !== g.sub) return { words: [], dir }
      const more = readOpts(words, k + 1, g)
      opts = opts.concat(more.opts)
      k = more.k
    }
    const rest = words.slice(k + (g.operands ?? 0))
    if (g.stdin !== undefined && text(rest[0]) === '-') rest.unshift(literal(g.stdin))
    return { words: rest, dir: moveDir(dir, cmdName(words[0]) ?? '', opts, g.chdir ?? []) }
  }
}

const ENV: Grammar = { short: 'CPSu', long: ['--chdir', '--split-string', '--unset'], chdir: ['-C', '--chdir'] }

// env [options] [NAME=value ...] command, where -S's string is a command line of its own.
function env(words: Word[], dir: DirState, ctx: Ctx): Wrapped {
  const { opts, k } = readOpts(words, 1, ENV)
  const split = opts.find(o => o.name === '-S' || o.name === '--split-string')
  if (split) {
    const v = split.value ? expand(split.value, ctx, 'plain') : { values: [] }
    if ('unknown' in v) ctx.out.push({ op: 'unknown', what: `env -S: ${v.unknown}`, cmd: '' })
    else walk(v.values.join(' '), child(ctx))
    return { words: [], dir }
  }
  // A `-` right after the options means -i. env takes any word with `=` in it, once the
  // shell has removed the quotes, as an assignment: `env "X=a b" cmd`.
  let j = text(words[k]) === '-' ? k + 1 : k
  while (j < words.length && litText(words[j] as Word).includes('=')) j += 1
  return { words: words.slice(j), dir: moveDir(dir, 'env', opts, ENV.chdir ?? []) }
}

// command -v and -V only look the command up.
function command(words: Word[], dir: DirState): Wrapped {
  const { opts, k } = readOpts(words, 1, {})
  return { words: opts.some(o => o.name === '-v' || o.name === '-V') ? [] : words.slice(k), dir }
}

const FLOCK: Grammar = { short: 'wE', long: ['--wait', '--timeout', '--conflict-exit-code'] }

// flock [options] lockfile command..., or flock [options] lockfile -c 'command', which sh
// runs. flock [options] fd runs nothing.
function flock(words: Word[], dir: DirState): Wrapped {
  const k = readOpts(words, 1, FLOCK).k + 1 // past the lock file
  const c = text(words[k])
  if (c === '-c' || c === '--command') return { words: [literal('sh'), literal('-c'), ...words.slice(k + 1)], dir }
  return { words: words.slice(k), dir }
}

const SUDO: Grammar = {
  short: 'aCcDghpRrTtUu',
  long: ['--auth-type', '--close-from', '--login-class', '--chdir', '--group', '--host', '--prompt', '--chroot', '--role', '--type', '--command-timeout', '--other-user', '--user'],
  chdir: ['-D', '--chdir'],
}
const TIMEOUT: Grammar = { short: 'ks', long: ['--kill-after', '--signal'], operands: 1 }
// The options of uv run that take a value, from uv's CLI reference, global ones included.
const UV: Grammar = {
  sub: 'run',
  short: 'CfiPpw',
  long: [
    '--allow-insecure-host', '--cache-dir', '--color', '--config-file', '--config-setting', '--config-settings',
    '--config-settings-package', '--default-index', '--directory', '--env-file', '--exclude-newer',
    '--exclude-newer-package', '--extra', '--extra-index-url', '--find-links', '--fork-strategy', '--group', '--index',
    '--index-strategy', '--index-url', '--keyring-provider', '--link-mode', '--no-binary-package',
    '--no-build-isolation-package', '--no-build-package', '--no-editable-package', '--no-extra', '--no-group',
    '--no-sources-package', '--only-group', '--package', '--prerelease', '--prerelease-package', '--project', '--python',
    '--python-platform', '--python-preference', '--refresh-package', '--reinstall-package', '--resolution',
    '--trusted-host', '--upgrade-group', '--upgrade-package', '--with', '--with-editable', '--with-requirements',
  ],
  chdir: ['--directory'],
  stdin: 'python',
}
// Poetry 2 runs the command in -C's folder; -P only says where the project is.
const POETRY: Grammar = { sub: 'run', short: 'CP', long: ['--directory', '--project'], chdir: ['-C', '--directory'] }

// Wrappers that run another command unchanged. npx, pnpm exec and uvx are not here: the
// package binaries they run are unknown code either way.
const WRAPPERS = new Map<string, Wrapper>([
  ['sudo', grammar(SUDO)],
  ['doas', grammar({ short: 'aCu' })],
  ['env', env],
  ['command', command],
  ['exec', grammar({ short: 'a' })],
  ['time', grammar({ short: 'fo', long: ['--format', '--output'] })],
  ['nice', grammar({ short: 'n', long: ['--adjustment'] })],
  ['timeout', grammar(TIMEOUT)],
  ['gtimeout', grammar(TIMEOUT)],
  ['stdbuf', grammar({ short: 'eio', long: ['--input', '--output', '--error'] })],
  ['caffeinate', grammar({ short: 'tw' })],
  ['ionice', grammar({ short: 'cnPpu', long: ['--class', '--classdata', '--pid', '--pgid', '--uid'] })],
  ['flock', flock],
  ['uv', grammar(UV)],
  ['poetry', grammar(POETRY)],
  ['builtin', grammar({})],
  ['nohup', grammar({})],
  ['chronic', grammar({})],
  ['unbuffer', grammar({})],
  // zsh's `-` precommand modifier: `- cmd` and `exec - cmd` run cmd with a - before its argv[0].
  ['-', grammar({})],
])

// Strips the wrappers that run another command unchanged (sudo, env, timeout, uv run, ...).
function unwrap(words: Word[], ctx: Ctx): Wrapped | null {
  let w: Wrapped = { words, dir: ctx.dir }
  for (;;) {
    const wrapper = WRAPPERS.get(cmdName(w.words[0]) ?? '')
    if (wrapper === undefined) return w
    w = wrapper(w.words, w.dir, ctx)
    if (w.words.length === 0) return null
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
    const { opts, args: targets } = split(args)
    const recursive = name !== 'unlink' && opts.some(o => o === '--recursive' || /^-[^-]*[rR]/.test(o))
    const paths = pathsOf(targets, local, raw)
    if (paths && paths.length > 0) {
      emit(ctx, dir, paths, raw, d => ({ op: 'delete', dir: d, paths, recursive, cmd: short(raw) }))
    }
    return
  }
  if (name === 'find') return find(cmd, args, dir, local)
  if (name === 'xargs') return xargs(args, ctx, piped, raw)
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

// A find's dry run: the same search, with each deleting action printing instead and
// every other side effect dropped, so the judge can run it and see what would go.
function findPlan(argv: string[]): { argv: string[]; deletes: boolean; recursive: boolean; writes: string[]; risky: string | null } {
  let k = 0
  const lead: string[] = []
  while (k < argv.length && /^-[HLPEXdsx]$/.test(argv[k] as string)) lead.push(argv[k++] as string)
  const roots: string[] = []
  while (k < argv.length && !/^[-(!)]/.test(argv[k] as string)) roots.push(argv[k++] as string)
  const out: string[] = []
  let deletes = false
  let recursive = false
  let risky: string | null = null
  const writes: string[] = []
  for (; k < argv.length; k += 1) {
    const a = argv[k] as string
    if (a === '-delete') {
      deletes = true
      out.push('-print')
    } else if (FIND_ACTIONS.has(a)) {
      let j = k + 1
      while (j < argv.length && argv[j] !== ';' && argv[j] !== '+') j += 1
      const sub = argv.slice(k + 1, j)
      const name = (sub[0] ?? '').split('/').pop() ?? ''
      if (DELETE_CMDS.has(name)) {
        deletes = true
        recursive ||= sub.some(s => /^-[^-]*[rR]/.test(s) || s === '--recursive')
        out.push('-print')
      } else {
        if (WRITE_CMDS.has(name) || SHELLS.has(name) || INTERPRETERS.test(name)) risky = `find ${a} ${name}`
        out.push('-true')
      }
      k = j
    } else if (a in FIND_WRITES) {
      writes.push(argv[k + 1] ?? '')
      out.push('-true')
      k += FIND_WRITES[a] as number
    } else {
      out.push(a)
    }
  }
  return { argv: [...lead, ...roots, ...out], deletes, recursive, writes, risky }
}

function find(cmd: Cmd, args: Word[], dir: DirState, ctx: Ctx): void {
  const raw = cmd.raw
  const v = expandAll(args, ctx, 'plain')
  if ('unknown' in v) {
    if (/-delete\b|-exec|-ok/.test(raw)) ctx.out.push({ op: 'unknown', what: `find: ${v.unknown}`, cmd: short(raw) })
    return
  }
  const plan = findPlan(v.values)
  if (plan.writes.length > 0) {
    emit(ctx, dir, plan.writes, raw, d => ({ op: 'overwrite', dir: d, paths: plan.writes.map(escapeGlob), cmd: short(raw) }))
  }
  if (plan.risky) ctx.out.push({ op: 'unknown', what: `${plan.risky}: what it changes is only known when it runs`, cmd: short(raw) })
  if (plan.deletes) {
    emit(ctx, dir, [], raw, d => ({ op: 'find', dir: d, argv: plan.argv, recursive: plan.recursive, cmd: short(raw) }))
  } else {
    cmd.find = { dir, argv: plan.argv }
  }
}

const XARGS_VALUE = new Set(['-n', '-P', '-I', '-L', '-s', '-d', '-E', '-J', '-R', '-S', '--max-args', '--max-procs', '--replace', '--max-lines', '--max-chars', '--delimiter', '--eof'])

function xargs(args: Word[], ctx: Ctx, piped: Cmd | null, raw: string): void {
  let k = 0
  let fromFile = false
  while (k < args.length) {
    const t = text(args[k])
    if (t === null || !t.startsWith('-')) break
    if (t === '-a' || t.startsWith('--arg-file')) fromFile = true
    k += XARGS_VALUE.has(t) || t === '-a' ? 2 : 1
  }
  const rest = args.slice(k)
  const name = cmdName(rest[0])
  if (name === null) return
  if (DELETE_CMDS.has(name)) {
    const found = !fromFile && piped?.find
    if (found && !isUnknown(found.dir)) {
      // find ... | xargs rm: the find's own output is the list, so dry-run the find.
      const argv = found.argv.map(a => (a === '-print0' || a === '-ls' ? '-print' : a))
      const recursive = rest.some(w => /^-[^-]*[rR]/.test(text(w) ?? '') || text(w) === '--recursive')
      ctx.out.push({ op: 'find', dir: found.dir, argv, recursive, cmd: short(raw) })
    } else {
      ctx.out.push({ op: 'unknown', what: `xargs ${name}: what it deletes comes from its input`, cmd: short(raw) })
    }
  } else if (WRITE_CMDS.has(name) || SHELLS.has(name) || INTERPRETERS.test(name)) {
    ctx.out.push({ op: 'unknown', what: `xargs ${name}: what it changes comes from its input`, cmd: short(raw) })
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
      if (!body) return
      const v = expand(body, ctx, 'plain')
      if ('unknown' in v) {
        if (opaque(body.raw)) ctx.out.push({ op: 'unknown', what: v.unknown, cmd: short(raw) })
      } else {
        for (const s of v.values) walk(s, child(ctx))
      }
      return
    }
    if (t === '-o' || t === '+o') k += 1
    else if (t === null || !/^[-+]/.test(t)) return // a script: its commands are not on this line
  }
  const body = stdinText(cmd, ctx)
  if (body !== null) walk(body, child(ctx))
}

function interpreter(cmd: Cmd, name: string, args: Word[], ctx: Ctx, raw: string): void {
  let code: string | null = null
  let script = false
  for (let k = 0; k < args.length; k += 1) {
    const t = text(args[k])
    if (t !== null && ['-c', '-e', '-E', '--eval', '-r'].includes(t)) {
      code = args[k + 1]?.raw ?? ''
      break
    }
    if (name === 'deno' && t === 'eval') {
      code = args[k + 1]?.raw ?? ''
      break
    }
    if (t === null || !t.startsWith('-')) {
      script = true
      break
    }
    if (t === '-m' || t === '-W' || t === '-X') k += 1
  }
  if (code === null && !script) code = stdinText(cmd, ctx)
  if (code !== null && CODE_DELETES.test(code)) {
    ctx.out.push({ op: 'unknown', what: `inline ${name} code that deletes files`, cmd: short(raw) })
  }
}
