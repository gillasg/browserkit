## Sessions and files

`--session <name>` keeps variables, tabs and files together; the default is `cli` (and `mcp` for
the MCP server). Files (`page.saveMedia`, `page.network.save`, artifacts, crawls) land in the
session's workspace under browserkit's data folder ({{workspace}}). `browserkit journal <session>`
shows what a session ran. `artifact(name, data)` writes a file; `checkpoint(name, value)` and
`loadCheckpoint` persist JSON across resets.

### Two sessions at once

Sessions are isolated on purpose: a tab belongs to the session that opened it, so two sessions
never drive the same tab. `browser.tabs({mine:true})` lists only this session's tabs. Steps for one
tab run in order (a per-tab queue); reads on different tabs run in parallel, which is what
`Promise.all` over pages is for. A write (`page.batch`, a checkout) is serialized browser-wide, so
two sessions cannot interleave two writes on the same site. Opening a URL this session already has
a tab for reuses that tab; another session gets its own. If a tab is already claimed by another
session, `browser.attachTab` opens a copy for this one rather than borrowing it.
