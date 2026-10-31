// help(topic) in browser code: the reference for everything used now and then, so the always-on
// tool guidance stays short. __hint(message) turns a failed cell's error into a "did you mean"
// from the real API surface, plus fixes for the Playwright habits that do not apply here.

const TOPICS: Record<string, string> = {
  signin:
    "await bu.signIn({account?}) signs in to the current page with a login from the user's password manager (Bitwarden or Proton Pass): it fills the username, password and the one-time code (the saved authenticator code, else one the site just sent to the user's Gmail or, when Google Messages for web is paired, their phone), across multi-step forms, and returns {signedIn, site, provider, account, reason?, accounts?}. You never see the password and there is no approval step: calling it is the instruction. reason CHOOSE_ACCOUNT lists accounts: call again with {account}. A code field on any other form (a sign-up or email check): await bu.fillCode({waitMs}) waits for the code in Gmail or Google Messages, types and submits it, and returns {filled, from: 'gmail'|'messages', reason: 'NO_CODE_FIELD'|'NO_CODE'}; you never see the code, and payment or transfer approvals are never used. NO_PASSWORD_MANAGER, NO_SAVED_LOGIN, NEEDS_CODE (no code arrived) or CAPTCHA: bu.handoff('Please sign in'). REJECTED: the site refused the login; tell the user, do not retry. FOREIGN_FORM: the form sends the login to another site (detail names it); nothing was typed; tell the user, never retry or type it by hand. APPROVE_ON_DEVICE: the site waited a minute for approval on the user's phone or app; ask the user to approve, then call bu.signIn() again. Cookie banners over the form are cleared (reject first), and codes split across one-digit boxes are typed box by box. Open the site's sign-in page first. bu.handoff(message, {selector?, start?}) asks the user to do a step in the tab: the cursor turns amber and points at selector, a card carries Done and Cancel (a notification instead while the tab records). {start: true} returns {wait, cancel} at once: start it before the click that opens a passkey, WebAuthn, 2FA or payment prompt the page blocks on, then await wait(). PROTECTED_UI on any step: a password manager's menu (another extension's frame) keeps blocking the tab after it was removed twice; ask the user to close it, then continue.",
  gated:
    "Sites behind a sign-in or a bot wall. Opening or navigating to a page with a Cloudflare, DataDome, PerimeterX or Akamai check logs a '[warn] challenge:' line. Signed out: await bu.signIn(), see help('signin'). A check the page shows to people: await bu.handoff('Please finish the check', {wait: true}) asks the user and returns once it is gone (it watches the page as well as the Done button): {solved, by: 'cleared'|'done'|'cancelled'|'timeout', waitedMs}; {timeoutMs} up to 30 minutes, 10 by default. Never solve or click through a check yourself. Once through, page.session() returns the cookies (HttpOnly too) and storage, and the command line's session export <site> or cookies export <site> saves them for scripts, mapped or not.",
  errors:
    "Error codes and what to do. TARGET_LOST: the tab closed or navigated away; open it again. STALE_REF: the page changed under a bu id; call bu.state() for fresh ids. TARGET_BLOCKED: the element is covered (overlay, banner, dialog); close it or scroll, then retry. SITE_BLOCKED: the user blocked this site for agents; stop and tell them. EXTENSION_BLOCKED: another extension (a content blocker) replaced the page; ask the user to allow the site there, then retry once. PROTECTED_UI: a password manager's menu covers the page; ask the user to close it. NAVIGATION_FAILED: the address did not load; check it, then try the site's home page. A '[warn] challenge:' line is a bot wall, see help('gated'). Timeouts: split the work into smaller cells or use browser.job for many pages.",
  screenshot:
    "page.screenshot({path?, fullPage?, annotate?, labels?, format?, inline?, save?}) saves the image in the workspace and returns {saved: absolute path, mimeType}. path names the file (inside the workspace; a path outside it keeps only its file name). The image data stays off the printed result; result.dataBase64 still has it for code, and {inline: true} prints it. {save: false} saves nothing. {labels: true} draws bu ids for help('visual').",
  tabs: "browser.openTab(url, {newTab?, quiet?, window?: {width, height}}) opens a background tab (one per site: openTab on a site you have a tab for navigates it; if the user closed it, pass {newTab:true}). browser.tabs(query?) lists {id, title, url, active, mine}: mine:true only for tabs this chat or session opened, so filter on mine, never on an id range; tab.tabId, tab.windowId and tab.target work too. browser.activeTab() is the active tab of the window the user last focused; bu.use(tabId) switches; browser.attachTab(target) uses a tab you did not open. browser.closeTab(id) closes one this chat opened (unsplitting first; a user tab, another session's tab or a hand-off tab throws clearly); page.close() does the same for page. At the end of a run the agent's tabs close except the last one used and tabs the user switched to; page.keep() hands a tab to the user. browser.reset() closes every tab this chat opened (kept ones stay). browser.moveTab(...) reorders tabs. browser.pool(urls, async (tab, url) => ..., {concurrency}) works through pages in parallel tabs. browser.fetch(url) fetches with the user's cookies and no tab.",
  reading:
    "page.read({max}) reads the page in one call: embedded data, the main repeated list and Markdown, merged with partial flags; it expands Show more/Show replies/Read more inside the main content (expand: false turns that off) waits up to 5s for the content to settle, and scrolls every panel that scrolls on its own (transcripts, chat logs, comment drawers), returning the ones that draw text only on scroll as scrollers: [{label, selector, text, complete}]. It fits a 30s budget (timeMs). Kept under max (40k characters by default, up to 200k); the rest is saved with artifact() and its absolute path is in artifact. page.scrollers({max, timeMs}) reads every inner scrolling panel whole, e.g. after opening a transcript. bu.state({selector, query, max}) scopes the observation. page.data() returns embedded JSON (JSON-LD, __NEXT_DATA__, app state) and metadata, with the largest arrays of objects it holds; page.data({summary: true}) lists its sources; page.data({find: ['title', 'id']}) returns the arrays of objects that have those keys, each with its path and count. page.table(css) returns rows keyed by header; page.list(rowCss?, {max}) returns every row of a list as {count, complete, partial, items: [{key, text, href}]}, scrolling lists that only draw the rows on screen or load more on scroll (rows are guessed when no selector is given); page.links(css) {text, href}; page.markdown() clean main content, including repeated article/feed items, with a PARTIAL note when it saw less than the page holds; page.textContent(css); page.pdfText() for PDFs; await page.frames() for iframes. Locators: page.locator(css) / getByRole(role, {name}) / getByText / getByLabel / getByPlaceholder with .click() .fill(v) .innerText() .textContent() .inputValue() .getAttribute(n) .count() .all() .nth(i) .first() .allInnerTexts() .evaluate(fn) .boundingBox(); page.$eval / page.$$eval(css, fn).",
  forms:
    "page.controls.inspect({query?, hidden?}) lists every form field with its state: label, value, options (* = selected), checked, min/max/step, required, disabled, invalid, group, frame. page.controls.directory({query}) adds buttons, links, tabs and menu items. page.batch(steps, {observe?, pace?}) runs steps in one call: {action: 'fill'|'select'|'check'|'uncheck'|'click'|'press'|'wait'|'read'|'readUrl', target: {label} | {role, name} | {text} | {placeholder} | {css} (+ {exact}, {nth}, {frame: urlPart}), value, expect}. Each target must match exactly one element (it waits for it to appear); it stops at the first failure and says which steps ran. A batch that changes the page ends with {action: 'read', target, expect: 'text'} or {action: 'readUrl', expect: '/done'}, or passes {observe: true}. Example: await page.batch([{action: 'fill', target: {label: 'Email'}, value: 'a@b.c'}, {action: 'select', target: {label: 'Country'}, value: 'India'}, {action: 'check', target: {label: 'I agree'}}, {action: 'click', target: {role: 'button', name: 'Continue'}}, {action: 'read', target: {role: 'heading'}, expect: 'Thank you'}]).",
  overlays:
    "page.overlays.dismiss() closes cookie notices (rejecting when it can) and promotions or newsletter pop-ups covering the page, and returns what it clicked; {accept: true} accepts cookies when that is the only way through. Dialogs that are neither are left alone. page.challenges() names a bot check, captcha, block, rate limit or sign-in wall on the page, with what to do (bu.state() also notes them).",
  tables:
    "tables keep rows with columns described in plain words, on this machine, shared by every chat, routine and watcher. const t = await tables.open('founders', {columns: {name: 'founder name', company: 'company', funding: 'latest round and amount', replied: 'replied to my DM?'}, key: 'name'}); await t.add([{name, company}]) (a row with the same key is updated); await t.fill('funding', async (row) => { …read a page or call a site API… return value }, {concurrency: 4, all?, where?}) fills empty cells (all: every row) and returns {filled, changed: [{key, columns}], failed}; t.rows({where, limit, offset}); t.update(key, values); t.remove(keys); t.export('file.csv') writes a CSV to the workspace. tables.list(), tables.drop(name). A column that should stay current is a watcher: a routine whose check runs t.fill(column, fn, {all: true}) and returns the changed rows (or false).",
  identity:
    "browser.identity.accounts() returns {chromeProfile: {email}, google: [{email, authuser}]}: the Google accounts signed in on the web (those with Gmail); open one with its authuser index (mail.google.com/mail/u/1, ?authuser=1). bu.signIn({account}) picks a login on other sites. browser.proxy.set('socks5://host:1080', {sites: ['example.com']}) sends those sites (all sites without sites) through a proxy in this Chrome profile until browser.proxy.clear(); browser.proxy.get() says what is set. Chrome routes proxies per site, not per tab, and proxies that need a password are not supported.",
  snipe:
    "browser.snipe({at, url?, prepare?, fire, done?, retryMs = 500, windowMs = 120000, reloadEach?, syncClock?, wait?}) acts at an exact moment: a drop, a ticket or booking release, a slot opening. It runs as a job: it opens url, reloads a minute ahead, runs prepare(page) (fill the form, pick the seat), waits to the millisecond, then calls fire(page, attempt) and retries every retryMs until done(page, result) is true or windowMs passes. Returns {jobId}; browser.job.result(jobId) gives {ok, attempts, firedAt, lateMs, result}. syncClock: true sets the clock from the site's Date header. It starts at most 55 minutes ahead: for later, create a routine with schedule {kind: 'once', atUtc: a few minutes before} whose instruction calls browser.snipe. prepare, fire and done run in the job's own realm: pass everything they need inside them, not through outer variables.",
  profile:
    "The user's form profile (name, email, phone, address, company, links and anything they chose to keep) fills forms without you seeing the values. await bu.fillProfile({fields?}) matches the page's fields by autocomplete hint and label and fills them: {filled: [{label, field}], missing: [{label, field}], other: [labels]}. missing are fields the form wants that the profile lacks: ask the user, type their answer, then ask whether to keep it in their profile and on yes call bu.profile.save({field: value}). await bu.profile.fields() lists saved field names; bu.profile.remove(name). Logins, card and bank numbers and government IDs are refused: those belong to the password manager.",
  history:
    "browser.context(request?) answers in one call what the user has open and where they go: {activeTab, openTabs, recentSites (last 2 days), topSites (most visited, 90 days), matches: {history, bookmarks} for the request's words}. browser.history.search(text, {days, max, before}) returns visited pages {url, title, lastVisit, visits}, newest first (days default 30, max up to 5000); page further back with {before: last.lastVisit}. browser.history.top({by: 'site'|'path', match, days, depth, max, sort: 'visits'|'recent'}) scans all of the window (default 90 days) and ranks sites, or site sections with by 'path' (depth 2: reddit.com/r/rust), by visits: {scanned, groups: [{key, visits, pages, lastVisit, top: {url, title}}]}. Use it for 'my most visited / which subreddits / what do I use for X' instead of many searches; visits are Chrome's all-time counts per page. browser.bookmarks.search(text) / tree() / children(id) / create({title, url, parentId}) / update(id, {title, url}) / move(id, {parentId, index}) / remove(id). browser.downloads.list(text?) returns recent downloads with filename and state.",
  api: "siteMapper.code(url, {grep}) reads a site's HTML, JS chunks, route manifests, source maps, robots and sitemap before guessing URLs; it returns routes, files, source-map sources and matches. siteMapper.sites() and siteMapper.operations(site) list what sites learned. siteMapper.call(site, operation, params) reads; siteMapper.watch(site, operation, params, {key}) returns only items new or changed since the last watch (also in routine checks). Writes: do one in the page; once the output says it was learned and proven, siteMapper.write(site, operation, params) repeats it and siteMapper.batch(site, operation, items, {perSecond, verify, label}) runs it over many items (paced, checks the first with verify(result, item), stops at the first error; continue what is left in the page, which repairs the operation). Paying, ordering, sending, posting, deleting and account changes stay in the page. site.run(name, inputs, {via}) runs a saved ability (API, steps, script or page); siteMapper.undo(site, operation, params) reverses a proven write whose opposite was learned; siteMapper.channel(site, id, {send, seconds}) listens on a live channel. site.capabilities() lists the site's abilities, operations and notes; site.<name>(inputs) is the same as site.run(name, inputs).",
  sites:
    "Mapped sites: site.capabilities() returns {abilities, operations, notes, webmcp} for the current site. Run one with site.run(name, inputs, {via}) or site.<name>(inputs); abilities carry their API call/chain, replay steps, page code or node code. siteMapper.sites(), siteMapper.operations(site), siteMapper.call(site, operation, params) remain for raw mapped operations. Site notes load by themselves with the site.",
  readonly:
    "A session claimed with readOnly:true only records the intent for you; nothing refuses a write. Be careful with consequential actions, but the engine will not stop you.",
  state:
    "Clearing browser state: cookies -> browser.cookies.clear({url} or {domain}); web storage (localStorage, sessionStorage, IndexedDB) -> page.cdp('Storage.clearDataForOrigin', {origin, storageTypes: 'local_storage,session_storage,indexeddb'}) with an explicit origin; service workers -> page.cdp('ServiceWorker.stopAllWorkers') or page.cdp('ServiceWorker.stopWorker', {versionId}); permissions -> page.permissions.allow(type), block(type) or reset(type); everything the origin stores (cookies excluded) -> page.cdp('Storage.clearDataForOrigin', {origin, storageTypes: 'all'}). The HTTP cache is not offered: Network.clearBrowserCache is refused browser-wide. Also refused: Network.clearBrowserCookies and Storage.clearCookies (use browser.cookies), and Storage.clearDataForOrigin without an origin.",
  network:
    "Every tab you open or navigate is recorded from its first request, so page.network.list('/api' | {match, method}) works without start(); an empty list says why. page.network.waitFor({match: '/api/x' or /regex/, method?, status?, timeoutMs}) resolves with the first matching request that finishes ({url, status, headers, body}) and names the pattern when it times out: use it after a click or navigation instead of a sleep. For a full capture: page.network.start({types: 'all', dryRun?}) then do the flow; dryRun blocks requests that would change something (send, post, buy), answering {} so the page goes on. page.network.get(id) the full request and response, page.network.body(id) the parsed response, page.network.failures() groups failed requests with statuses, sizes, block headers and the last success, page.network.save(name) a HAR file. HAR headers, cookies, query strings, bodies and URLs are redacted by default; pass {raw: true} to page.network.har/save to keep real values. page.replay(id, {query, json, headers}) re-sends a recorded call from the page with its cookies, signatures and CSRF; page.request(url, {method, json, csrf: true}) makes a new one. browser.fetch(url, {headers: {referer, origin}, method, json}) calls an API with the user's cookies, no tab: referer and origin are set for that one request, for APIs that check where a call came from; a failure names its kind (dns, tls, refused, reset, timeout, cors, blocked-page) and host. page.session() returns cookies and storage.",
  abilities:
    "One named thing a site can do, read or write. site.capabilities() lists them with ways, inputs and stats; site.run(name, inputs, {via, key, limit, cursor}) or site.<name>(inputs) runs one; site.test(name) runs its stored cases; site.remove(name) moves one to the site's trash. Lists: {limit} returns {items, next_cursor, has_more}; pass next_cursor back as {cursor} (it survives rows added or removed between calls). Writes: pass {key}, one per intended change ('order-tea-2026-10-28'); the same key never applies twice within a day and returns the first answer. A failed write's error ends with {code, write_status (not_attempted, not_applied, may_have_applied), possible_commit, retry}: retry same_key repeat as is; fix_input change the input or sign in; new_key read the site back first and repeat with a new key only if the change is absent; never do not repeat. INPUT_NOT_APPLIED: the site ignored a filter, so the rows answer another question; say so instead of presenting them. Save when a task works or the same steps ran twice: saveAbility({name, kind, description, inputs, outputs, ways, tests, options}) for the current site (or {site}); inputs and outputs are JSON Schema; tests: [{inputs, expect}] with at least two different inputs for a read; options.checks: [{input, field, op: eq|lt|lte|gt|gte|contains}] so an ignored filter fails loudly; options.readBack: {ability, inputs, expect} so a write confirms itself. Ways run in order: {kind:'api', operation | operations:[{operation, params}], params, paging, commit}, {kind:'steps', steps}, {kind:'script', runtime:'page'|'node', code} (node: no cookies; browser.fetch answers like browser code's), {kind:'page', collect}; use '{{inputs.x}}' in params. Every declared input must be used (or its description says 'By design:'); a replacement that drops or retypes an input or drops an output field is refused: keep it, save a new name, or pass breaking:true. Chain a write after a read by naming its input like the read's output field. A site that cannot do what was asked: say so with a reason (site_lacks_capability, signed_out, bot_wall, needs_user) instead of saving something that half works. Site notes load by themselves.",
  progress:
    "Long work: bu.progress(done, total, label) updates the user in one cell. For a list of more than a few pages or sites use browser.job(items, async (page, item, index) => …, {concurrency, maxTabs, timeoutMs, quiet}) instead of a long cell: it returns {jobId} and keeps running past the deadline, each item in its own tab (closed afterwards unless kept), one failure isolated. browser.job.status(id) and browser.job.result(id) check it later; result saves the whole result as a workspace artifact. checkpoint(name, value) saves progress across resets; checkpoint(name, value, {partial: true}) keeps a partial answer under partial/ that a stopped or budget-limited run still delivers. finish_from_js({expression}) hands the value of expression to the user as the final answer and ends the run, so a large result never has to be retyped.",
  recording:
    "page.recordVideo({seconds?, name?, format: 'mp4'|'webm', audio?, cursor?}) records the tab as a video file in the workspace (MP4 where Chrome can, else WebM) with nothing of ours drawn on it: no glow, caption or hand-off card ({cursor: true} keeps the cursor for demos); without seconds it returns {stop(), cancel()} (cells end after ~50 s, so keep the handle and stop it in a later cell). Sound comes when Chrome lets the tab be captured (the user clicked the extension's toolbar button on that tab once); otherwise mode is 'screencast', picture only, and note says so. browser.openTab(url, {window: {width, height}}) opens a visible window (Chrome only paints visible windows). page.recordTab({fps, name, seconds?}) saves frames plus frames.json (for analysing motion), or returns {stop}. Locator actions return {box, tStart, tEnd}; page.mouse.move(x, y, {steps}); page.onCdp(event, handler) streams any DevTools event until stop(). page.diffScreenshot(before, {threshold, path}) compares screenshots; path writes a red-marked diff PNG.",
  demonstrations:
    "const demo = await page.recordDemonstration(); let the user do the task; const recording = await demo.stop() returns {steps, code, skill}. Review the code, set a clear name and domains, then saveAbility(recording.skill). Password fields are redacted; never ask for a password in chat.",
  boosts:
    "Lasting changes to a site on every visit (hide parts, restyle, dark mode, auto-click a banner, block requests, a panel): browser.boosts.save({name, sites: ['example.com'], css?, zaps?: [{selector, contains?}], look?, actions?: [{do: 'click', text: 'Accept all'}], network?, js?}). browser.boosts.list(url), enable(id, false), remove(id); saving with an id replaces it. Check selectors on the page first.",
  rules:
    "Per-tab network rules: page.rules.block({ads, trackers, banners, images, media, fonts, urls}) for faster reading, page.rules.headers({...}), page.rules.mock(urlFilter, json), page.rules.clear(). Permission prompts cannot be clicked, so preset them: page.permissions.allow('location' | 'notifications' | 'camera' | 'microphone' | 'popups' | 'downloads') or block; page.setLocation(lat, lng). page.emulate({device: 'iPhone' | 'android' | 'ipad', colorScheme: 'dark', timezone, locale}) or {reset: true}.",
  media:
    "page.saveMedia(selectorOrUrl, {all?, name?, folder?}) saves images, videos or files with the user's cookies into the workspace; page.upload(selector, files) fills a file input (finds the hidden input behind a drop zone; workspace paths or URLs); page.download(url); page.pdf(name) saves the page as PDF; page.recordMedia(selector?, {seconds}) records a playing video or audio element (up to 50 s a call); page.media.inspect() says what is playing (position, duration, muted, title), embedded players included.",
  live: "page.waitForChange(selector?, {timeoutMs}) resolves when that part changes; page.waitForResponse(urlPart) with the next matching response; page.waitForMessage(textOrRegex) with the next WebSocket or event-stream message. siteMapper.channel(site, id, {send, seconds}) for a mapped channel.",
  visual:
    "Only for canvases, maps, sliders, drag handles or controls without ids: page.screenshot({labels: true}) draws bu ids, then page.clickAt(x, y) / page.drag(x1, y1, x2, y2) in viewport coordinates; check with a fresh screenshot, then go back to bu.state().",
  debugging:
    "page.evaluate(fn, arg) runs page code and returns JSON; page.cdp(method, params) sends any DevTools command. page.console({errors: true}) returns console messages and errors (call once to start). Dialogs are accepted automatically; page.dialogs('dismiss') declines, page.dialogs('accept', text) answers prompts.",
  spaces:
    "browser.openTab(url, {space: 'window'}) keeps a session's tabs in one background window of its own (jobs, sweeps and outside sessions use it); {space: 'tabs'} keeps them in the user's window (the chat default). browser.session.finish({keep: ['p2']}) moves the kept tabs to the user and closes the rest; browser.session.claim() hands every tab to the user; browser.session.spaces() lists sessions as running, waiting, user or idle. Tabs carry stable labels (p1, p2…) in browser.tabs(); bu.use('p2') works wherever a tab id does, re-bound by URL after a restart. Every agent can read, act in, navigate and close every tab, its own, the user's or another session's; attach a listed tab before acting on it. Actions in one tab queue so two agents never interleave them; reads run in parallel. If the user clicks or types in a tab the agent drives, the next step waits until they have been still for 3 s, then runs (read the page again: they may have changed it). If they press Esc, the next step throws USER_TOOK_CONTROL (then USER_HAS_CONTROL) and browser.tabs() marks control: 'user'; page.waitForControl({timeoutMs}) waits until the user gives it back (the banner, the chat, or page.giveBack()). Never retry around it.",
  sweep:
    "browser.sweep(urls, {gate: true, capture: 'media', play: true, pilot?, checkpoint?, retry?, concurrency = 4, evidence?}) is the open-wait-capture-close loop as one durable job. Each URL gets {outcome, reason, gate, captured, media, evidence, ms}; outcomes are ok, gated, shell, dead, parked, redirected, blocked and error, and a run with no ok items returns a warning that the method is probably incomplete. pilot: 5 runs five and stops so you can look first; checkpoint: 'name' resumes, re-running only ambiguous items (retry adds outcomes); evidence: true keeps a screenshot, DOM text and network summary per item. It is browser.job underneath (status, cancel, resume). One site: await page.enterSite(), then page.network.list({since}) and page.media() ({masters, playlists, headers} from the manifests the tab requested).",
  workspace:
    "artifact(name, data) writes a file (strings, bytes, Blobs; other objects as JSON); checkpoint(name, value) / loadCheckpoint(name) persist JSON across resets; showImage(path) shows an image.",
  jobs: "browser.job(urlsOrItems, async (page, item, index) => …, {concurrency = 1, maxTabs = 4, timeoutMs = 120000, quiet = true, label}) returns {jobId} at once and runs the pages in the extension past the cell deadline. Each item is a URL or {url}, opens in its own tab, and closes after the item unless page.keep() was called. One failure does not stop the rest; results include {ok, item, value|error, kind, ms}. browser.job.status(jobId) shows done/total (status lost means the browser or worker restarted, so start it again); browser.jobCancel(jobId) stops it; browser.job.result(jobId) returns results and saves them as jobs/<jobId>.json. page is already on the item's URL (openTab + navigation done) when your function runs. Jobs are quiet by default (no popunders or autoplay).",
};

export const HELP_TOPICS = TOPICS;

const HABITS: Record<string, string> = {
  playwright:
    "there is no page.playwright: page itself is Playwright-style (page.locator, page.getByRole)",
  $: "page.$(css) is awaited and returns a handle or null, not a promise chain: use page.locator(css) and its methods",
  $x: "for XPath use page.locator('xpath=//...')",
  waitForTimeout:
    "never sleep blindly: page.waitForSelector(css), page.waitForChange(selector) or page.waitForResponse(urlPart)",
  type: "use locator.fill(text), or bu.type(id, text, {enter: true})",
  content: "use page.markdown() or page.data(), not the raw HTML",
  evaluateHandle: "use page.evaluate(fn, arg); it returns JSON",
  goBack: "use page.goto(url) with the URL you came from",
  catch: "await the call inside try/catch instead of chaining .catch on it",
  then: "await the call instead of chaining .then on it",
  click:
    "click a locator (page.getByRole('button', {name}).click()) or an observed id (bu.click(id))",
};

export const browserHelpApi = `
var __helpTopics = ${JSON.stringify(TOPICS)};
var __habits = ${JSON.stringify(HABITS)};
var __helpAliases = {map: 'api', mapping: 'api', mapped: 'sites', login: 'signin', challenge: 'gated', captcha: 'gated', error: 'errors', screenshots: 'screenshot', context: 'history', bookmarks: 'history', forms: 'profile', drop: 'snipe', table: 'tables', proxy: 'identity', accounts: 'identity', release: 'snipe', form: 'profile', code: 'signin', otp: 'signin'};
// help(topic) is synchronous: it prints the text and returns it as a string.
function help(topic) {
  var key = topic && String(topic).toLowerCase();
  var text = key && (__helpTopics[key] || __helpTopics[__helpAliases[key]]);
  if (!text) text = (topic ? 'No help topic ' + JSON.stringify(topic) + '. ' : '') + 'Topics: ' + Object.keys(__helpTopics).join(', ') + '. Call help(topic); it returns the text as a string (no await needed).';
  console.log(text);
  return text;
}
function __distance(a, b) {
  var row = Array.from({length: b.length + 1}, (_, i) => i);
  for (var i = 1; i <= a.length; i++) {
    var previous = row[0]; row[0] = i;
    for (var j = 1; j <= b.length; j++) {
      var current = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, previous + (a[i - 1] === b[j - 1] ? 0 : 1));
      previous = current;
    }
  }
  return row[b.length];
}
function __members(value) {
  var names = new Set();
  for (var item = value; item && item !== Object.prototype && item !== Function.prototype; item = Object.getPrototypeOf(item))
    for (var name of Object.getOwnPropertyNames(item)) if (!name.startsWith('_')) names.add(name);
  return [...names];
}
function __nearest(name, names) {
  var lower = name.toLowerCase();
  var scored = names.map(candidate => [candidate, candidate.toLowerCase().includes(lower) || lower.includes(candidate.toLowerCase()) ? 1 : __distance(lower, candidate.toLowerCase())]);
  return scored.filter(([, score]) => score <= Math.max(2, Math.floor(name.length / 3))).sort((a, b) => a[1] - b[1]).slice(0, 3).map(([candidate]) => candidate);
}
var __roots = {page: () => globalThis.page, browser: () => browser, bu: () => bu, siteMapper: () => siteMapper, skills: () => skills};
var __helpers = ['help', 'artifact', 'checkpoint', 'loadCheckpoint', 'saveHelper', 'loadHelper', 'showImage', 'google', 'tables'];
// Names the cell used that the real objects don't have: page.playwright, browser.history.find.
function __unknownMembers(code) {
  var found = [], seen = new Set(), pattern = /\\b(page|browser|bu|siteMapper|skills)((?:\\.[A-Za-z_$][\\w$]*)+)/g, match;
  while ((match = pattern.exec(String(code || ''))) && found.length < 3) {
    var owner = __roots[match[1]](), path = [match[1]];
    for (var name of match[2].slice(1).split('.')) {
      if (owner == null || typeof owner !== 'object' && typeof owner !== 'function') break;
      var member; try { member = owner[name]; } catch { break; }
      if (member === undefined) {
        var key = path.join('.') + '.' + name;
        if (seen.has(key)) break;
        seen.add(key);
        var near = __nearest(name, __members(owner));
        found.push(__habits[name] || key + ' does not exist' + (near.length ? '; did you mean ' + near.map(n => path.join('.') + '.' + n).join(' or ') + '?' : ''));
        break;
      }
      owner = member; path.push(name);
    }
  }
  return found;
}
// After a cell that worked but went the long way round: one line pointing at the shorter way,
// at the moment it matters (models follow results better than guidance read long before).
// Each tip shows once per session.
var __tipsShown = new Set();
var __TIPS = [
  [/localStorage|sessionStorage|document\\.cookie|\\bcookieStore\\b/, 'never read sign-in data (cookies, storage, tokens): the page and siteMapper already act as the signed-in user'],
  [/(scrollTop|scrollBy|scrollTo|scrollIntoView)[\\s\\S]*(querySelectorAll|\\$\\$eval|data-index)|(querySelectorAll|\\$\\$eval|data-index)[\\s\\S]*(scrollTop|scrollBy|scrollTo)/, 'page.list(rowCss?) reads every row of a list in one call, including lists that only draw what is on screen'],
  [/querySelector(All)?\\([^)]*\\)[^;\\n]*\\.click\\(|dispatchEvent\\(new MouseEvent/, 'click by visible text, role or bu id (page.getByText(text).click(), bu.click(id)): raw DOM clicks miss on apps that redraw themselves'],
  [/performance\\.getEntries/, 'page.network.list(match) lists the site\\'s own requests, and siteMapper calls what was learned from them'],
  [/document\\.body\\.innerText|document\\.body\\.textContent/, 'page.markdown() or bu.state({query}) reads the page cleanly; page.data() has its embedded data'],
];
function __tip(code) {
  for (var [pattern, text] of __TIPS)
    if (pattern.test(String(code || '')) && !__tipsShown.has(text)) { __tipsShown.add(text); return text; }
  return '';
}
// "page.playwright.click is not a function", "foo is not defined", "reading 'x'".
function __hint(message, code) {
  try {
    var text = String(message || '');
    if (/CLAIM_CONFLICT/.test(text))
      return 'another chat is using that tab; browser.attachTab(tab) gives this chat its own copy, or browser.openTab(url, {newTab: true})';
    if (/is not a function|is not defined|Cannot read properties/.test(text)) {
      var unknown = __unknownMembers(code);
      if (unknown.length) return unknown.join('; ');
      var last = /([A-Za-z_$][\\w$]*) is not a function/.exec(text);
      if (last && __habits[last[1]]) return __habits[last[1]];
    }
    var call = /([A-Za-z_$][\\w$]*(?:\\.[A-Za-z_$][\\w$]*)+)(?:\\(\\.\\.\\.\\))? is not a function/.exec(text);
    if (call) {
      var parts = call[1].split('.'), root = __roots[parts[0]];
      var name = parts[parts.length - 1], hints = [];
      if (__habits[parts[1]] && root) hints.push(__habits[parts[1]]);
      else if (__habits[name]) hints.push(__habits[name]);
      if (root) {
        var owner = root();
        for (var part of parts.slice(1, -1)) owner = owner == null ? owner : owner[part];
        if (owner != null && !hints.length) {
          var near = __nearest(name, __members(owner));
          if (near.length) hints.push('did you mean ' + near.map(n => parts.slice(0, -1).join('.') + '.' + n).join(' or ') + '?');
        }
      }
      return hints.join('; ');
    }
    var missing = /^([A-Za-z_$][\\w$]*) is not defined/.exec(text);
    if (missing) {
      // Suggest only browser-code names: nearest DOM globals (WebGLTexture for "text") mislead.
      var near = __nearest(missing[1], Object.keys(__roots).concat(__helpers));
      return 'nothing called ' + missing[1] + ' exists here' + (near.length ? '; did you mean ' + near.join(' or ') + '?' : '') + '. A cell returns its last expression and console.log prints more; top-level variables already persist between cells, so nothing needs storing; help() lists what browser code can do.';
    }
    if (/Cannot read properties of (undefined|null)/.test(text))
      return 'something returned ' + (/null/.test(text) ? 'null' : 'undefined') + ' (page.$ returns null when nothing matches; locators wait for the element instead)';
  } catch {}
  return '';
}
`;
