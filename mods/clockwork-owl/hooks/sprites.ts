import type { Look, Mood } from '../types'

// The owl is a 12x12 pixel grid drawn with half blocks: each terminal row holds
// two pixel rows, the upper half as the glyph's color and the lower as its
// background. '.' is transparent, so the transcript shows through.

export const WIDTH = 12
export const HEIGHT = 6

const PALETTE: Record<string, string> = {
  B: '#b5893f', // brass
  D: '#5c4020', // dark bronze
  L: '#e3c27a', // light brass
  G: '#8a6a2f', // rivets
  E: '#f2a900', // amber eye
  W: '#ffe066', // wide-awake eye
  R: '#e0453a', // annoyed eye
  P: '#1b1b1b', // pupil
}

// Rows 4 and 5 are the eyes: `@` marks where each 3x2 eye goes.
const BODY = [
  '..D......D..',
  '.DBD....DBD.',
  '.BBBBBBBBBB.',
  'BBLLLBBLLLBB',
  'BL@@@LL@@@LB',
  'BL@@@LL@@@LB',
  'BBLLLDDLLLBB',
  '.BBBBDDBBBB.',
  '.BGBBBBBBGB.',
  '.BBGBBBBGBB.',
  '..BBGBBGBB..',
  '...DD..DD...',
]

const FLARED_TUFTS = ['D.D......D.D', '.DBD....DBD.']

/** One eye: its top and bottom pixel rows. */
type Eye = [string, string]

function openEye(color: string, look: Look): Eye {
  const c = color
  switch (look) {
    case 'left':
      return [`P${c}${c}`, `${c}${c}${c}`]
    case 'right':
      return [`${c}${c}P`, `${c}${c}${c}`]
    case 'down':
      return [`${c}${c}${c}`, `${c}P${c}`]
    default:
      return [`${c}P${c}`, `${c}${c}${c}`]
  }
}

function eyeFor(mood: Mood, look: Look, isBlinking: boolean): Eye {
  if (isBlinking) return ['LLL', 'DDD']
  switch (mood) {
    case 'waiting':
      // Waiting, he looks down at the prompt, unless the mouse has his attention.
      return openEye('W', look === 'center' ? 'down' : look)
    case 'failed':
      return ['DDD', 'RPR']
    case 'happy':
      return ['LDL', 'DLD']
    case 'sleepy':
      return ['DDD', 'EPE']
    case 'working':
      return openEye('E', look)
    default:
      return openEye('E', look)
  }
}

/** The pixel grid for a mood, as 12 strings of palette letters and dots. */
export function pixels(mood: Mood, look: Look, isBlinking: boolean): string[] {
  const [top, bottom] = eyeFor(mood, look, isBlinking)
  const rows = BODY.map((row, i) => {
    if (i === 4) return row.replace('@@@', top).replace('@@@', top)
    if (i === 5) return row.replace('@@@', bottom).replace('@@@', bottom)
    return row
  })
  if (mood === 'failed') {
    rows[0] = FLARED_TUFTS[0] as string
    rows[1] = FLARED_TUFTS[1] as string
  }
  return rows
}

/** Terminal rows the owl takes folded: ear tufts, brow and eyes, peering over the prompt. */
export const FOLDED_HEIGHT = 3

/** The pixel grid folded: only the top of his head. */
export function foldedPixels(mood: Mood, look: Look, isBlinking: boolean): string[] {
  return pixels(mood, look, isBlinking).slice(0, FOLDED_HEIGHT * 2)
}

/**
 * Where the pupils point for a pointer at column x, row y of the owl's region
 * (12 columns; the eyes are on row 2, the left eye in columns 2-4, the right in
 * 7-9): toward the pointer, or at you when it is between his eyes.
 */
export function lookAt(x: number, y: number): Look {
  if (x <= 3) return 'left'
  if (x >= 8) return 'right'
  return y >= 3 ? 'down' : 'center'
}

/** A run of cells drawn the same way. */
export type Run = { text: string; color?: string; backgroundColor?: string }

function cell(top: string, bottom: string): Run {
  const t = PALETTE[top]
  const b = PALETTE[bottom]
  if (t && b) return { text: '▀', color: t, backgroundColor: b }
  if (t) return { text: '▀', color: t }
  if (b) return { text: '▄', color: b }
  return { text: ' ' }
}

/** The grid as terminal rows, each a list of runs with neighbours of one style merged. */
export function rows(grid: string[]): Run[][] {
  const out: Run[][] = []
  for (let y = 0; y < grid.length; y += 2) {
    const upper = grid[y] ?? ''
    const lower = grid[y + 1] ?? ''
    const runs: Run[] = []
    for (let x = 0; x < WIDTH; x++) {
      const next = cell(upper[x] ?? '.', lower[x] ?? '.')
      const last = runs[runs.length - 1]
      if (last && last.color === next.color && last.backgroundColor === next.backgroundColor) {
        last.text += next.text
      } else {
        runs.push(next)
      }
    }
    out.push(runs)
  }
  return out
}

export const BUBBLE_BORDER = PALETTE.B as string
