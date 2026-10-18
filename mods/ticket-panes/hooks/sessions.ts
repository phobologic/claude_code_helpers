import type { EngineInterface } from 'claude-code'

// R3: the conversation a click on a ticket resumes is the one last recorded for that tickets dir
// and ticket, in `$.store` (which every session of the user shares) under
// `session:<tickets dir>:<ticket id>`. Only the side session writes it.

export type RecordedSession = { sessionId: string; cwd: string }

function sessionKey(dir: string, id: string): string {
  return `session:${dir}:${id}`
}

// Records `session` as the one to resume for ticket `id` of tickets dir `dir`.
export async function recordSession($: EngineInterface, dir: string, id: string, session: RecordedSession): Promise<void> {
  await $.store.set(sessionKey(dir, id), { sessionId: session.sessionId, cwd: session.cwd })
}

// The session last recorded for ticket `id` of tickets dir `dir`, or undefined when there is none
// (or what is stored there is not one).
export async function recordedSession($: EngineInterface, dir: string, id: string): Promise<RecordedSession | undefined> {
  const value = await $.store.get(sessionKey(dir, id))
  if (typeof value !== 'object' || value === null) return undefined
  const { sessionId, cwd } = value as Record<string, unknown>
  return typeof sessionId === 'string' && typeof cwd === 'string' ? { sessionId, cwd } : undefined
}
