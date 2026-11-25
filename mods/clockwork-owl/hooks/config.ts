import type { Mood } from '../types'
import { LINES, type Moment } from './voice'

// A repo can tune the owl with .claude/owl.json (committed, shared with the
// repo) and .claude/owl.local.json (personal, kept out of git). Nothing in
// either runs: they are read as data, and the only place their text goes is
// the owl's own bubble and its Haiku prompt. The owl-setup skill writes them.
//
// {
//   "voice": "This repo is a robot owl's firmware. Tease about servos, not tests.",
//   "lines": { "greeting": ["Firmware again? My joints ache already."] },
//   "rules": [
//     { "label": "flash", "match": "make flash|esptool", "mood": "working",
//       "pass": ["Flashed. Nothing smoked."], "fail": ["The board said no."] },
//     { "label": "deploy", "tool": "Skill", "match": "^deploy$",
//       "pass": ["Shipped. Brace yourself."] }
//   ],
//   "testCommands": true
// }
//
// A rule watches one tool, Bash unless "tool" says otherwise ("mcp__x__*"
// matches by prefix), and its "match" regular expression is tested against
// that tool's subject (subjectOf below). "mood" shows while the call runs,
// then the owl turns happy or failed by its result and may say a "pass" or
// "fail" line. The label goes into the digest Haiku reads. "testCommands":
// false stops the built-in test-run detection.
//
// When both files exist the local one wins: its voice and testCommands replace
// the committed ones, its lines add to them, and its rules are tried first.

export type Rule = {
  label: string
  tool: string
  match: RegExp
  mood: Mood | null
  pass: string[]
  fail: string[]
}

export type RepoConfig = {
  voice: string | null
  lines: Partial<Record<Moment, string[]>>
  rules: Rule[]
  /** null: not set, which means on. */
  testCommands: boolean | null
}

export const EMPTY: RepoConfig = { voice: null, lines: {}, rules: [], testCommands: null }

export const MOODS: readonly Mood[] = ['idle', 'working', 'waiting', 'failed', 'happy', 'sleepy']

/** Keys a tool call carries beside the tool's own arguments. */
const ENVELOPE = new Set(['tool', 'tool_use_id', 'consent', 'agentId', 'agentType', 'origin'])

/**
 * What a rule's "match" is tested against for one call: Bash's command, a
 * skill's name, a file tool's path, an agent's type and description, and for
 * any other tool (MCP tools included) its arguments as JSON.
 */
export function subjectOf(tool: string, input: Record<string, unknown>): string {
  const s = (k: string) => (typeof input[k] === 'string' ? (input[k] as string) : '')
  switch (tool) {
    case 'Bash':
      return s('command')
    case 'Skill':
      return s('skill')
    case 'Edit':
    case 'Write':
    case 'Read':
    case 'NotebookEdit':
      return s('file_path') || s('notebook_path')
    case 'Agent':
      return `${s('subagent_type')} ${s('description')}`.trim()
    default: {
      const args: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(input)) if (!ENVELOPE.has(k)) args[k] = v
      return JSON.stringify(args)
    }
  }
}

function toolMatches(ruleTool: string, tool: string): boolean {
  return ruleTool.endsWith('*') ? tool.startsWith(ruleTool.slice(0, -1)) : ruleTool === tool
}

/** The first rule that watches this call, or null. */
export function ruleFor(config: RepoConfig, tool: string, input: Record<string, unknown>): Rule | null {
  let subject: string | null = null
  for (const rule of config.rules) {
    if (!toolMatches(rule.tool, tool)) continue
    subject ??= subjectOf(tool, input)
    if (rule.match.test(subject)) return rule
  }
  return null
}

function strings(v: unknown, max: number): string[] {
  if (!Array.isArray(v)) return []
  return v
    .filter((s): s is string => typeof s === 'string' && s.trim() !== '')
    .map(s => s.trim().slice(0, 160))
    .slice(0, max)
}

const KEYS = new Set(['voice', 'lines', 'rules', 'testCommands'])
const RULE_KEYS = new Set(['label', 'tool', 'match', 'mood', 'pass', 'fail'])

/** Parses one config file, keeping what is well formed and reporting the rest. */
export function parseConfig(text: string): { config: RepoConfig; problems: string[] } {
  const problems: string[] = []
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return { config: EMPTY, problems: ['not valid JSON'] }
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { config: EMPTY, problems: ['must be a JSON object'] }
  }
  const o = raw as Record<string, unknown>
  for (const k of Object.keys(o)) if (!KEYS.has(k)) problems.push(`unknown key "${k}"`)

  const voice = typeof o.voice === 'string' && o.voice.trim() ? o.voice.trim().slice(0, 600) : null

  const lines: Partial<Record<Moment, string[]>> = {}
  if (typeof o.lines === 'object' && o.lines !== null) {
    for (const [k, v] of Object.entries(o.lines as Record<string, unknown>)) {
      if (k in LINES) lines[k as Moment] = strings(v, 40)
      else problems.push(`unknown moment "${k}" in lines (known: ${Object.keys(LINES).join(', ')})`)
    }
  }

  const rules: Rule[] = []
  for (const [i, r] of (Array.isArray(o.rules) ? o.rules : []).slice(0, 30).entries()) {
    const name = `rule ${i + 1}`
    if (typeof r !== 'object' || r === null) {
      problems.push(`${name} is not an object`)
      continue
    }
    const rr = r as Record<string, unknown>
    for (const k of Object.keys(rr)) if (!RULE_KEYS.has(k)) problems.push(`${name} has unknown key "${k}"`)
    if (typeof rr.match !== 'string' || rr.match === '') {
      problems.push(`${name} has no "match"`)
      continue
    }
    let match: RegExp
    try {
      match = new RegExp(rr.match)
    } catch {
      problems.push(`${name}'s "match" is not a valid regular expression`)
      continue
    }
    const mood = typeof rr.mood === 'string' && MOODS.includes(rr.mood as Mood) ? (rr.mood as Mood) : null
    if (rr.mood !== undefined && mood === null) problems.push(`${name}'s mood must be one of ${MOODS.join(', ')}`)
    rules.push({
      label: typeof rr.label === 'string' && rr.label.trim() ? rr.label.trim().slice(0, 40) : name,
      tool: typeof rr.tool === 'string' && rr.tool.trim() ? rr.tool.trim() : 'Bash',
      match,
      mood,
      pass: strings(rr.pass, 20),
      fail: strings(rr.fail, 20),
    })
  }

  const testCommands = typeof o.testCommands === 'boolean' ? o.testCommands : null
  if (o.testCommands !== undefined && testCommands === null) problems.push('"testCommands" must be true or false')

  return { config: { voice, lines, rules, testCommands }, problems }
}

/** The committed config with the local one laid over it. */
export function mergeConfigs(shared: RepoConfig, local: RepoConfig): RepoConfig {
  const lines: Partial<Record<Moment, string[]>> = { ...shared.lines }
  for (const [k, v] of Object.entries(local.lines) as [Moment, string[]][]) lines[k] = [...(lines[k] ?? []), ...v]
  return {
    voice: local.voice ?? shared.voice,
    lines,
    rules: [...local.rules, ...shared.rules],
    testCommands: local.testCommands ?? shared.testCommands,
  }
}
