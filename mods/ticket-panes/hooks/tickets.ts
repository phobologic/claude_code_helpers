import type { EngineInterface } from 'claude-code'

// R1: a token is a ticket id exactly when `<tickets dir>/<token>.md` exists, the tickets dir being
// `TICKETS_DIR` if set, else the first folder holding `.tickets/` walking up from the session's
// root, resolved to its real path. That is how tk finds its tickets, so a worktree whose
// `.tickets` links to the repo's resolves to the repo's.

const MISS_RECHECK_MS = 60_000

// Ticket files found, kept for the load; files looked for and not found, with when (E2).
const found = new Set<string>()
const missedAt = new Map<string, number>()

// The walk's answer per session root: a tickets dir found, kept for the load; a root with none,
// with when, walked again once 60 seconds have passed. isTicket runs on every draw of a reply, so
// the walk runs once per root rather than once per call.
const dirByRoot = new Map<string, string>()
const noDirAt = new Map<string, number>()

// What a tk id can be: no `/`, so a token never reaches outside the tickets dir.
const TICKET_ID = /^[A-Za-z0-9._-]+$/

function parentOf(dir: string): string {
  const trimmed = dir.replace(/\/+$/, '')
  const cut = trimmed.lastIndexOf('/')
  return cut > 0 ? trimmed.slice(0, cut) : '/'
}

// The real path of `<dir>/.tickets` when it is a directory (or a link to one).
async function ticketsFolderIn($: EngineInterface, dir: string): Promise<string | undefined> {
  const path = `${dir.replace(/\/+$/, '')}/.tickets`
  try {
    const stat = await $.fs.stat(path, { resolve: true })
    return stat.kind === 'dir' ? (stat.realPath ?? path) : undefined
  } catch {
    return undefined // not there
  }
}

// The first `.tickets` folder from `root` up to `/`, as its real path.
async function walkUp($: EngineInterface, root: string): Promise<string | undefined> {
  let dir = root
  for (;;) {
    const tickets = await ticketsFolderIn($, dir)
    if (tickets !== undefined) return tickets
    const parent = parentOf(dir)
    if (parent === dir) return undefined
    dir = parent
  }
}

// The tickets dir (R1), or undefined when there is none: `TICKETS_DIR` as given when set (an empty
// value counts as unset, as in tk), else the first `.tickets` folder from the session's root up to
// `/`, as its real path. The walk's answer is cached per root (see `dirByRoot`).
export async function ticketsDir($: EngineInterface): Promise<string | undefined> {
  const fromEnv = await $.env.get('TICKETS_DIR')
  if (fromEnv) return fromEnv
  const root = await $.session.root()
  const cached = dirByRoot.get(root)
  if (cached !== undefined) return cached
  const now = await $.clock.now()
  const missed = noDirAt.get(root)
  if (missed !== undefined && now - missed < MISS_RECHECK_MS) return undefined
  const walked = await walkUp($, root)
  if (walked === undefined) noDirAt.set(root, now)
  else dirByRoot.set(root, walked)
  return walked
}

async function isFile($: EngineInterface, path: string): Promise<boolean> {
  try {
    return (await $.fs.stat(path)).kind === 'file'
  } catch {
    return false
  }
}

// How a caller wants R1 asked. `fresh` looks for a file even when it was missed less than 60
// seconds ago: for a caller that asks only when it has seen the file change (the side band's
// redraw), where a cached miss would outlast the file's appearing. The miss it may find is noted
// as any other, and a ticket found is kept as any other.
export type TicketLook = { fresh?: boolean }

// R1 for one token, with the file checks cached (E2): a ticket found stays found for the load; a
// file not found is looked for again only once 60 seconds have passed, or at once for a `fresh`
// look. A token no tk id could be (one with a `/`, say) is no ticket, and no file is looked for.
export async function isTicket($: EngineInterface, token: string, look: TicketLook = {}): Promise<boolean> {
  if (!TICKET_ID.test(token)) return false
  const dir = await ticketsDir($)
  if (dir === undefined) return false
  const file = `${dir}/${token}.md`
  if (found.has(file)) return true
  const now = await $.clock.now()
  const missed = missedAt.get(file)
  if (!look.fresh && missed !== undefined && now - missed < MISS_RECHECK_MS) return false
  if (await isFile($, file)) {
    found.add(file)
    return true
  }
  missedAt.set(file, now)
  return false
}
