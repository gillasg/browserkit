## Browser code in one minute

`browserkit repl "<code>"` (or `browser_code`) runs JavaScript in a persistent REPL inside Chrome.
Globals: `browser`, `page`, `bu`, `siteMapper`, `google`, `skills`, `artifact`, `checkpoint`,
`help`. Variables, tabs and files persist per `--session`.

```js
const page = await browser.openTab("https://shop.example");
await bu.state(); // [id] role "name" = value, plus visible text
await bu.click(12); // act by bu id, role or visible text
await page.locator("input[name=q]").fill("lamp");
await page.getByRole("button", { name: "Search" }).click();
const rows = await page.list("tr"); // every row, scrolling lists that draw lazily
```

- One `page` per site: `browser.openTab` on a site you already have a tab for navigates it
  (`{newTab: true}` for another tab). `browser.activeTab()` is the tab the user is on;
  `browser.tabs(query?)` lists tabs (`mine:true` only for tabs this chat or session opened),
  `browser.attachTab(tabId)` takes over one, `bu.use(tabId)` switches. Work through the user's tabs
  in place, all at once with `Promise.all`.
- `bu.state()` prints `[id] role "name" = value` and visible text (`*` marks changes; scope with
  `{selector}` or `{query}`). Act on apps that redraw themselves by visible text, role or bu id,
  never `document.querySelector`. Controls inside a cross-origin iframe appear under their iframe
  with a frame prefix (`f2:e14`); acting on one goes through that frame, and
  `bu.state({root: "f2:e14"})` / `page.snapshot({root})` scopes to that subtree (an iframe ref
  means its whole document).
- Console and page errors are captured only when asked for: `page.console()` reads and turns
  capture on for this tab, `page.console.start()` / `.stop()` / `.state()` control it. The Runtime
  domain it needs is detectable, so it stays off by default. `page.stealthCheck()` reports what a
  page can see (Runtime on, injected globals or overlays, wrapped functions, `navigator.webdriver`).
- `page` is Playwright-style: `page.goto(url)`, `page.title()`, `page.url()`, `page.locator(css)`,
  `getByRole(role, {name})`, `getByText`, `getByLabel` with `.click()`, `.fill(v)`, `.innerText()`,
  `.count()`, `.all()`, `.nth(i)`, `page.$$eval`, `page.keyboard.press("Enter")`,
  `page.waitForSelector(css)`. There is no `page.playwright`, and `page.$` is not a promise chain.
- After a cell with actions the new page state prints automatically; never add blind sleeps. A cell
  returns its last expression: end with one object holding what you found, and print only what you
  will use. Close tabs you are done with (`await page.close()`, or `browser.closeTab(id)`; both
  refuse the user's tabs and unsplit first); `page.keep()` hands one to the user when they need it
  (a result, cart or form). For more than a few pages or sites use
  `browser.job(items, async (page, item) => …)`, which returns a job id and keeps running after
  the cell; check `browser.job.status(id)` or `browser.job.result(id)` later. `browser.reset()`
  closes every tab the chat opened except kept ones.
- If you click or type in a tab an agent is driving, it stops at its next step with
  `USER_TOOK_CONTROL` (later steps say `USER_HAS_CONTROL`). `browser.tabs()` marks that tab
  `control: "user"`. Wait with `page.waitForControl()` (or `{timeoutMs}`) until the user presses
  the banner's button or calls `page.giveBack()`; there is no retry around it.
- A session's tabs can be one space: `browser.openTab(url, {space: "window"})` puts its tabs in one
  background window of its own, while `{space: "tabs"}` keeps them in the user's window.
  `browser.session.finish({keep: ["p2"]})` moves the kept tabs to the user and closes the rest;
  `.claim()` leaves the whole space to the user; `.spaces()` lists sessions and their status. Tabs
  carry stable labels (`p1`, `p2…`) in `browser.tabs()` and `bu.use("p2")`, re-bound by URL after
  a browser restart.
- `page.flight.save()` writes the last two minutes of the tab as WebM under `BROWSERKIT_HOME/flight`
  (or `--out`), returning its path, frame count and duration. A failed cell saves one automatically
  and names the files in its result; `browserkit repl --no-flight` turns recording off for a run.
  `page.flight.status()` says what is buffered; `clear()` drops it.
