import type { EngineInterface, Register } from 'claude-code'

import { analyzeLine, escapeGlob, isAbs, looksDestructive } from './parse'
import type { Effect, Line, Shell } from './parse'

// Blast Radius: holds a command that could destroy work, and asks the person first.
// - tool.call (Bash): parse.ts lists what the command could delete or overwrite, and
//   bin/judge.py decides which of those lose work git can't give back, or reach outside
//   the repository. Anything it holds goes to the person as a question.
// - tool.call (Write): the same for a Write that replaces an existing file.
// The question is Claude Code's own AskUserQuestion dialog, which reaches the person in
// every permission mode (auto mode's classifier never answers it). Any answer but
// "Run it" refuses the call, so a dialog that times out, is dismissed or is interrupted
// refuses it too.

type Kind = 'git' | 'outside' | 'history' | 'uncommitted' | 'unknown'
export interface Finding {
  kind: Kind
  path: string
  detail: string
  cmd?: string
}
export interface Verdict {
  hold: boolean
  findings: Finding[]
  notes?: string[]
}

export const RUN = 'Run it'
export const STOP = "Don't run it"
const HEADINGS: Record<Kind, string> = {
  git: "Git's own data or the repository folder",
  outside: 'Outside the repository',
  history: 'Commits or stashes',
  uncommitted: "Work git can't restore",
  unknown: "Can't tell what it touches",
}
const ORDER: Kind[] = ['git', 'outside', 'history', 'uncommitted', 'unknown']
const LIST_MAX = 6
const POLL_SECONDS = '0.25'
const FAILED =
  'Blast Radius failed while checking this command, so it did not run. Tell the user; they can disable the mod with /plugin if it keeps failing.'

// A subagent: the folder it was started in (unset: its parent's), what it is called, and
// where its last top-level `cd` went.
export interface Agent {
  cwd?: string
  label: string
  lastCd?: string | { unknown: string }
}
const agents = new Map<string, Agent>()
// True while a question is up: one at a time, so each names the command it is about.
let asking = false

const oneLine = (s: string, max: number): string => {
  const flat = s.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 3)}...` : flat
}

function findingLines(verdict: Verdict): string[] {
  const lines: string[] = []
  for (const kind of ORDER) {
    const items = verdict.findings.filter(f => f.kind === kind)
    if (items.length === 0) continue
    lines.push(`${HEADINGS[kind]}:`)
    for (const f of items.slice(0, LIST_MAX)) {
      const where = kind === 'unknown' && f.cmd ? ` (in: ${oneLine(f.cmd, 80)})` : ''
      lines.push(`  ${f.path ? `${f.path}: ` : ''}${f.detail}${where}`)
    }
    if (items.length > LIST_MAX) lines.push(`  and ${items.length - LIST_MAX} more`)
  }
  return [...lines, ...(verdict.notes ?? [])]
}

export function question(command: string, verdict: Verdict, agent?: string): string {
  return [
    `Blast Radius held a command${agent ? ` from ${agent}` : ''}:`,
    `  ${oneLine(command, 200)}`,
    '',
    ...findingLines(verdict),
    '',
    'Run it?',
  ].join('\n')
}

export function refusal(answer: string, verdict: Verdict): string {
  const why =
    answer === STOP
      ? 'the user chose not to run it'
      : answer === ''
        ? 'the question was dismissed or interrupted'
        : `the user answered: ${answer}`
  return [
    `Blast Radius held this and did not run it: ${why}. What it would have touched:`,
    ...findingLines(verdict),
    'Do not retry it, or reach the same files another way, unless the user asks you to.',
  ].join('\n')
}

const unchecked = (why: string): Verdict => ({
  hold: true,
  findings: [{ kind: 'unknown', path: '', detail: `Blast Radius couldn't check it (${oneLine(why, 200)})` }],
})

// Where a call's relative paths land. The session's own shell is followed by Claude Code
// itself. A subagent's is not, and whether its `cd` lasts from one Bash call to the next
// isn't said, so its paths are also measured from its last `cd`, and held if either says
// so. One whose starting folder is unknown may start in the session's root as well as
// wherever the session's shell is now; one with a folder of its own starts there.
export function cwdsFor(
  agent: Agent | undefined,
  sessionCwd: string,
  sessionRoot: string,
): { cwd: string; altCwds?: string[]; lostCwd?: string } {
  if (agent === undefined) return { cwd: sessionCwd }
  const cwd = agent.cwd ?? sessionCwd
  const alts = [typeof agent.lastCd === 'string' ? agent.lastCd : null, agent.cwd === undefined ? sessionRoot : null]
  const altCwds = [...new Set(alts.filter((d): d is string => d !== null && d !== cwd))]
  const lost = typeof agent.lastCd === 'object' ? agent.lastCd.unknown : undefined
  return lost === undefined ? { cwd, altCwds } : { cwd, altCwds, lostCwd: `the subagent ran ${lost}` }
}

// The subagent's folder after a command that ran, given the folder it started from.
export function followCd(agent: Agent, endDir: Line['endDir'], base: string): Agent {
  if (endDir === null) return agent
  if (typeof endDir === 'object' || isAbs(endDir)) return { ...agent, lastCd: endDir }
  const from = agent.lastCd ?? base
  return { ...agent, lastCd: typeof from === 'string' ? `${from}/${endDir}` : from }
}

// The shell Claude Code runs Bash commands in. Like Claude Code, it takes CLAUDE_CODE_SHELL
// only when the path names bash or zsh, and otherwise the user's SHELL when that does, so
// a CLAUDE_CODE_SHELL of /bin/sh or fish is ignored. zsh (zsh-5.9 too) reads a line
// without splitting its variables into words; any other shell, or none named, is read as bash.
async function sessionShell($: EngineInterface): Promise<Shell> {
  const usable = (p: string | undefined): string | undefined => (p && /bash|zsh/.test(p) ? p : undefined)
  const path = usable(await $.env.get('CLAUDE_CODE_SHELL')) ?? usable(await $.env.get('SHELL')) ?? ''
  return /^zsh/.test(path.split('/').pop() ?? '') ? 'zsh' : 'bash'
}

async function judge($: EngineInterface, effects: Effect[], agentId: string | undefined): Promise<Verdict> {
  const sessionRoot = await $.session.root()
  const agent = agentId === undefined ? undefined : (agents.get(agentId) ?? { label: 'a subagent' })
  const request = JSON.stringify({ sessionRoot, ...cwdsFor(agent, await $.session.cwd(), sessionRoot), effects })
  try {
    const run = await $.process.run(['python3', '-I', `${$.plugin.root}/bin/judge.py`], {
      cwd: $.plugin.root,
      stdin: request,
      timeoutMs: 120_000,
    })
    if (run.exitCode !== 0) return unchecked(run.stderr.trim().split('\n').pop() || `judge.py exited ${run.exitCode}`)
    return JSON.parse(run.stdout) as Verdict
  } catch (error) {
    return unchecked(String((error as Error)?.message ?? error))
  }
}

// Puts the verdict to the person: the answer's label, or '' when nobody answered.
async function ask(
  $: EngineInterface,
  command: string,
  verdict: Verdict,
  agentId: string | undefined,
  signal: AbortSignal,
): Promise<string> {
  // Wait for an earlier question inside a `$` call, where waiting costs the hook nothing.
  while (asking) {
    if (signal.aborted) return ''
    await $.process.run(['sleep', POLL_SECONDS], { timeoutMs: 5000 })
  }
  if (signal.aborted) return ''
  asking = true // claimed with no await since the check, so two waiters can't both get it
  try {
    const label = agentId === undefined ? undefined : (agents.get(agentId)?.label ?? 'a subagent')
    return await $.ui.ask(question(command, verdict, label), { options: [STOP, RUN], header: 'Blast radius' })
  } catch {
    return ''
  } finally {
    asking = false
  }
}

export const register: Register = on => {
  on('agent.spawn', async ($, e, next) => {
    const started = await next(e)
    if (started.deny === undefined && started.agentId) {
      const known = agents.get(started.agentId)
      const cwd = e.cwd ?? known?.cwd
      const label = e.description || e.subagentType || 'a subagent'
      agents.set(started.agentId, cwd === undefined ? { ...known, label } : { ...known, label, cwd })
    }
    return started
  }).catch(($, e, next) => next(e)) // never stops a spawn

  // The folder a subagent starts in, a worktree of its own included: the spawn names it
  // only when the call set one.
  on('classic.SubagentStart', ($, e, next) => {
    const known = agents.get(e.agent_id)
    if (e.cwd && known?.cwd === undefined) agents.set(e.agent_id, { label: 'a subagent', ...known, cwd: e.cwd })
    return next(e)
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const { effects, endDir } = analyzeLine(e.command, await sessionShell($))
    const agentId = e.agentId
    const run = async () => {
      const ran = await next(e)
      if (agentId !== undefined && ran.deny === undefined && endDir !== null) {
        const agent = agents.get(agentId) ?? { label: 'a subagent' }
        agents.set(agentId, followCd(agent, endDir, agent.cwd ?? (await $.session.cwd())))
      }
      return ran
    }
    if (effects.length === 0) return run()
    const verdict = await judge($, effects, agentId)
    if (!verdict.hold) return run()
    const answer = await ask($, e.command, verdict, agentId, next.signal)
    return answer === RUN ? run() : { deny: refusal(answer, verdict) }
  }).catch(($, e, next) => {
    if (next.called) return next(e)
    // The check itself failed: let plainly harmless commands through, hold the rest.
    return looksDestructive(String(e.command ?? '')) ? { deny: FAILED } : next(e)
  })

  on('tool.call', { tool: 'Write' }, async ($, e, next) => {
    const command = `Write ${e.file_path}`
    const effects: Effect[] = [{ op: 'overwrite', dir: null, paths: [escapeGlob(e.file_path)], cmd: command }]
    const verdict = await judge($, effects, e.agentId)
    if (!verdict.hold) return next(e)
    const answer = await ask($, command, verdict, e.agentId, next.signal)
    return answer === RUN ? next(e) : { deny: refusal(answer, verdict) }
  }).catch(($, e, next) => (next.called ? next(e) : { deny: FAILED }))
}
