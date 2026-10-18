// The ticket-panes mod's noun, as that mod's contract declares it, for the calls this
// module makes. workflow-monitor lists no `dependencies` in its plugin.json, since a
// declared one would stop it loading without ticket-panes, so the engine lays no copy of
// that contract here. At run time `$.ticketPanes` exists only while ticket-panes is
// loaded; without it a call throws, so every call is made in a try/catch.
declare module 'claude-code' {
  interface EngineInterface {
    ticketPanes: {
      // Opens the ticket: a side pane with an agent on it, or a read-only pane.
      open(arg: { id: string }): Promise<void>
      // Answers true while ticket-panes is loaded.
      available(arg: {}): Promise<true>
    }
  }
}
