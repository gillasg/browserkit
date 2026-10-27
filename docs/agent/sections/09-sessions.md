## Sessions, spaces and bulk work

`--session <name>` keeps variables, tabs and files together (default `cli`, and `mcp` for the MCP
server). Files land in the session's workspace ({{workspace}}); `browserkit journal <session>`
shows what it ran. A tab belongs to the session that opened it, so two sessions never drive the
same tab; reads on different tabs run in parallel, writes are serialized browser-wide.

- **Spaces:** `browser.openTab(url, {space: "window"})` keeps a session's tabs in one background
  window; `browser.session.finish({keep: ["p2"]})` hands the kept tabs to the user. Tabs carry
  stable labels (`p1`, `p2…`). `help('spaces')`.
- **The user takes over:** clicking or typing in an agent's tab stops it with
  `USER_TOOK_CONTROL`; `page.waitForControl()` waits until it is given back. Never retry around it.
- **Many sites:** `browser.sweep(urls, {gate: true, pilot: 5})` returns one outcome per URL (`ok`,
  `gated`, `dead`…) as a durable job; start with a pilot. `help('sweep')`, `help('jobs')`.
- **Network:** `page.network.list()` works without `start()`, `page.network.body(id)` reads what a
  call returned, `page.media()` parses video manifests. `help('network')`.
- **Clearing state:** cookies, storage, service workers, permissions. `help('state')`.
- **Other tools:** `browserkit cdp` starts a local DevTools endpoint for Playwright or Puppeteer
  (`connectOverCDP(url)`); its tabs close when the client disconnects.
