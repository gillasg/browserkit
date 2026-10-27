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
- `page.console()` reads console messages and errors (capture is off until asked for).
- `page` is Playwright-style (`goto`, `locator`, `getByRole`, `getByText`, `getByLabel`, `$$eval`,
  `keyboard.press`, `waitForSelector`). There is no `page.playwright`. `help('playwright')`.
- After a cell with actions the new page state prints automatically; never add blind sleeps. A cell
  returns its last expression: end with one object holding what you found, and print only what you
  will use. Close tabs you are done with (`await page.close()`, or `browser.closeTab(id)`; both
  refuse the user's tabs and unsplit first); `page.keep()` hands one to the user when they need it
  (a result, cart or form). For more than a few pages or sites use
  `browser.job(items, async (page, item) => …)`, which returns a job id and keeps running after
  the cell; check `browser.job.status(id)` or `browser.job.result(id)` later. `browser.reset()`
  closes every tab the chat opened except kept ones.
