// The contract of the ticket-panes mod: the noun it adds to `$` for other plugins, and the
// values it keeps in `$.state`. `claude plugin validate` holds every `$.state` key the mod's
// modules name to this file.

// `$.ticketPanes`: another plugin calls it as `$.ticketPanes.open({ id })`. Each method takes one
// object argument; its body is the mod's hook on `ticketPanes.<method>`.
export type TicketPanes = {
  // Opens ticket `id`: a herdr side pane with a Claude agent for it, or the read-only ticket pane.
  open(arg: { id: string }): Promise<void>
  // Resolves true while the mod is loaded, so a caller can probe for it in a try/catch.
  available(arg: {}): Promise<true>
}

// What this session is (R4): a ticket's side session, or a main one; `herdrPaneId` is set
// only in herdr, as the session's own pane.
export type TicketPanesRole = {
  kind: 'main' | 'side'
  sideTicket?: string
  herdrPaneId?: string
}

// How the side session's band shows its ticket.
export type TicketPanesBandMode = 'compact' | 'expanded' | 'collapsed'

declare module 'claude-code' {
  interface EngineInterface {
    ticketPanes: TicketPanes
  }

  interface PluginState {
    'ticket-panes': {
      // The resolved role, kept so it survives a reload of the mod.
      role: TicketPanesRole | null
      // The ticket the read-only pane shows, or null while it is closed.
      paneTicket: string | null
      bandMode: TicketPanesBandMode
      // Goes up when the side ticket's file changes, so what draws from it draws again.
      ticketVersion: number
    }
  }
}
