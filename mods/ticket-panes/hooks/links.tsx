import type { EngineInterface, On } from 'claude-code'

import { open } from './noun'
import type { Role } from './role'
import { isTicket } from './tickets'

// The `tickets:` button row under replies that mention tickets (D2). Each block of an assistant
// reply drawn on the terminal that mentions real tk tickets (R1) gets one row under it: a dim
// `tickets:`, a button per ticket in order of first mention, each once, at most 8, then a dim
// `+N more`. A button opens its ticket as `$.ticketPanes.open({ id })` does, which decides where
// it shows (a side pane, or the read-only pane). The reply itself is the engine's row, drawn
// first and unchanged; ids in its text stay plain.
//
// Ids only in fenced code blocks don't count (D20): those are mostly commands and logs. Ids in
// inline code and plain text do.

// The most buttons a row draws; the rest are counted in `+N more` (D2).
const MAX_BUTTONS = 8

// A candidate ticket id: a prefix of letters, digits, `.` and `_` (no `-`), then `-` and four
// lowercase letters or digits. Not preceded by a word character, `/`, `.` or `-`, so a path
// (`docs/x-ab12.md`) or the tail of a longer token (`a-x-ab12`) is none; not followed by a word
// character or `-`, so `x-ab12s` and `x-ab12-z` are none, while `x-ab12.` ending a sentence is one.
const CANDIDATE = /(?<![\w/.-])[A-Za-z0-9][A-Za-z0-9._]*-[a-z0-9]{4}(?![\w-])/g

// A line that opens a fenced code block: three or more backticks or tildes after any indent, and
// the rest of the line (the info string). The run is the fence a close must match.
const FENCE_OPEN = /^\s*(`{3,}|~{3,})(.*)$/
// A line that may close one: a run of backticks or tildes and nothing else (a close takes no info
// string).
const FENCE_CLOSE = /^\s*(`+|~+)\s*$/

// The fence `line` opens, or '' when it opens none. A backtick fence's info string holds no
// backtick (CommonMark), so a line led by inline code in triple backticks (```x-ab12``` ...) is
// text, not a fence.
function fenceOpenedBy(line: string): string {
  const open = FENCE_OPEN.exec(line)
  if (open === null) return ''
  const [, run = '', info = ''] = open
  return run.startsWith('`') && info.includes('`') ? '' : run
}

// Whether `line` closes the block `fence` opened: a bare run of the same character, at least as
// long (CommonMark), so a `~~~` inside a ``` block or a ```sh inside an open one closes nothing.
function closesFence(line: string, fence: string): boolean {
  const run = FENCE_CLOSE.exec(line)?.[1]
  return run !== undefined && run[0] === fence[0] && run.length >= fence.length
}

// One blockquote marker leading a line: `>` after any indent. The space after it may stay, as the
// fence checks take any indent.
const QUOTE_MARKER = /^\s*>/
// A list item's marker leading a line: `-`, `*`, `+`, or up to nine digits and `.` or `)`, after
// any indent, then a space or tab (CommonMark). A fence may start on the marker's line (`1. ```sh`).
const LIST_MARKER = /^\s*(?:[-*+]|\d{1,9}[.)])[ \t]+/

// How many blockquote markers lead `line`, at most `most`, and the line after them.
function unquote(line: string, most: number): [number, string] {
  let depth = 0
  let rest = line
  while (depth < most) {
    const marker = QUOTE_MARKER.exec(rest)
    if (marker === null) break
    rest = rest.slice(marker[0].length)
    depth += 1
  }
  return [depth, rest]
}

// How many blockquote markers lead `line` and the line after them, with the list markers among
// and after them taken off too, in any order and nesting (`- - ```, `> - > ```). A list marker
// adds no depth; a quote marker adds one.
function unmark(line: string): [number, string] {
  let depth = 0
  let rest = line
  for (;;) {
    const list = LIST_MARKER.exec(rest)
    if (list !== null) {
      rest = rest.slice(list[0].length)
      continue
    }
    const quote = QUOTE_MARKER.exec(rest)
    if (quote === null) return [depth, rest]
    rest = rest.slice(quote[0].length)
    depth += 1
  }
}

// The lines of `text` outside fenced code blocks, fence lines left out, with their blockquote
// markers taken off. A fence inside a blockquote (`> ```) is one too, at that quote's depth: a
// line with fewer markers ends the quote, and the block with it (CommonMark). Inside a block
// opened outside a quote, a `> ``` line is the block's text. A fence not closed runs to the end
// of the text, as CommonMark has it (a reply still streaming shows the ids after it once it
// closes). A fence on a list marker's line opens a block too, with list and quote markers in any
// order and nesting (`- > ```, `> - ```, `- - ```, `> - > ```); the block's indented lines and
// close need no list marker, only the quote markers. Inside a block, a list marker's fence line
// (`- ```) is the block's text. Lines end in LF or CRLF.
function linesOutsideFences(text: string): string[] {
  const kept: string[] = []
  let fence = ''
  let fenceDepth = 0
  for (const raw of text.split(/\r?\n/)) {
    if (fence !== '') {
      const [depth, rest] = unquote(raw, fenceDepth)
      if (depth === fenceDepth) {
        if (closesFence(rest, fence)) fence = ''
        continue
      }
      // The quote holding the block ended, and the block with it: the line is read afresh.
    }
    const [depth, line] = unmark(raw)
    fence = fenceOpenedBy(line)
    fenceDepth = depth
    if (fence === '') kept.push(line)
  }
  return kept
}

// The candidate ticket ids `text` mentions outside fenced code blocks, in order of first mention,
// each once. Candidates only: whether each is a ticket is R1's to say (`isTicket`).
export function ticketsIn(text: string): string[] {
  const seen = new Set<string>()
  for (const line of linesOutsideFences(text)) {
    for (const match of line.matchAll(CANDIDATE)) seen.add(match[0])
  }
  return [...seen]
}

// The candidates in `text` that are tickets (R1), in the same order. One at a time, so the first
// look finds and caches the tickets dir for the rest (tickets.ts).
async function realTicketsIn($: EngineInterface, text: string): Promise<string[]> {
  const tickets: string[] = []
  for (const token of ticketsIn(text)) {
    if (await isTicket($, token)) tickets.push(token)
  }
  return tickets
}

// A line in the debug log; a log that refuses it is passed over, as it has nowhere else to go.
function debugLog($: EngineInterface, text: string): void {
  try {
    $.ui.log(text, { to: 'debug' })
  } catch {
    // Nowhere to log.
  }
}

// A ticket button's press: the noun's body opens the ticket and tells the person about its own
// failures. It is called directly: a `$.ticketPanes.open` from this mod's own closure skips the
// mod's own hooks (the engine's recursion skip), so only the noun's stub would answer, rejecting.
// Should the open still reject, the press does nothing but log a line to the debug log.
async function pressTicket($: EngineInterface, id: string): Promise<void> {
  try {
    await open($, id)
  } catch (error) {
    debugLog($, `ticket-panes: the ${id} button could not open it: ${String(error)}`)
  }
}

// This module's hooks, registered by register.tsx.
export function registerLinks(on: On): void {
  // A reply block on the terminal that mentions tickets: the engine's row, then the ticket row.
  // Every other block, a summary of the model's text, and any other surface draw as the hooks
  // beneath do. The row sits under the reply's text, past its bullet, and wraps when it is wider
  // than the screen.
  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    if (e.surface !== 'terminal' || e.props.isSummary) return next(e)
    const tickets = await realTicketsIn($, e.props.text)
    if (tickets.length === 0) return next(e)
    const { Box, Button, Text } = $.ui.resolve(e)
    const more = tickets.length - MAX_BUTTONS
    return (
      <Box flexDirection="column">
        {await next(e)}
        <Box flexDirection="row" flexWrap="wrap" columnGap={1} paddingLeft={2}>
          <Text dimColor>tickets:</Text>
          {tickets.slice(0, MAX_BUTTONS).map(id => (
            <Button key={`ticket-${id}`} label={id} onPress={() => pressTicket($, id)} />
          ))}
          {more > 0 ? <Text dimColor>{`+${more} more`}</Text> : null}
        </Box>
      </Box>
    )
  })
}

// This module's ready step: register.tsx's `runReady` calls it once per load, when the role is
// first known. It has nothing to start.
export async function linksReady($: EngineInterface, known: Role): Promise<void> {}
