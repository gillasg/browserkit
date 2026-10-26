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
session, `browser.attachTab` opens a copy for this one rather than borrowing it (a listed tab from
another session is `TAB_OWNED_ELSEWHERE`; `browser.tabs({all:true})` shows them).

## Spaces, labels and taking a tab back

A session can keep its tabs in one window of its own (`browser.openTab(url, {space: "window"})`,
which jobs, sweeps and outside sessions use) or in the user's window (`{space: "tabs"}`, the
default for an interactive chat). The window is normal (never minimized, so Chrome keeps painting
it), created behind the user's window, and reused for that session's tabs. `browser.session.finish({keep:
["p2"]})` moves the named tabs to the user's window, closes the rest and ends the session;
`browser.session.claim()` hands every tab and the window to the user; `browser.session.spaces()`
lists sessions with `running`, `waiting`, `user` or `idle`.

Tabs also get stable labels (`p1`, `p2…`): `browser.tabs()` shows each tab's `label`, and
`bu.use("p2")` works wherever a tab id does. The label is re-bound by URL if Chrome restarts and
ids change. If the user clicks or types in a tab the agent is driving, the agent pauses with
`USER_TOOK_CONTROL`; `browser.tabs()` marks `control: "user"` and `page.waitForControl()` waits
until the banner's button or `page.giveBack()` restores the agent.

## A local DevTools endpoint

`browserkit cdp` starts a 127.0.0.1-only DevTools endpoint over agent tabs and prints a tokenised
URL. Playwright: `chromium.connectOverCDP(url)`; Puppeteer: `connect({browserURL: url})`.
`browserkit cdp --status` reports it, `--stop` ends it. Tabs opened through the endpoint belong to
that client and close when it disconnects; browser contexts, cookie/storage clearing and
`Browser.close` are refused. The endpoint is off until started.

## Bulk work: sweeps, outcomes and evidence

For "is this list of sites alive / does it have X", do not write the open-wait-capture-close loop:
`browser.sweep(urls, {gate: true, capture: "media", play: true})` is that loop as one durable job
(it survives a bridge restart). Each URL gets one record with `outcome`, `reason`, `gate`,
`captured`, `media`, `evidence` and `ms`. Outcomes are `ok`, `gated`, `shell`, `dead`, `parked`,
`redirected`, `blocked` and `error`; a run with no `ok` items returns a `warning` that the method
is probably incomplete, so read it before believing the result.

- `pilot: 5` runs five, returns their evidence and stops: look before committing to hundreds.
- `checkpoint: "name"` resumes that sweep, re-running only ambiguous items (`retry: ["gated"]`
  adds outcomes). `concurrency` defaults to 4.
- `evidence: true` keeps a screenshot, DOM text and network summary per item in the workspace.
- Tabs the site opens are reaped; the sweep is `browser.job` underneath, so `browser.job.status`,
  `.cancel`, `.resume` and `browserkit sweep` / `browserkit job` all work on it.

A single site: `await page.enterSite()`, then `page.network.list({since})` and `page.media()`.
`check` (CLI) is liveness + verdicts; `check --media` adds the same capture for alive sites.

## Network and media

`page.network.list()` records top-frame, iframe, worker and service-worker traffic; each entry has
`state` (`pending`/`done`/`failed`), `source` (`worker`/`service-worker`) and `frameUrl` when it is
not the top frame. `list({frames: "top"})` narrows to the top frame, and `list({since: cursor})`
returns `{entries, cursor}` so polling a long flow is incremental. `page.network.body(id)` is the
cheapest way to read what a call returned: reach for it before re-fetching. `page.media()` fetches
and parses the manifests the tab requested: `{masters: [{url, variants: [{width, height,
bandwidth, codecs, url}]}], playlists: [{url, duration, segments}], headers}`. A site that gates on
`Referer` works with `page.goto(url, {referer})` or `browser.openTab(url, {referer})`.
`browser.fetch` returns status, headers and a capped body even on 401/403, plus a hint when no
referer/origin was sent.

## Clearing state

| State                        | How to clear                                                                                                                  |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Cookies                      | `browser.cookies.clear({url})` or `{domain}`                                                                                  |
| Web storage                  | `page.cdp('Storage.clearDataForOrigin', {origin, storageTypes: 'local_storage,session_storage,indexeddb'})` (origin required) |
| Everything the origin stores | `page.cdp('Storage.clearDataForOrigin', {origin, storageTypes: 'all'})` (cookies excluded)                                    |
| Service workers              | `page.cdp('ServiceWorker.stopAllWorkers')` or `page.cdp('ServiceWorker.stopWorker', {versionId})`                             |
| Permissions                  | `page.permissions.allow(type)` / `block(type)` / `reset(type)`                                                                |
| HTTP cache                   | Not offered: `Network.clearBrowserCache` is refused browser-wide                                                              |

Also refused: `Network.clearBrowserCookies` and `Storage.clearCookies` (use `browser.cookies`), and `Storage.clearDataForOrigin` without an explicit origin. `help('state')` carries the same table.
