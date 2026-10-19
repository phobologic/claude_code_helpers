import type { ElementTable, EngineInterface, RenderElement } from 'claude-code'

import type { TicketPanesBandMode } from '../types'
import { isTicket, ticketFile } from './tickets'

// A ticket drawn from its file, as the side session's band (band.tsx) and the read-only ticket
// pane (noun.tsx) show it. `readTicket` reads the file tk keeps and parses it; `TicketView` draws
// the result with the elements its caller's draw resolved (`$.ui.resolve(e)`), in one of three
// forms: compact (the ticket without its notes), expanded (with them) or collapsed (one row).

// A ticket as its file holds it. A field the file lacks is ''.
export type Ticket = {
  id: string
  status: string
  type: string
  priority: string
  parent: string
  // The first `# ` heading above `## Notes`.
  title: string
  // Markdown: everything between the title and `## Notes` that is not the criteria.
  description: string
  // Markdown: the acceptance criteria (E18), from the line that starts them up to the next
  // heading outside a fenced block; '' when there are none.
  criteria: string
  // Each note as written, oldest first: its `**<time>**` line and its text.
  notes: string[]
}

// A ticket whose file could not be read, and why, in one line.
export type TicketProblem = { id: string; problem: string }

export type TicketRead = Ticket | TicketProblem

// The elements a view draws with: the caller passes its draw's `$.ui.resolve(e)`.
export type TicketElements = Pick<ElementTable, 'Box' | 'Button' | 'Markdown' | 'Text'>

export type TicketViewProps = {
  elements: TicketElements
  ticket: TicketRead
  mode: TicketPanesBandMode
  // Draws `Show all` in compact and `Show less` in expanded.
  showToggles?: boolean
  // Run by `Show less` and by the collapsed row's `+`.
  onCompact?: () => void
  // Run by `Show all`.
  onExpand?: () => void
}

// The addresses of what a view draws, for its callers' tests and hooks; note `i` (from 0) is
// `ticket-note-<i>`.
export const VIEW_KEYS = {
  description: 'ticket-description',
  criteria: 'ticket-criteria',
  showAll: 'ticket-show-all',
  showLess: 'ticket-show-less',
  restore: 'ticket-restore',
} as const

const NOT_FOUND = 'file not found'

// ---------- the file ----------

// tk's own lines: the heading it puts above the first note, and the `**<UTC time>**` line it
// writes above each one (bin/run-tickets-plan reads notes the same way).
const NOTES_HEADING = /^## Notes\s*$/
const NOTE_STAMP = /^\*\*\d{4}-\d\d-\d\dT[\d:.]+Z?\*\*\s*$/
// E18: what starts the acceptance criteria, as bin/run-tickets-plan's AC_RE finds them.
const CRITERIA_START = /^\s*(#+\s*acceptance criteria|\*\*acceptance criteria\*\*|acceptance criteria:)/i
// What ends them, as the planner's count of them stops: a line led by `#` or `**`, though not by
// `**-` (a bold flag such as `**--watch**` opens no section).
const NEXT_HEADING = /^\s*(#|\*\*(?!-))/
// A line that opens a fenced code block: three or more backticks or tildes, after any indent. The
// run is the fence a close must match.
const FENCE = /^\s*(`{3,}|~{3,})/
// A line that may close one: a run of backticks or tildes and nothing else (a close takes no info
// string).
const BARE_FENCE = /^\s*(`+|~+)\s*$/
const FIELD = /^(status|type|priority|parent):(.*)$/

type Fields = Pick<Ticket, 'status' | 'type' | 'priority' | 'parent'>

// The frontmatter's fields and the lines after it. Frontmatter is a first line `---` up to the
// next `---` line; a file without it is all body.
function splitFrontmatter(lines: string[]): { fields: Fields; body: string[] } {
  const fields: Fields = { status: '', type: '', priority: '', parent: '' }
  const end = lines[0] === '---' ? lines.indexOf('---', 1) : -1
  if (end < 0) return { fields, body: lines }
  for (const line of lines.slice(1, end)) {
    const field = FIELD.exec(line)
    if (field) fields[field[1] as keyof Fields] = field[2]!.trim()
  }
  return { fields, body: lines.slice(end + 1) }
}

// Whether `line` closes the block `fence` opened: a bare run of the same character, at least as
// long (CommonMark), so a `~~~` inside a ``` block or a ```sh inside an open one closes nothing.
function closesFence(line: string, fence: string): boolean {
  const run = BARE_FENCE.exec(line)?.[1]
  return run !== undefined && run[0] === fence[0] && run.length >= fence.length
}

// Where the criteria starting at `start` end: the next heading line outside a fenced block (a
// shell `# comment` in an example is not a heading), else the end of the lines. The fence is
// tracked from the top of the lines, so one opened above the criteria is still open at `start`.
function criteriaEnd(lines: string[], start: number): number {
  let fence = ''
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    if (fence !== '') {
      if (closesFence(line, fence)) fence = ''
    } else if (i > start && NEXT_HEADING.test(line)) {
      return i
    } else {
      fence = FENCE.exec(line)?.[1] ?? ''
    }
  }
  return lines.length
}

// The criteria's lines and the rest, from the lines between the title and `## Notes`.
function splitCriteria(lines: string[]): { criteria: string[]; rest: string[] } {
  const start = lines.findIndex(line => CRITERIA_START.test(line))
  if (start < 0) return { criteria: [], rest: lines }
  const end = criteriaEnd(lines, start)
  return { criteria: lines.slice(start, end), rest: [...lines.slice(0, start), ...lines.slice(end)] }
}

// The notes from the lines after `## Notes`: a block per `**<time>**` line, a heading inside a
// note staying in it. Text above the first such line is a block of its own.
function splitNotes(lines: string[]): string[] {
  let block: string[] = []
  const blocks = [block]
  for (const line of lines) {
    if (NOTE_STAMP.test(line)) {
      block = [line]
      blocks.push(block)
    } else {
      block.push(line)
    }
  }
  return blocks.map(lines => lines.join('\n').trim()).filter(text => text !== '')
}

// A ticket from its file's text, as tk writes it: frontmatter, a `# <title>` line, the
// description, and `## Notes` with the notes, the newest last. The criteria are looked for only
// above `## Notes`, so a note that restates them stays a note.
export function parseTicket(id: string, text: string): Ticket {
  const { fields, body } = splitFrontmatter(text.replace(/\r\n?/g, '\n').split('\n'))
  const heading = body.findIndex(line => NOTES_HEADING.test(line))
  const notesAt = heading < 0 ? body.length : heading
  const above = body.slice(0, notesAt)
  // With no title, `titleAt` is -1: the description starts at the top, and `above[-1]` is
  // undefined.
  const titleAt = above.findIndex(line => line.startsWith('# '))
  const { criteria, rest } = splitCriteria(above.slice(titleAt + 1))
  return {
    id,
    ...fields,
    title: above[titleAt]?.slice(2).trim() ?? '',
    description: rest.join('\n').trim(),
    criteria: criteria.join('\n').trim(),
    notes: splitNotes(body.slice(notesAt + 1)),
  }
}

function oneLine(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).replace(/\s+/g, ' ').trim()
}

// Ticket `id` from the file R1 names (`ticketFile`), or the problem that kept it from being read:
// `file not found` when R1 finds no such ticket or the file has gone since, else what failed. It
// never rejects, so a draw that calls it always has something to draw.
export async function readTicket($: EngineInterface, id: string): Promise<TicketRead> {
  try {
    const path = await ticketFile($, id)
    if (path === undefined || !(await isTicket($, id))) return { id, problem: NOT_FOUND }
    try {
      return parseTicket(id, await $.fs.read(path))
    } catch (err) {
      // R1 keeps a ticket it found for the load, so the file may be gone since.
      return { id, problem: (await $.fs.exists(path)) ? oneLine(err) : NOT_FOUND }
    }
  } catch (err) {
    return { id, problem: oneLine(err) }
  }
}

// ---------- drawing ----------

// The engine refuses a whole tree whose text holds a control character other than tab and
// newline, so pasted terminal output in a note would blank the view. Escape sequences go whole:
// CSI (`ESC [`, colours and cursor moves), the OSC, DCS, SOS, PM and APC strings (hyperlinks,
// titles) up to BEL or ST, or to the end of the line when unterminated, and the short escapes
// (`ESC ( B`). Any other control character goes alone.
const ESCAPE_SEQUENCE = /\x1b(?:\[[0-?]*[ -/]*[@-~]|[\]PX^_][^\x07\x1b\n]*(?:\x07|\x1b\\)?|[ -/]*[0-~])/g
const CONTROL = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/g

function drawable(text: string): string {
  return text.replace(ESCAPE_SEQUENCE, '').replace(CONTROL, '')
}

// The parts that are there, between dots.
function joined(parts: string[]): string {
  return parts.filter(part => part !== '').join(' · ')
}

function noteCount(n: number): string {
  return n === 1 ? '1 note' : `${n} notes`
}

function noop(): void {}

// A ticket in one of the three forms (D7), or the one row its problem is. Compact is a bordered
// box: the id (the box's first row, bold), its status, type and priority, title and parent; the
// description and criteria; how many notes; `Show all` with toggles. Expanded adds each note,
// and `Show less` takes the place of `Show all`. Collapsed is one row: a `+` button, then
// `<id> · <status> · <title>`. Every text is passed through `drawable`, and an empty one is not
// drawn: a Box draws a string child, '' too, as a row.
export function TicketView(props: TicketViewProps): RenderElement {
  const { elements, ticket, mode, showToggles, onCompact = noop, onExpand = noop } = props
  const { Box, Button, Markdown, Text } = elements
  if ('problem' in ticket) return <Text wrap="truncate">{drawable(`ticket ${ticket.id}: ${ticket.problem}`)}</Text>
  if (mode === 'collapsed') {
    return (
      <Box flexDirection="row" gap={1}>
        <Button key={VIEW_KEYS.restore} label="+" onPress={onCompact} />
        <Text wrap="truncate">{drawable(joined([ticket.id, ticket.status, ticket.title]))}</Text>
      </Box>
    )
  }
  const isExpanded = mode === 'expanded'
  const facts = joined([ticket.status, ticket.type, ticket.priority === '' ? '' : `P${ticket.priority}`])
  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1} gap={1}>
      <Box flexDirection="column">
        <Text bold>{drawable(ticket.id)}</Text>
        {facts === '' ? null : <Text>{drawable(facts)}</Text>}
        {ticket.title === '' ? null : <Text>{drawable(ticket.title)}</Text>}
        {ticket.parent === '' ? null : <Text>{drawable(`parent ${ticket.parent}`)}</Text>}
      </Box>
      {ticket.description === '' ? null : <Markdown key={VIEW_KEYS.description} text={drawable(ticket.description)} />}
      {ticket.criteria === '' ? null : <Markdown key={VIEW_KEYS.criteria} text={drawable(ticket.criteria)} />}
      <Box flexDirection="row" gap={1}>
        <Text dimColor>{noteCount(ticket.notes.length)}</Text>
        {!showToggles
          ? null
          : isExpanded
            ? <Button key={VIEW_KEYS.showLess} label="Show less" onPress={onCompact} />
            : <Button key={VIEW_KEYS.showAll} label="Show all" onPress={onExpand} />}
      </Box>
      {isExpanded ? ticket.notes.map((note, i) => <Markdown key={`ticket-note-${i}`} text={drawable(note)} />) : null}
    </Box>
  )
}
