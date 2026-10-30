## Which way to do it

- **Act on a page** (click, fill, submit, read what is on screen): browser control. `browserkit repl`
  or the `browser_code` MCP tool.
- **Read a lot of pages** (a page, a section, a whole site, a sitemap, search results): `crawl`,
  `scrape`, `map-urls`, `search`. Plain HTTP first, the browser only when a page needs it. Much
  cheaper than driving each page.
- **Which of many sites load** (dead links, parked domains, which answer an API path): `browserkit
check <urls|--file f>`, with evidence per site. Far cheaper than opening each one.
- **Call a site's API**: only if the site is mapped (`browserkit sites`). One call replaces many
  page actions and returns JSON with the user's session. If it is not mapped, map it (`map`,
  `describe`, `learn`) or just use the page. `map <url> --until-idle` (or `--for 60`) records
  without waiting for Enter, for scripts and agents.
- **A site used repeatedly**, where the answer must keep coming: map it, then `call`, `watch`,
  `federate` (several sites at once, with provenance).
- **What the user visited, saved or has open**: their history, bookmarks and open tabs, not a
  search engine. A site, page or thing they name without a link: `browser_context` (or
  `browser.context(request)`) looks in all three at once before guessing from memory.
  "My most visited …": `browser.history.top({by, match, days})`.
- **Anything live or on a specific site** (prices, stock, listings, showtimes, reviews): open that
  site in the browser. Web search only finds which page to open (`search` uses keyless
  providers, and Google in the user's browser for local, live and personal queries).
- **A lasting tool for one task on a site** ("make me something that checks X"): build an ability
  (`browserkit actions build <site> "<task>"`); it is tested before it is saved, or says why the
  site cannot do it.
- **What a page sends** (the API behind it, a download link, a stream): network capture,
  `help('network')`; live WebSockets and event streams, `help('live')`.
- **Files and media**: save images, videos and files, or upload into a page, `help('media')`;
  record a tab as a video with its sound, nothing of ours in it, `help('recording')`.
- **How agents look and run here**, when the user asks (views, cursor, tab groups, idle tabs):
  `browser.settings()` lists them; `browser.settings({name: value})` changes them.
- **Change a site on every visit** (hide parts, restyle, auto-click a banner): a boost,
  `help('boosts')`.
- **Long or wide work**: many pages, `browser.job` (`help('jobs')`); hundreds of sites, a sweep
  (`help('sweep')`); a background window that never takes over the screen, `help('spaces')`.
- **An AI the user already pays for** (ChatGPT, Gemini, Grok, Perplexity, Kimi): `browserkit ask`.
