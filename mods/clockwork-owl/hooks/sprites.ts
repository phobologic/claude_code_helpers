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

/**
 * Tilted on his side (crown to the left), the sprite's directions turn with
 * him: an on-screen look becomes the one that points that way once rotated.
 * The pupil drawn for 'center' ends up on the eye's left side, so 'left' and
 * 'center' both look in toward the screen; 'right' looks at the wall.
 */
const TILTED_LOOK: Record<Look, Look> = { center: 'center', left: 'center', down: 'left', right: 'down' }

function eyeFor(mood: Mood, look: Look, isBlinking: boolean, isTilted: boolean): Eye {
  if (isBlinking) return ['LLL', 'DDD']
  const turn = (l: Look) => (isTilted ? TILTED_LOOK[l] : l)
  switch (mood) {
    case 'waiting':
      // Waiting, he looks down at the prompt, unless the mouse has his attention.
      return openEye('W', turn(look === 'center' ? 'down' : look))
    case 'failed':
      return ['DDD', 'RPR']
    case 'happy':
      return ['LDL', 'DLD']
    case 'sleepy':
      return ['DDD', 'EPE']
    default:
      return openEye('E', turn(look))
  }
}

/**
 * The pixel grid for a mood, as 12 strings of palette letters and dots, with
 * `look` an on-screen direction. `isTilted` turns the eyes for `tilt`.
 */
export function pixels(mood: Mood, look: Look, isBlinking: boolean, isTilted = false): string[] {
  const [top, bottom] = eyeFor(mood, look, isBlinking, isTilted)
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

/** The grid turned a quarter counter-clockwise: crown to the left, eyes stacked. */
export function tilt(grid: string[]): string[] {
  return Array.from({ length: WIDTH }, (_, r) =>
    Array.from({ length: WIDTH }, (_, c) => grid[c]?.[WIDTH - 1 - r] ?? '.').join(''),
  )
}

// Folding is a slide in two legs, one frame each step: upright, he slides off
// the right edge; then, tipped on his side, his head slides back in from it
// until tufts, both eyes and the beak tip show, as if peeking round a corner.
const SLIDE_OUT = [0, 3, 6, 9, 12] // columns shifted right, upright
const PEEK_IN = [2, 4, 6, 7] // columns of the tilted head showing

/** Frames from upright (0) to peeking (PEEK_FRAME). */
export const PEEK_FRAME = SLIDE_OUT.length + PEEK_IN.length - 1

/** Columns of the tilted head showing once folded. */
export const PEEK_COLUMNS = PEEK_IN[PEEK_IN.length - 1] as number

/** The grid for one frame of the fold, always 12x12 with the owl against the right edge. */
export function frameGrid(mood: Mood, look: Look, isBlinking: boolean, frame: number): string[] {
  const f = Math.max(0, Math.min(PEEK_FRAME, Math.round(frame)))
  const blank = (n: number) => '.'.repeat(n)
  if (f < SLIDE_OUT.length) {
    const shift = SLIDE_OUT[f] as number
    return pixels(mood, look, isBlinking).map(row => blank(shift) + row.slice(0, WIDTH - shift))
  }
  const showing = PEEK_IN[f - SLIDE_OUT.length] as number
  return tilt(pixels(mood, look, isBlinking, true)).map(row => blank(WIDTH - showing) + row.slice(0, showing))
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

/**
 * The same while he peeks in from the right edge (the head in the last
 * PEEK_COLUMNS columns, eyes stacked on rows 1-4): down at a pointer on his
 * lower rows, at the wall from the edge column, else in toward the screen.
 */
export function peekLookAt(x: number, y: number): Look {
  if (y >= 5) return 'down'
  if (x >= WIDTH - 1) return 'right'
  return 'left'
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
