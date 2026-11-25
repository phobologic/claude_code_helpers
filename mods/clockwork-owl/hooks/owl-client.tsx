import type { ClientSurface, RenderElement } from 'claude-code'

import type { Look, Mood } from '../types'
import { foldedPixels, lookAt, pixels, rows } from './sprites'

// The owl's surface module: it draws the sprite inside a Client, so it hears
// the pointer. A left click posts { type: 'toggle' } to the hooks module, which
// folds or unfolds him; while the pointer is over him his pupils follow it.

export type OwlClientProps = {
  mood: Mood
  look: Look
  isBlinking: boolean
  isFolded: boolean
}

/** Where the pointer has his eyes, or null when it is elsewhere. */
type State = { hover: Look | null }

export default function OwlClient(props: OwlClientProps, surface: ClientSurface<State>): RenderElement {
  const { Box, Text } = surface.elements

  if (surface.state === undefined) {
    surface.onPointer(ev => {
      if (ev.type === 'down' && ev.button === 'left') {
        surface.post({ type: 'toggle' })
        return
      }
      const hover = ev.type === 'leave' ? null : lookAt(ev.x, ev.y)
      if (hover !== (surface.state?.hover ?? null)) surface.setState({ hover })
    })
    surface.setState({ hover: null })
  }

  const look = surface.state?.hover ?? props.look
  const grid = props.isFolded
    ? foldedPixels(props.mood, look, props.isBlinking)
    : pixels(props.mood, look, props.isBlinking)

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
