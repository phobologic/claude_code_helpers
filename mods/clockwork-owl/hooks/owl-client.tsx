import type { ClientSurface, RenderElement } from 'claude-code'

import type { Look, Mood } from '../types'
import { frameGrid, lookAt, PEEK_FRAME, peekLookAt, rows } from './sprites'

// The owl's surface module: it draws the sprite inside a Client, so it hears
// the pointer. A left click posts { type: 'toggle' } to the hooks module, which
// folds or unfolds him; while the pointer is over him his pupils follow it.
// Folding plays as a slide on the Client's own frame clock: off the right edge
// upright, then back in tipped on his side, peeking (see `frameGrid`).

export type OwlClientProps = {
  mood: Mood
  look: Look
  isBlinking: boolean
  isFolded: boolean
}

/** Where the pointer has his eyes (null when it is elsewhere), and the fold's frame. */
type State = { hover: Look | null; frame: number }

const STEP_MS = 45

// The newest props per instance, for the timer, which outlives the call that started it.
const latest = new WeakMap<object, OwlClientProps>()

export default function OwlClient(props: OwlClientProps, surface: ClientSurface<State>): RenderElement {
  const { Box, Text } = surface.elements
  latest.set(surface, props)
  const targetOf = (p: OwlClientProps) => (p.isFolded ? PEEK_FRAME : 0)

  if (surface.state === undefined) {
    surface.onPointer(ev => {
      if (ev.type === 'down' && ev.button === 'left') {
        surface.post({ type: 'toggle' })
        return
      }
      const s = surface.state ?? { hover: null, frame: 0 }
      let hover: Look | null = null
      if (ev.type !== 'leave') {
        if (s.frame === 0) hover = lookAt(ev.x, ev.y)
        else if (s.frame === PEEK_FRAME) hover = peekLookAt(ev.x, ev.y)
      }
      if (hover !== s.hover) surface.setState({ ...s, hover })
    })
    surface.every(STEP_MS, () => {
      const s = surface.state
      const p = latest.get(surface)
      if (!s || !p) return
      const target = targetOf(p)
      if (s.frame === target) return
      const frame = surface.isMotionReduced ? target : s.frame + Math.sign(target - s.frame)
      surface.setState({ hover: null, frame })
    })
    surface.setState({ hover: null, frame: targetOf(props) })
  }

  const frame = surface.isMotionReduced ? targetOf(props) : (surface.state?.frame ?? targetOf(props))
  const look = surface.state?.hover ?? props.look
  const grid = frameGrid(props.mood, look, props.isBlinking, frame)

  return (
    <Box flexDirection="column">
      {rows(grid).map(row => (
        <Text>
          {row.map(run => (
            <Text color={run.color} backgroundColor={run.backgroundColor}>
              {run.text}
            </Text>
          ))}
        </Text>
      ))}
    </Box>
  )
}
