import { atom, read, update } from 'claude-code'
import type { Hook, Register } from 'claude-code'

import type { Look, Mood, OwlPrefs, OwlView } from '../types'
import { EMPTY, mergeConfigs, parseConfig, type RepoConfig, type Rule, ruleFor, subjectOf } from './config'
import type { OwlClientProps } from './owl-client'
import { BUBBLE_BORDER, FOLDED_HEIGHT, foldedPixels, HEIGHT, pixels, rows, WIDTH } from './sprites'
import { cleanReply, isLazyPrompt, isTestCommand, type Moment, pick, pickFrom, SYSTEM } from './voice'

// clockwork-owl: a brass owl floating just above the prompt's right edge. Its
// mood follows the session (working, waiting on a permission prompt, a failed
// test run, idle, asleep), and now and then it says something in a bubble:
// canned lines for common moments, Haiku for remarks about what you've been
// doing. Remarks are rationed; the owl is quiet by default.

const view = atom({ plugin: 'clockwork-owl', key: 'view' } as const, {
  mood: 'idle',
  look: 'center',
  isBlinking: false,
  bubble: null,
} as OwlView)
const prefs = atom({ plugin: 'clockwork-owl', key: 'prefs' } as const, {
  isHushed: false,
  isHidden: false,
  isFolded: false,
} as OwlPrefs)

type Dollar = Parameters<Hook<'session.start'>>[0]

const MINUTE = 60_000
const TICK_MS = 500
const CANNED_COOLDOWN = 4 * MINUTE
const HAIKU_COOLDOWN = 12 * MINUTE
const HAIKU_MAX_PER_SESSION = 20
const LONG_TURN = 8 * MINUTE
const SLEEPY_AFTER = 15 * MINUTE
const MOOD_HOLD: Partial<Record<Mood, number>> = { failed: 45_000, happy: 5_000 }
const DIGEST_MAX = 40

// Module variables: a reload starts them over, which only costs the owl its
// short-term memory. What the drawing reads is in $.state.
let isOff = false
/** The owl's Client failed on this load: draw the plain sprite instead. */
let isClientBroken = false
let config: RepoConfig = EMPTY
let configProblems: string[] = []
let tick: { cancel: () => void } | null = null
let now = 0
let sessionStart = 0
let lastActivity = 0
let lastRemark = -Infinity
let lastHaiku = -Infinity
let haikuCalls = 0
let haikuInFlight = false
let turnsSinceRemark = 0
let moodUntil = 0
let bubbleUntil = 0
let nextBlink = 0
let blinkUntil = 0
let nextGlance = 0
let isTurnRunning = false
let turnTools = 0
let turnAgents = 0
let testFails = 0
let hasGreeted = false
const used = new Set<string>()
const edits = new Map<string, number>()
const digest: { at: number; text: string }[] = []

function rand(): number {
  return Math.random()
}

function note(text: string) {
  digest.push({ at: now, text: text.replace(/\s+/g, ' ').slice(0, 160) })
  if (digest.length > DIGEST_MAX) digest.shift()
}

async function setView($: Dollar, patch: Partial<OwlView>) {
  await update($, view, v => {
    const changed = (Object.keys(patch) as (keyof OwlView)[]).some(k => v[k] !== patch[k])
    return changed ? { ...v, ...patch } : v
  })
}

async function setMood($: Dollar, mood: Mood) {
  const hold = MOOD_HOLD[mood]
  moodUntil = hold ? now + hold : 0
  await setView($, { mood })
}

/** The mood the owl drifts back to once a held one runs out. */
function restingMood(): Mood {
  if (isTurnRunning) return 'working'
  if (now - lastActivity > SLEEPY_AFTER) return 'sleepy'
  return 'idle'
}

/** `force` skips the cooldown; `asked` (an explicit /owl say) speaks while hushed too. */
/** Folds the owl away or brings him back; folding drops a bubble he was showing. */
async function setFolded($: Dollar, isFolded: boolean) {
  await update($, prefs, p => ({ ...p, isFolded }))
  if (isFolded) await setView($, { bubble: null })
}

async function say($: Dollar, line: string, force = false, asked = false): Promise<boolean> {
  const p = await read($, prefs)
  if (isOff || p.isHidden || ((p.isHushed || p.isFolded) && !asked)) return false
  if (p.isFolded) await setFolded($, false)
  if (!force && now - lastRemark < CANNED_COOLDOWN) return false
  lastRemark = now
  turnsSinceRemark = 0
  bubbleUntil = now + 8000 + line.length * 40
  note(`(owl said: ${line})`)
  await setView($, { bubble: line })
  return true
}

/** A canned line for a moment, with the given odds, within the cooldown. */
async function remark($: Dollar, moment: Moment, odds = 1, force = false) {
  if (!force && rand() > odds) return
  if (!force && now - lastRemark < CANNED_COOLDOWN) return
  await say($, pick(moment, used, rand, config.lines[moment]), force)
}

function ago(at: number): string {
  const m = Math.round((now - at) / MINUTE)
  return m < 1 ? 'just now' : `${m}m ago`
}

function digestText(): string {
  const churn = [...edits.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .filter(([, n]) => n >= 2)
    .map(([f, n]) => `${f} (${n} edits)`)
  const lines = [
    `Session length: ${Math.round((now - sessionStart) / MINUTE)} minutes.`,
    `Test runs failing in a row: ${testFails}.`,
    churn.length ? `Most edited files: ${churn.join(', ')}.` : 'No file edited more than once.',
    config.voice ? `About this repo, from its owner: ${config.voice}` : '',
    '',
    'Recent activity, oldest first:',
    ...digest.map(d => `- ${ago(d.at)}: ${d.text}`),
  ]
  return lines.filter((l, i) => l !== '' || i === 4).join('\n')
}

/** `asked`: an explicit /owl say, which speaks even while hushed. */
async function haikuRemark($: Dollar, asked = false) {
  if (haikuInFlight || isOff) return
  const p = await read($, prefs)
  if (p.isHushed && !asked) return
  const force = asked
  haikuInFlight = true
  lastHaiku = now
  haikuCalls += 1
  try {
    const r = await $.model.complete({
      model: 'haiku',
      system: SYSTEM,
      prompt: `${digestText()}\n\nYour one line:`,
      maxTokens: 80,
      effort: 'low',
    })
    const line = r.isAnswered ? cleanReply(r.text) : null
    if (line) await say($, line, true, asked)
    else if (force) await say($, r.isAnswered ? 'Nothing to say. Savor it.' : "My gears are jammed. (Haiku didn't answer.)", true, asked)
  } finally {
    haikuInFlight = false
  }
}

function maybeHaiku($: Dollar) {
  if (haikuCalls >= HAIKU_MAX_PER_SESSION) return
  if (now - lastHaiku < HAIKU_COOLDOWN || now - lastRemark < CANNED_COOLDOWN) return
  if (digest.length < 5 || turnsSinceRemark < 2) return
  void haikuRemark($).catch(() => {})
}

async function onTick($: Dollar) {
  now = await $.clock.now()
  const v = await read($, view)
  const patch: Partial<OwlView> = {}

  if (v.bubble && now > bubbleUntil) patch.bubble = null

  if (v.isBlinking && now > blinkUntil) patch.isBlinking = false
  if (!v.isBlinking && now > nextBlink && v.mood !== 'sleepy' && v.mood !== 'happy') {
    patch.isBlinking = true
    blinkUntil = now + 200
    nextBlink = now + 20_000 + rand() * 25_000
  }

  // While it works, the owl glances around now and then; at rest it stays still.
  if (v.mood === 'working' && now > nextGlance) {
    const looks: Look[] = ['center', 'left', 'center', 'right', 'down']
    patch.look = looks[Math.floor(rand() * looks.length)] as Look
    nextGlance = now + 2500 + rand() * 3000
  } else if (v.mood !== 'working' && v.look !== 'center') {
    patch.look = 'center'
  }

  if (moodUntil && now > moodUntil) {
    moodUntil = 0
    patch.mood = restingMood()
  } else if (v.mood === 'idle' && restingMood() === 'sleepy') {
    patch.mood = 'sleepy'
    await remark($, 'sleepy', 0.5)
  }

  if (Object.keys(patch).length) await setView($, patch)
}

async function repoRoot($: Dollar): Promise<string> {
  const cwd = await $.session.cwd()
  try {
    const git = await $.process.run(['git', 'rev-parse', '--show-toplevel'], { cwd, timeoutMs: 5000 })
    const top = git.stdout.trim()
    if (git.exitCode === 0 && top) return top
  } catch {
    // no git: the session directory stands in
  }
  return cwd
}

const FILES = ['owl.json', 'owl.local.json'] as const

/** Reads one config file: its config, or null when it is not there, and what was wrong with it. */
async function readConfigFile($: Dollar, path: string): Promise<{ config: RepoConfig | null; problems: string[] }> {
  if (!(await $.fs.exists(path).catch(() => false))) return { config: null, problems: [] }
  try {
    return parseConfig(await $.fs.read(path))
  } catch (err) {
    return { config: null, problems: [`could not read it: ${err instanceof Error ? err.message : String(err)}`] }
  }
}

function describe(c: RepoConfig): string {
  const lineCount = Object.values(c.lines).reduce((n, l) => n + (l?.length ?? 0), 0)
  const rules = c.rules.map(r => `${r.label} (${r.tool}: /${r.match.source}/)`).join(', ')
  return [
    `voice ${c.voice ? 'set' : 'not set'}`,
    `${lineCount} extra lines`,
    `${c.rules.length} rules${rules ? `: ${rules}` : ''}`,
    `test-run detection ${c.testCommands === false ? 'off' : 'on'}`,
  ].join('; ')
}

/** Reads both files into `config` and reports what it found, one line per file and one for the result. */
async function loadConfig($: Dollar): Promise<string> {
  const dir = `${await repoRoot($)}/.claude`
  const report: string[] = []
  const found: RepoConfig[] = []
  configProblems = []
  for (const name of FILES) {
    const { config: c, problems } = await readConfigFile($, `${dir}/${name}`)
    if (c === null && problems.length === 0) {
      report.push(`${dir}/${name}: not there`)
      continue
    }
    if (c) found.push(c)
    configProblems.push(...problems.map(p => `${name}: ${p}`))
    report.push(`${dir}/${name}: ${problems.length ? `problems: ${problems.join('; ')}` : 'ok'}`)
  }
  config = found.length === 2 ? mergeConfigs(found[0] as RepoConfig, found[1] as RepoConfig) : (found[0] ?? EMPTY)
  report.push(`In effect: ${describe(config)}`)
  return report.join('\n')
}

function short(text: string): string {
  return text.length > 80 ? `${text.slice(0, 77)}...` : text
}

async function afterRule($: Dollar, rule: Rule, subject: string, isError: boolean) {
  note(`${rule.label} (${short(subject)}) ${isError ? 'failed' : 'passed'}`)
  await setMood($, isError ? 'failed' : 'happy')
  const lines = isError ? rule.fail : rule.pass
  if (lines.length && rand() < 0.6 && now - lastRemark >= CANNED_COOLDOWN) await say($, pickFrom(lines, used, rand))
}

/** What a finished tool call does to the owl: rules first, then test runs, and the digest. */
async function afterTool($: Dollar, tool: string, rawInput: unknown, isError: boolean) {
  if (tool === CHECK_TOOL) return
  const input = typeof rawInput === 'object' && rawInput !== null ? (rawInput as Record<string, unknown>) : {}
  now = await $.clock.now()
  lastActivity = now
  turnTools += 1

  const v = await read($, view)
  if (v.mood === 'waiting') await setMood($, isTurnRunning ? 'working' : 'idle')

  const rule = ruleFor(config, tool, input)
  if (rule) await afterRule($, rule, subjectOf(tool, input), isError)
  else if (tool === 'Bash') await afterBash($, subjectOf(tool, input), isError)

  if (tool === 'Edit' || tool === 'Write') {
    const file = subjectOf(tool, input).split('/').slice(-2).join('/')
    edits.set(file, (edits.get(file) ?? 0) + 1)
    note(`${tool} ${file}`)
  }
}

async function afterBash($: Dollar, command: string, isError: boolean) {
  if (config.testCommands === false || !isTestCommand(command)) return
  const shortCommand = short(command)
  if (isError) {
    testFails += 1
    note(`test run failed (${shortCommand}), ${testFails} in a row`)
    await setMood($, 'failed')
    await remark($, testFails >= 3 ? 'testFailAgain' : 'testFail', testFails >= 3 ? 0.8 : 0.4)
  } else {
    const wasFailing = testFails > 0
    testFails = 0
    note(`test run passed (${shortCommand})`)
    if (wasFailing) {
      await setMood($, 'happy')
      await remark($, 'testPass', 0.6)
    }
  }
}

const CHECK_TOOL = 'mcp__clockwork-owl__owl_check'

const CHECK_DESCRIPTION = `Checks a clockwork-owl config (.claude/owl.json or .claude/owl.local.json) the way the owl reads it, and tests which rule each sample tool call would trigger. Used by the /clockwork-owl:owl-setup skill.

With "config" (the JSON text of a draft), checks that draft alone. Without it, re-reads both files from the repo's .claude/ folder, reports each, and loads the result into the running owl.

"samples" are tool calls as the owl would see them: {"tool": "Bash", "input": {"command": "make flash"}}, {"tool": "Skill", "input": {"skill": "deploy"}}, {"tool": "Edit", "input": {"file_path": "/repo/servo.cfg"}}, or any MCP tool with its arguments. Each answer names the matching rule, or says none matched and whether built-in test-run detection would react.`

const CHECK_SCHEMA = {
  type: 'object',
  properties: {
    config: { type: 'string', description: 'JSON text of a draft config; omit to check the files on disk' },
    samples: {
      type: 'array',
      items: {
        type: 'object',
        properties: { tool: { type: 'string' }, input: { type: 'object' } },
        required: ['tool', 'input'],
      },
    },
  },
}

type Sample = { tool: string; input: Record<string, unknown> }

function sampleLine(c: RepoConfig, s: Sample): string {
  const input = typeof s.input === 'object' && s.input !== null ? s.input : {}
  const subject = subjectOf(s.tool, input)
  const rule = ruleFor(c, s.tool, input)
  if (rule) return `${s.tool} "${short(subject)}" -> rule "${rule.label}"${rule.mood ? ` (mood ${rule.mood} while it runs)` : ''}`
  const isTest = s.tool === 'Bash' && c.testCommands !== false && isTestCommand(subject)
  return `${s.tool} "${short(subject)}" -> no rule${isTest ? '; built-in test-run detection reacts' : ''}`
}

async function check($: Dollar, args: { config?: unknown; samples?: unknown }): Promise<string> {
  const samples = (Array.isArray(args.samples) ? args.samples : []).filter(
    (s): s is Sample => typeof s === 'object' && s !== null && typeof (s as Sample).tool === 'string',
  )
  const out: string[] = []
  let c: RepoConfig
  if (typeof args.config === 'string') {
    const parsed = parseConfig(args.config)
    c = parsed.config
    out.push(parsed.problems.length ? `Draft problems:\n${parsed.problems.map(p => `- ${p}`).join('\n')}` : 'Draft: ok')
    out.push(`Draft as read: ${describe(c)}`)
  } else {
    out.push(await loadConfig($))
    out.push('Loaded into the running owl.')
    c = config
  }
  if (samples.length) out.push('Samples:', ...samples.map(s => `- ${sampleLine(c, s)}`))
  return out.join('\n')
}

const HELP = [
  '/owl            show this help',
  '/owl say        make the owl say something now (asks Haiku)',
  '/owl hush       no remarks this session; it still reacts',
  '/owl unhush     remarks back on',
  '/owl hide       hide the owl this session',
  '/owl show       show it again',
  '/owl toggle     fold him down to his eyes, or bring him back (or click him)',
  '/owl config     re-read .claude/owl.json and owl.local.json and report what they hold',
  '',
  'To set the owl up for this repo: /clockwork-owl:owl-setup',
].join('\n')

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    now = await $.clock.now()
    sessionStart = sessionStart || now
    lastActivity = now
    nextBlink = now + 8000
    isOff = Boolean(await $.env.get('CLAUDE_SIDE_SESSION'))
    await $.tool.register({ name: 'owl_check', description: CHECK_DESCRIPTION, inputSchema: CHECK_SCHEMA })
    if (isOff) return result

    await $.command.register({ name: 'owl', description: 'The clockwork owl: say, hush, unhush, hide, show, config' })
    await loadConfig($).catch(() => {})
    tick?.cancel()
    tick = $.clock.every(TICK_MS, () => onTick($))

    if (!hasGreeted) {
      hasGreeted = true
      await remark($, 'greeting', 1, true)
    }
    return result
  })

  on('prompt.submit', async ($, e, next) => {
    now = await $.clock.now()
    lastActivity = now
    const text = e.text.trim()
    if (text && !text.startsWith('/')) note(`prompt: "${text.slice(0, 120)}"`)
    if (isLazyPrompt(text)) await remark($, 'lazyPrompt', 0.5)
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    now = await $.clock.now()
    if (e.agentId !== undefined) {
      turnAgents += 1
      if (turnAgents === 4) await remark($, 'agents', 0.7)
      return next(e)
    }
    isTurnRunning = true
    turnTools = 0
    turnAgents = 0
    lastActivity = now
    if (!moodUntil) await setMood($, 'working')
    return next(e)
  })

  // The owl watches tool calls through the classic Pre/PostToolUse events, never
  // by hooking tool.call or tool.run broadly: a hook there that may match a tool,
  // even one that only passes it on, turns off moving that tool to the
  // background and its live output, in every session the owl is installed in.
  on('classic.PreToolUse', async ($, e, next) => {
    if (e.tool !== CHECK_TOOL) {
      const rule = ruleFor(config, e.tool, e as unknown as Record<string, unknown>)
      if (rule?.mood) await setMood($, rule.mood)
    }
    return next(e)
  })

  on('classic.PostToolUse', async ($, e, next) => {
    const response = e.tool_response as { backgroundTaskId?: unknown } | null
    // A command sent to the background has no result yet: nothing to react to.
    const isBackgrounded = e.tool_name === 'Bash' && typeof response?.backgroundTaskId === 'string'
    if (!isBackgrounded) await afterTool($, e.tool_name, e.tool_input, false)
    return next(e)
  })

  on('classic.PostToolUseFailure', async ($, e, next) => {
    // An interrupt is the person's doing, not a failure of the command.
    if (!e.is_interrupt) await afterTool($, e.tool_name, e.tool_input, true)
    return next(e)
  })

  on('tool.run', { tool: CHECK_TOOL }, async ($, e) => {
    const args = e as unknown as { config?: unknown; samples?: unknown }
    return { result: await check($, args) }
  }).catch(() => ({ deny: 'owl_check failed; check the JSON by hand with python3 -m json.tool' }))

  on('classic.PermissionRequest', async ($, e, next) => {
    now = await $.clock.now()
    if (e.agent_id === undefined) {
      await setMood($, 'waiting')
      note(`asked permission for ${e.tool_name}`)
      await remark($, 'permission', 0.5)
    }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId !== undefined) return result
    now = await $.clock.now()
    isTurnRunning = false
    lastActivity = now
    turnsSinceRemark += 1
    const minutes = Math.round(e.durationMs / MINUTE)
    note(`turn ended after ${minutes}m with ${turnTools} tool calls${turnAgents ? ` and ${turnAgents} subagents` : ''}${e.isAborted ? ', interrupted' : ''}`)

    if (e.isAborted) await remark($, 'interrupt', 0.5)
    else if (e.durationMs > LONG_TURN) await remark($, 'longTurn', 0.7)

    if (!moodUntil) await setMood($, 'idle')
    maybeHaiku($)
    return result
  })

  on('session.compact', async ($, e, next) => {
    const result = await next(e)
    now = await $.clock.now()
    note('context was compacted')
    await remark($, 'compact', 0.6)
    return result
  })

  on('command.run', { command: 'owl' }, async ($, e) => {
    now = await $.clock.now()
    const arg = e.args.trim().toLowerCase()
    switch (arg) {
      case 'say':
        void haikuRemark($, true).catch(() => {})
        return { text: 'The owl is thinking of something to say.' }
      case 'hush':
        await update($, prefs, p => ({ ...p, isHushed: true }))
        await setView($, { bubble: null })
        return { text: 'The owl is hushed for this session. It still glares.' }
      case 'unhush':
        await update($, prefs, p => ({ ...p, isHushed: false }))
        return { text: 'The owl may speak again.' }
      case 'hide':
        await update($, prefs, p => ({ ...p, isHidden: true }))
        return { text: 'The owl is hidden for this session. /owl show brings it back.' }
      case 'show':
        await update($, prefs, p => ({ ...p, isHidden: false }))
        return { text: 'The owl is back.' }
      case 'toggle': {
        const isFolded = !(await read($, prefs)).isFolded
        await setFolded($, isFolded)
        return { text: isFolded ? 'The owl ducks down. Click his eyes to bring him back.' : 'The owl pops back up.' }
      }
      case 'config':
        return { text: await loadConfig($) }
      default:
        return { text: HELP }
    }
  })

  // A click on the owl, from its Client: fold him away, or bring him back.
  on('ui.message', async ($, e, next) => {
    const data = e.data as { type?: unknown } | null
    if (e.module.endsWith('owl-client.tsx') && data?.type === 'toggle') await setFolded($, !(await read($, prefs)).isFolded)
    return next(e)
  })

  // The Client failed to load or draw: fall back to the plain drawing, which
  // can't hear clicks (the engine draws the site again by itself).
  on('ui.fault', async ($, e, next) => {
    if (e.component === 'BesidePrompt') isClientBroken = true
    return next(e)
  })

  on('ui.render', { component: 'BesidePrompt' }, async ($, e, next) => {
    if (isOff || (e.surface !== 'terminal' && e.surface !== 'desktop')) return next(e)
    const p = await read($, prefs)
    if (p.isHidden) return next(e)
    const height = p.isFolded ? FOLDED_HEIGHT : HEIGHT
    const { floatColumns, floatRows } = e.props
    if (floatColumns < WIDTH + 2 || floatRows < height) return next(e)

    const v = await read($, view)
    const { Box, Text, Client } = $.ui.resolve(e)
    const bubbleWidth = Math.min(44, floatColumns - WIDTH - 3)
    const owl: OwlClientProps = { mood: v.mood, look: v.look, isBlinking: v.isBlinking, isFolded: p.isFolded }

    const sprite = isClientBroken ? (
      <Box flexDirection="column">
        {rows(p.isFolded ? foldedPixels(v.mood, v.look, v.isBlinking) : pixels(v.mood, v.look, v.isBlinking)).map(row => (
          <Text>
            {row.map(run => (
              <Text color={run.color} backgroundColor={run.backgroundColor}>
                {run.text}
              </Text>
            ))}
          </Text>
        ))}
      </Box>
    ) : (
      <Client key="owl" module="./owl-client.tsx" props={owl} width={WIDTH} height={height} />
    )

    return (
      <Box width={0}>
        <Box position="absolute" anchor="above" right={1} flexDirection="row" alignItems="flex-end">
          {v.bubble && !p.isFolded && bubbleWidth >= 16 ? (
            <Box borderStyle="round" borderColor={BUBBLE_BORDER} paddingX={1} marginRight={1} width={bubbleWidth}>
              <Text>{v.bubble}</Text>
            </Box>
          ) : null}
          {sprite}
        </Box>
      </Box>
    )
  })
}
