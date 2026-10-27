// help(topic) in browser code: the reference for everything used now and then, so the always-on
// tool guidance stays short. __hint(message) turns a failed cell's error into a "did you mean"
// from the real API surface, plus fixes for the Playwright habits that do not apply here.

const TOPICS: Record<string, string> = {
  signin:
    "await bu.signIn({account?}) signs in to the current page with a login from the user's password manager (Bitwarden or Proton Pass): it fills the username, password and, when saved, the one-time code, across multi-step forms, and returns {signedIn, site, provider, account, reason?, accounts?}. You never see the password. The first time on a site the user is asked on the page (not now, this time, always). reason CHOOSE_ACCOUNT lists accounts: call again with {account}. NO_PASSWORD_MANAGER, NO_SAVED_LOGIN, NEEDS_CODE (a code by SMS or email), CAPTCHA or DECLINED: bu.handoff('Please sign in'). REJECTED: the site refused the login; tell the user, do not retry. Open the site's sign-in page first.",
  tabs: "browser.openTab(url, {newTab?, quiet?, window?: {width, height}}) opens a background tab (one per site: openTab on a site you have a tab for navigates it; if the user closed it, pass {newTab:true}). browser.tabs(query?) lists {id, title, url, active, mine}: mine:true only for tabs this chat or session opened, so filter on mine, never on an id range; tab.tabId, tab.windowId and tab.target work too. browser.activeTab() is the active tab of the window the user last focused; bu.use(tabId) switches; browser.attachTab(target) uses a tab you did not open. browser.closeTab(id) closes one this chat opened (unsplitting first; a user tab, another session's tab or a hand-off tab throws clearly); page.close() does the same for page. At the end of a run the agent's tabs close except the last one used and tabs the user switched to; page.keep() hands a tab to the user. browser.reset() closes every tab this chat opened (kept ones stay). browser.moveTab(...) reorders tabs. browser.pool(urls, async (tab, url) => ..., {concurrency}) works through pages in parallel tabs. browser.fetch(url) fetches with the user's cookies and no tab.",
  reading:
    "page.read({max}) reads the page in one call: embedded data, the main repeated list and Markdown, merged with partial flags; it expands Show more/Show replies/Read more inside the main content (expand: false turns that off) and waits up to 5s for the content to settle. Kept under max (40k characters by default); the rest is saved with artifact(). bu.state({selector, query, max}) scopes the observation. page.data() returns embedded JSON (JSON-LD, __NEXT_DATA__, app state) and metadata, with the largest arrays of objects it holds; page.data({summary: true}) lists its sources; page.data({find: ['title', 'id']}) returns the arrays of objects that have those keys, each with its path and count. page.table(css) returns rows keyed by header; page.list(rowCss?, {max}) returns every row of a list as {count, complete, partial, items: [{key, text, href}]}, scrolling lists that only draw the rows on screen or load more on scroll (rows are guessed when no selector is given); page.links(css) {text, href}; page.markdown() clean main content, including repeated article/feed items, with a PARTIAL note when it saw less than the page holds; page.textContent(css); page.pdfText() for PDFs; await page.frames() for iframes. Locators: page.locator(css) / getByRole(role, {name}) / getByText / getByLabel / getByPlaceholder with .click() .fill(v) .innerText() .textContent() .inputValue() .getAttribute(n) .count() .all() .nth(i) .first() .allInnerTexts() .evaluate(fn) .boundingBox(); page.$eval / page.$$eval(css, fn).",
  forms:
    "page.controls.inspect({query?, hidden?}) lists every form field with its state: label, value, options (* = selected), checked, min/max/step, required, disabled, invalid, group, frame. page.controls.directory({query}) adds buttons, links, tabs and menu items. page.batch(steps, {observe?, pace?}) runs steps in one call: {action: 'fill'|'select'|'check'|'uncheck'|'click'|'press'|'wait'|'read'|'readUrl', target: {label} | {role, name} | {text} | {placeholder} | {css} (+ {exact}, {nth}, {frame: urlPart}), value, expect}. Each target must match exactly one element (it waits for it to appear); it stops at the first failure and says which steps ran. A batch that changes the page ends with {action: 'read', target, expect: 'text'} or {action: 'readUrl', expect: '/done'}, or passes {observe: true}. Example: await page.batch([{action: 'fill', target: {label: 'Email'}, value: 'a@b.c'}, {action: 'select', target: {label: 'Country'}, value: 'India'}, {action: 'check', target: {label: 'I agree'}}, {action: 'click', target: {role: 'button', name: 'Continue'}}, {action: 'read', target: {role: 'heading'}, expect: 'Thank you'}]).",
  overlays:
    "page.overlays.dismiss() closes cookie notices (rejecting when it can) and promotions or newsletter pop-ups covering the page, and returns what it clicked; {accept: true} accepts cookies when that is the only way through. Dialogs that are neither are left alone. page.challenges() names a bot check, captcha, block, rate limit or sign-in wall on the page, with what to do (bu.state() also notes them).",
  history:
    "browser.history.search(text, {days, max}) returns visited pages {url, title, lastVisit, visits}. browser.bookmarks.search(text) / tree() / children(id) / create({title, url, parentId}) / update(id, {title, url}) / move(id, {parentId, index}) / remove(id). browser.downloads.list(text?) returns recent downloads with filename and state.",
  api: "siteMapper.code(url, {grep}) reads a site's HTML, JS chunks, route manifests, source maps, robots and sitemap before guessing URLs; it returns routes, files, source-map sources and matches. siteMapper.sites() and siteMapper.operations(site) list what sites learned. siteMapper.call(site, operation, params) reads; siteMapper.watch(site, operation, params, {key}) returns only items new or changed since the last watch (also in routine checks). Writes: do one in the page; once the output says it was learned and proven, siteMapper.write(site, operation, params) repeats it and siteMapper.batch(site, operation, items, {perSecond, verify, label}) runs it over many items (paced, checks the first with verify(result, item), stops at the first error; continue what is left in the page, which repairs the operation). Paying, ordering, sending, posting, deleting and account changes stay in the page. siteMapper.action(site, name, inputs) runs a saved multi-step action; siteMapper.undo(site, operation, params) reverses a proven write whose opposite was learned; siteMapper.channel(site, id, {send, seconds}) listens on a live channel. A site can also save callable helpers: site.tools.<name>(args) runs its Node tool (siteMapper.call and browser.fetch only) and site.pageTools.<name>(args) runs its page tool in this document; only the current host's enabled tools resolve.",
  sites:
    "Mapped sites and their saved tools: siteMapper.sites(), siteMapper.operations(site), siteMapper.call(site, operation, params), siteMapper.action(site, name, inputs). A site pack can carry site.tools.<name>(args) (Node; siteMapper.call and browser.fetch) and site.pageTools.<name>(args) (in this page); bu.state() lists the current host's enabled tools. Tools are disabled on import until a human enables them with browserkit site tools enable <site>.",
  readonly:
    "A session claimed with readOnly:true refuses ordinary write steps with READ_ONLY. It is a guard, not a sandbox: page.evaluate(...) can still mutate through the page's own APIs.",
  state:
    "Clearing browser state: cookies -> browser.cookies.clear({url} or {domain}); web storage (localStorage, sessionStorage, IndexedDB) -> page.cdp('Storage.clearDataForOrigin', {origin, storageTypes: 'local_storage,session_storage,indexeddb'}) with an explicit origin; service workers -> page.cdp('ServiceWorker.stopAllWorkers') or page.cdp('ServiceWorker.stopWorker', {versionId}); permissions -> page.permissions.allow(type), block(type) or reset(type); everything the origin stores (cookies excluded) -> page.cdp('Storage.clearDataForOrigin', {origin, storageTypes: 'all'}). The HTTP cache is not offered: Network.clearBrowserCache is refused browser-wide. Also refused: Network.clearBrowserCookies and Storage.clearCookies (use browser.cookies), and Storage.clearDataForOrigin without an origin.",
  network:
    "Every tab you open or navigate is recorded from its first request, so page.network.list('/api' | {match, method}) works without start(); an empty list says why. page.network.waitFor({match: '/api/x' or /regex/, method?, status?, timeoutMs}) resolves with the first matching request that finishes ({url, status, headers, body}) and names the pattern when it times out: use it after a click or navigation instead of a sleep. For a full capture: page.network.start({types: 'all', dryRun?}) then do the flow; dryRun blocks requests that would change something (send, post, buy), answering {} so the page goes on. page.network.get(id) the full request and response, page.network.body(id) the parsed response, page.network.failures() groups failed requests with statuses, sizes, block headers and the last success, page.network.save(name) a HAR file. HAR headers, cookies, query strings, bodies and URLs are redacted by default; pass {raw: true} to page.network.har/save to keep real values. page.replay(id, {query, json, headers}) re-sends a recorded call from the page with its cookies, signatures and CSRF; page.request(url, {method, json, csrf: true}) makes a new one. browser.fetch(url, {headers: {referer, origin}, method, json}) calls an API with the user's cookies, no tab: referer and origin are set for that one request, for APIs that check where a call came from; a failure names its kind (dns, tls, refused, reset, timeout, cors, blocked-page) and host. page.session() returns cookies and storage.",
  skills:
    "Skills for the current site load by themselves (bu.state() says what they define). skills.list(url), skills.load(name). Save what took more than one try before answering: skills.save({name: 'site-task', domains: ['example.com'], description, examples, code}) where code is top-level declarations (const helper = async (...) => {...}) using page and bu, or a function returning an object of helpers. saveHelper(name, fn) / loadHelper(name) keep one function for this workspace.",
  progress:
    "Long work: bu.progress(done, total, label) updates the user in one cell. For a list of more than a few pages or sites use browser.job(items, async (page, item, index) => …, {concurrency, maxTabs, timeoutMs, quiet}) instead of a long cell: it returns {jobId} and keeps running past the deadline, each item in its own tab (closed afterwards unless kept), one failure isolated. browser.job.status(id) and browser.job.result(id) check it later; result saves the whole result as a workspace artifact. checkpoint(name, value) saves progress across resets.",
  recording:
    "browser.openTab(url, {window: {width, height}}) opens a visible window (Chrome only paints visible windows). page.recordTab({fps, name, seconds?}) saves frames plus frames.json, or returns {stop}. Locator actions return {box, tStart, tEnd}; page.mouse.move(x, y, {steps}); page.onCdp(event, handler) streams any DevTools event until stop(). page.diffScreenshot(before, {threshold, path}) compares screenshots; path writes a red-marked diff PNG.",
  demonstrations:
    "const demo = await page.recordDemonstration(); let the user do the task; const recording = await demo.stop() returns {steps, code, skill}. Review the code, set a clear name and domains, then skills.save(recording.skill). Password fields are redacted; never ask for a password in chat.",
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
    "browser.openTab(url, {space: 'window'}) keeps a session's tabs in one background window of its own (jobs, sweeps and outside sessions use it); {space: 'tabs'} keeps them in the user's window (the chat default). browser.session.finish({keep: ['p2']}) moves the kept tabs to the user and closes the rest; browser.session.claim() hands every tab to the user; browser.session.spaces() lists sessions as running, waiting, user or idle. Tabs carry stable labels (p1, p2…) in browser.tabs(); bu.use('p2') works wherever a tab id does, re-bound by URL after a restart. Tabs belong to the session that opened them (TAB_OWNED_ELSEWHERE; browser.tabs({all: true}) shows them). If the user clicks or types in a tab the agent drives, the next step throws USER_TOOK_CONTROL (then USER_HAS_CONTROL) and browser.tabs() marks control: 'user'; page.waitForControl({timeoutMs}) waits until the user gives it back (the banner, the chat, or page.giveBack()). Never retry around it.",
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
function help(topic) {
  var text = topic && __helpTopics[String(topic).toLowerCase()];
  if (!text) text = (topic ? 'No help topic ' + JSON.stringify(topic) + '. ' : '') + 'Topics: ' + Object.keys(__helpTopics).join(', ') + '. Call help(topic).';
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
var __helpers = ['help', 'artifact', 'checkpoint', 'loadCheckpoint', 'saveHelper', 'loadHelper', 'showImage', 'google'];
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
