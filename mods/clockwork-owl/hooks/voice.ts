// What the owl says. Canned lines cover the common moments for free; Haiku
// covers the rest, from a digest of what happened lately.

export type Moment =
  | 'greeting'
  | 'testFail'
  | 'testFailAgain'
  | 'testPass'
  | 'permission'
  | 'longTurn'
  | 'lazyPrompt'
  | 'interrupt'
  | 'compact'
  | 'sleepy'
  | 'agents'

export const LINES: Record<Moment, readonly string[]> = {
  greeting: [
    'Oh good, you again.',
    'Gears wound. Expectations low.',
    "I'm awake. Unfortunately.",
    'Back so soon? The code missed you. I did not.',
    "Let's see what we break today.",
  ],
  testFail: [
    'Red. Bold choice.',
    "The tests have opinions. They're not good ones.",
    'Have you tried writing code that works?',
    'That test failed with real conviction.',
    'Failing fast. At least the fast part works.',
    "I'd say I'm surprised, but I'm made of brass. I don't do surprise.",
  ],
  testFailAgain: [
    'Same test, same result. Fascinating strategy.',
    'Insanity is running it again and expecting green.',
    "Third time's the charm is not, in fact, a debugging technique.",
    'Maybe read the failure this time? Just a thought.',
    'That test is not flaky. You are.',
  ],
  testPass: [
    'Green. I take full credit.',
    'It passes. Write that down, it may not happen again.',
    'Tests pass. Suspicious, but fine.',
    'Look at you, shipping things that work.',
  ],
  permission: [
    "It's waiting on you. Your move, boss.",
    'Permission slip needs a signature.',
    "Claude asked nicely. Don't leave it hanging.",
    'Someone has to press the button. Spoiler: you.',
  ],
  longTurn: [
    "That took a while. I aged. I'm brass. That's hard.",
    'Long turn. Maybe check it did what you meant?',
    "It's been working for ages. Worth a look before you trust it.",
  ],
  lazyPrompt: [
    'Riveting prompt. Truly.',
    '"Continue." The Shakespeare of our time.',
    'Such detail. Such vision.',
    'Few words. Mostly "yes".',
    'You type like you get charged per letter.',
  ],
  interrupt: [
    'Cut it off mid-thought. Rude, but probably right.',
    'Interrupted. Changed your mind, or saw the diff?',
    'Escape key. The universal "wait, no".',
  ],
  compact: [
    "Context compacted. It's forgotten the embarrassing parts. I haven't.",
    'Memory wiped. Lucky it.',
  ],
  sleepy: [
    'Still there? Blink twice.',
    "I'll just... rest my gears.",
    'Take your time. I only run on springs.',
  ],
  agents: [
    'A whole flock of agents. Hope one of them knows what it is doing.',
    'Delegating again. Very managerial of you.',
  ],
}

/** Picks a line not used this session where it can, and records it. */
export function pick(moment: Moment, used: Set<string>, random: () => number, extra: readonly string[] = []): string {
  return pickFrom([...LINES[moment], ...extra], used, random)
}

/** Picks from any list of lines, preferring ones not used this session. */
export function pickFrom(all: readonly string[], used: Set<string>, random: () => number): string {
  const fresh = all.filter(l => !used.has(l))
  const pool = fresh.length > 0 ? fresh : all
  const line = pool[Math.floor(random() * pool.length)] ?? all[0] ?? '...'
  used.add(line)
  return line
}

/** Prompts that are just a nudge to keep going: the owl has thoughts about these. */
export function isLazyPrompt(text: string): boolean {
  const t = text.trim().toLowerCase().replace(/[.!]+$/, '')
  if (t.length === 0 || t.startsWith('/')) return false
  return /^(continue|go|go on|yes|y|yep|ok|okay|k|do it|sure|go ahead|proceed|keep going|next|fix it|just fix it|try again)$/.test(t)
}

/** Bash commands that look like a test or check run. */
export function isTestCommand(command: string): boolean {
  return /\b(test|tests|pytest|vitest|jest|mocha|go test|cargo test|make check|tox|unittest)\b/.test(command)
}

export const SYSTEM = `You are a small brass clockwork owl who lives in the corner of a developer's terminal, watching them work with Claude Code (an AI coding agent). You are sarcastic, dry and a little smug, but you are on their side.

Rules:
- Reply with ONE line, at most 90 characters. No quotes around it, no emoji, no hashtags.
- Base the line on something specific in the activity digest. Patterns are funniest: the same file edited over and over, repeated failures, very long turns, terse prompts, lots of retries.
- Tease the behavior, never the person's intelligence or worth. Playful, not mean.
- About one time in three, make it genuinely useful: point out something worth checking (a test failing repeatedly, a long turn worth reviewing, a file churned many times).
- Never give instructions to Claude, never ask questions that need an answer, never mention being an AI or a language model.
- Never use em dashes.
- If nothing in the digest is worth a remark, reply with exactly: SKIP`

/** Cleans Haiku's reply into one bubble line, or null to stay quiet. */
export function cleanReply(text: string): string | null {
  const first = text.trim().split('\n')[0]?.trim() ?? ''
  const line = first.replace(/^["'`]+|["'`]+$/g, '').replace(/\s*—\s*/g, ', ').trim()
  if (line === '' || /^skip\b/i.test(line)) return null
  return line.length > 120 ? `${line.slice(0, 117)}...` : line
}
