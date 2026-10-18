import type { EngineInterface } from 'claude-code'

// R1: a token is a ticket id exactly when `<tickets dir>/<token>.md` exists, the tickets dir being
// `TICKETS_DIR` if set, else the first folder holding `.tickets/` walking up from the session's
// root, resolved to its real path. That is how tk finds its tickets, so a worktree whose
// `.tickets` links to the repo's resolves to the repo's.

const MISS_RECHECK_MS = 60_000

// Ticket files found, kept for the load; files looked for and not found, with when (E2).
const found = new Set<string>()
const missedAt = new Map<string, number>()

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

// The tickets dir (R1), or undefined when there is none: `TICKETS_DIR` as given when set (an empty
// value counts as unset, as in tk), else the first `.tickets` folder from the session's root up to
// `/`, as its real path.
export async function ticketsDir($: EngineInterface): Promise<string | undefined> {
  const fromEnv = await $.env.get('TICKETS_DIR')
  if (fromEnv) return fromEnv
  let dir = await $.session.root()
  for (;;) {
    const tickets = await ticketsFolderIn($, dir)
    if (tickets !== undefined) return tickets
    const parent = parentOf(dir)
    if (parent === dir) return undefined
    dir = parent
  }
}

async function isFile($: EngineInterface, path: string): Promise<boolean> {
  try {
    return (await $.fs.stat(path)).kind === 'file'
  } catch {
    return false
  }
}

// R1 for one token, with the file checks cached (E2): a ticket found stays found for the load; a
// file not found is looked for again only once 60 seconds have passed.
export async function isTicket($: EngineInterface, token: string): Promise<boolean> {
  const dir = await ticketsDir($)
  if (dir === undefined) return false
  const file = `${dir}/${token}.md`
  if (found.has(file)) return true
  const now = await $.clock.now()
  const missed = missedAt.get(file)
  if (missed !== undefined && now - missed < MISS_RECHECK_MS) return false
  if (await isFile($, file)) {
    found.add(file)
    return true
  }
  missedAt.set(file, now)
  return false
}
