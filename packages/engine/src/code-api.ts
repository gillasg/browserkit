// The browser_code page API, evaluated once in each chat's sandbox realm. Browser steps go through __call.
export const browserCodeApi = `
// Chrome accepts every alert/confirm/prompt by default; this lets the agent decline or answer them.
function __dialogShim(policy) {
  var accept = policy.mode !== 'dismiss';
  window.confirm = (message) => { console.info('[dialog confirm] ' + message + (accept ? ' (accepted)' : ' (dismissed)')); return accept; };
  window.prompt = (message, value) => { console.info('[dialog prompt] ' + message); return accept ? (policy.promptText || value || '') : null; };
  window.alert = (message) => { console.info('[dialog alert] ' + message); };
}
var __devices = {
  iphone: {width: 390, height: 844, scale: 3, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'},
  android: {width: 412, height: 915, scale: 2.625, userAgent: 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36'},
  ipad: {width: 820, height: 1180, scale: 2, userAgent: 'Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'},
};
function __geolocationShim(coords) {
  var geo = navigator.geolocation;
  if (!geo || geo.__aeonShim) return;
  var real = { get: geo.getCurrentPosition.bind(geo), watch: geo.watchPosition.bind(geo) };
  var position = () => ({ coords: { ...coords, altitude: null, altitudeAccuracy: null, heading: null, speed: null }, timestamp: Date.now() });
  var fallback = (ok, fail) => (error) => (error && error.code === 1 ? ok(position()) : fail && fail(error));
  geo.getCurrentPosition = (ok, fail, options) => real.get(ok, fallback(ok, fail), options);
  geo.watchPosition = (ok, fail, options) => real.watch(ok, fallback(ok, fail), options);
  Object.defineProperty(geo, "__aeonShim", { value: true });
}
// What the engine's strict step schema accepts of a locator; filters and regexes resolve in the page.
function __wire(element) {
  var keys = element.kind === 'locator' ? ['kind','role','name','exact','scope'] : element.kind === 'query' ? ['kind','by','value','exact','scope'] : null;
  if (!keys) return element;
  var out = {};
  for (var key of keys) if (element[key] !== undefined) out[key] = element[key];
  return out;
}
var __pressKeys = ['Enter','Tab','Escape','Backspace','Delete','ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Home','End','Space'];
// Named keys go to the engine; any other key or chord is typed after clicking the element.
async function __press(target, element, key, options, locator) {
  key = String(key);
  if (key === 'Esc') key = 'Escape';
  if (key === ' ') key = 'Space';
  if (__pressKeys.includes(key) && locator === undefined)
    return __step({op:'press',target,element:__wire(element),key,...(options && options.focus === false ? {focus:false} : {})});
  if (locator) await locator.click(); else if (!(options && options.focus === false)) await browser.page(target).click(element);
  return browser.page(target).keyboard(key);
}
// Actions on a locator report what they touched and when: {box, tStart, tEnd} (box in CSS pixels of
// the viewport just before the action; times in epoch ms, the clock screencast frames use).
var __TIMED = ['click', 'dblclick', 'fill', 'hover', 'check', 'uncheck', 'press', 'selectOption'];
function __timeActions(locator) {
  for (var name of __TIMED) {
    var action = locator[name];
    if (typeof action !== 'function') continue;
    locator[name] = ((run) => async (...args) => {
      var box = await locator.boundingBox().catch(() => null), tStart = Date.now();
      var result = await run(...args);
      var timing = {box, tStart, tEnd: Date.now()};
      return result && typeof result === 'object' && !Array.isArray(result) ? {...result, ...timing} : {value: result, ...timing};
    })(action);
  }
  return locator;
}
function __locator(target, element, index) {
  var loc = Object.freeze(__timeActions(__extendLocator(target, element, {
    element,
    click: () => __step({op:'click',target,element:__wire(element),observe:false}),
    fill: (value) => __step({op:'fill',target,element:__wire(element),value:String(value),observe:false}),
    press: (key, options) => __press(target, element, key, options, __pressKeys.includes(String(key)) && index === undefined && !(element.filters || element.regex) ? undefined : loc),
    getByRole: (role, options = {}) => {
      if (element.kind !== 'query' || element.by !== 'css') throw Error('Scope with page.locator(css).getByRole(...)');
      return __locator(target,__withOptions({kind:'locator',role,name:options.name === undefined ? '' : String(options.name),exact:options.name !== undefined,scope:element.value}, options));
    },
    locator: (selector) => {
      if (element.kind !== 'query' || element.by !== 'css') throw Error('Scope with a CSS locator');
      return __locator(target,{kind:'query',by:'css',value:selector,scope:element.value});
    },
  }, index)));
  return loc;
}
// Playwright's hasText / hasNotText / has / hasNot options become page-side filters on the locator.
function __withOptions(element, options = {}) {
  var encode = (value) => value instanceof RegExp ? [value.source, value.flags] : value;
  var filter = {};
  if (options.hasText !== undefined) filter.hasText = encode(options.hasText);
  if (options.hasNotText !== undefined) filter.hasNotText = encode(options.hasNotText);
  if (options.has && options.has.element) filter.has = __spec(options.has.element);
  if (options.hasNot && options.hasNot.element) filter.hasNot = __spec(options.hasNot.element);
  if (options.exact !== undefined && element.kind === 'query') element = {...element, exact: !!options.exact};
  return Object.keys(filter).length ? {...element, filters: [...(element.filters || []), filter]} : element;
}
function __withFilter(element, filter) { return {...element, filters: [...(element.filters || []), filter]}; }
function __originOf(url) { try { return new URL(url).origin; } catch { return ''; } }
// Host-wide calls (cookies, the network store, the scheduler) still need a live tab to answer on.
function __hostTarget() {
  if (!__lastTarget) throw Error('NO_TAB: open or attach a tab first (browser.openTab / bu.use)');
  return __lastTarget;
}
function __netFilter(value) {
  if (value === undefined || value === null) return {};
  return typeof value === 'string' ? {match: value} : value;
}
var browser = Object.freeze({
  waitFor: (event, options = {}) => __event(options.target || __lastTarget,event,options),
  // Listed tabs work as pages too (agents call tab.locator(...) or use tab.id); acting on one
  // the session did not open still needs browser.attachTab(tab) first.
  tabs: Object.assign(async (query) => {
      var options = query && typeof query === 'object' ? query : (query ? {query: query} : {});
      var result = await __step({op:'listTabs',
        ...(options.query ? {query: options.query} : {}),
        ...(options.mine === true ? {mine:true} : {}),
        ...(options.all === true ? {all:true} : {})});
      __focusedWindowId = result.focusedWindowId;
      var listed = result.tabs.map(tab => __listedTab(__compactTab(tab)));
      if (listed.length > 64) console.log('[warn] ' + listed.length + ' tabs are open; pass a query or {mine:true} to narrow the list. Every tool still works on one tab.');
      // mine: only the tabs this chat or session opened (the same set browser.closeTab accepts).
      return options.mine === true ? listed.filter(tab => tab.mine) : listed;
    },
    {list: async (query) => browser.tabs(query)}),
  // The tabs this chat or session opened; browser.tabs({mine:true}) answers the same list.
  myTabs: () => browser.tabs({mine:true}),
  // Close one tab this chat/session opened. A user tab, another session's tab or a hand-off tab
  // throws instead of doing nothing; a tab in Split View is unsplit first.
  closeTab: async (tab) => {
    var id = typeof tab === 'number' ? tab : tab?.tabId ?? tab?.target?.tabId;
    if (!Number.isSafeInteger(id)) throw Error('INVALID_TARGET: browser.closeTab needs a tab id or a tab from browser.tabs()');
    var known = [...__tabs.values()].find((item) => item.target?.tabId === id);
    var result = await __call({tabs:'close', tabId:id});
    __closedTabs.set(id, { url: known?.url || '', at: Date.now() });
    __forgetTab(id);
    return result;
  },
  // The tab the user is looking at: the active tab of the window they last focused, as a page.
  activeTab: async () => {
    var tabs = await browser.tabs();
    var tab = tabs.find(listed => listed.active && (__focusedWindowId === undefined || listed.windowId === __focusedWindowId))
      || tabs.find(listed => listed.active);
    if (!tab) throw Error('TARGET_LOST: the active tab is not a web page (a new tab or browser page)');
    await browser.attachTab(tab.target);
    return tab;
  },
  getActiveTab: async () => browser.activeTab(),
  // Reorder tabs (the user's too): browser.moveTab(tabIdOrPage | [..], {index, windowId}); index -1 = end.
  moveTab: (tabs, options = {}) => {
    var ids = (Array.isArray(tabs) ? tabs : [tabs]).map(tab => typeof tab === 'number' ? tab : tab && (tab.tabId ?? tab.target?.tabId));
    if (typeof options === 'number') options = {index: options};
    return __call({tabs:'move', tabIds: ids, index: options.index ?? -1, ...(options.windowId !== undefined ? {windowId: options.windowId} : {})});
  },
  openTab: async (url, options = {}) => {
    let clientInstanceId = options.clientInstanceId || __lastTarget?.clientInstanceId;
    if (!clientInstanceId) {
      const clients = (await __call({browserInfo:true})).clientInstanceIds;
      if (clients.length === 0) throw Error('BROWSER_OFFLINE: no browser executor is connected');
      if (clients.length !== 1) throw Error('Multiple browser profiles are connected; choose clientInstanceId from browser.tabs()');
      clientInstanceId = clients[0];
    }
    // One working tab per site: a URL on an origin this session already has a tab for navigates that
    // tab. Pass {newTab: true} for a separate tab.
    url = String(url);
    const origin = __originOf(url);
    var known = options.newTab === true || options.new === true || options.window ? undefined : __opened.get(origin || url);
    // Parallel opens on one site: the first navigates the working tab, the rest get their own tabs.
    if (known && __busy.has(__key(known))) known = undefined;
    if (known) {
      __busy.add(__key(known));
      try {
        const live = (await browser.tabs()).find(tab => __key(tab.target) === __key(known));
        if (live) {
          const same = String(live.url) === url;
          await bu.use(known);
          if (options.quiet === true) await __call({quiet:{target:known, enabled:true}});
          if (!same) await browser.page(known).navigate(url);
          console.log('[ok] openTab reused tab ' + known.tabId + ' for ' + (origin || url) + (same ? '' : ' (navigated)') + '; pass {newTab: true} for a separate tab');
          return __openResult(live, true);
        }
        // A working tab the user closed is not a failure: open a fresh one and say so.
        console.log('[warn] the working tab ' + known.tabId + ' for ' + (origin || url) + ' was closed; opened a fresh tab');
      } finally { __busy.delete(__key(known)); }
    }
    const result = await __step({op:'openTab', clientInstanceId, url,
      foreground: options.foreground === true,
      ...(options.referer ? {referer: String(options.referer)} : {}),
      ...(options.quiet === true ? {quiet:true} : {}),
      ...(options.present === false ? {present:false} : {}),
      ...(options.timeoutMs ? {timeoutMs: Math.max(500, Math.min(Number(options.timeoutMs) || 0, 120000))} : {}),
      ...(options.window ? {window: {width: Math.round(options.window.width ?? 1920), height: Math.round(options.window.height ?? 1080)}} : {})});
    if (!options.window) __opened.set(origin || url, result.tab.target);
    // What an earlier session learned about this host (a gate, a required referer, a play click)
    // arrives as one line, so a new run starts where the last one ended.
    __call({learned:{url}}).then((note) => {
      if (note && note.hint) console.log('[learned] ' + note.hint);
    }).catch(() => {});
    await bu.use(result.tab.target);
    if (result.navigation === 'failed') {
      __noteNavError(result.tab.target, url, 'openTab', result.reason || 'navigation failed');
      console.log('[warn] tab ' + result.tab.target.tabId + ' opened, but ' + url + ' did not load: ' + (result.reason || 'navigation failed') + '; the tab is still yours (page.navigation is "failed", page.lastError says why)');
    }
    return __openResult(result.tab, false, result.navigation === 'failed' ? result.reason : undefined);
  },
  // A tab kept for later: an open tab on the URL is reused (and attached to this session), else a
  // new one opens and is kept. Kept tabs survive the run's tidy-up, so a later session finds them.
  keepPage: async (url, options = {}) => {
    var wanted = String(url);
    var tabs = await browser.tabs();
    var match = tabs.find(tab => tab.url === wanted) || tabs.find(tab => tab.url.split('#')[0] === wanted.split('#')[0]);
    if (match) {
      var kept = await browser.attachTab(match.target);
      await kept.keep();
      console.log('[ok] keepPage reused tab ' + match.id + ' for ' + wanted);
      return kept;
    }
    var page = await browser.openTab(wanted, {...options, ...(options.newTab === undefined ? {newTab:true} : {})});
    await page.keep();
    return page;
  },
  // Fetch without a tab: from the extension, with the user's cookies (credentials: 'omit' to skip).
  // A failed fetch carries why it failed: kind (dns, tls, refused, reset, timeout, cors,
  // blocked-page), host, and networkBlock for a name that resolves to a block or sinkhole page.
  fetch: async (url, init = {}) => {
    // asOrigin: the request carries the URL's own origin as Referer and Origin, the shorthand for
    // an API that refuses a bare call. An explicit referer/origin header wins.
    var request = {...init};
    if (request.asOrigin) {
      var origin = new URL(String(url)).origin;
      request.headers = {referer: origin + '/', origin, ...(request.headers || {})};
      delete request.asOrigin;
    }
    try { return await __call({fetch: {...request, url: String(url)}}); }
    catch (error) { throw __fetchFailure(error); }
  },
  // The chat's workspace, read as well as written: a path is relative to the session's folder and
  // can never leave it. write is artifact().
  workspace: Object.freeze({
    // A host answers the request itself, or wraps it in {data}; both shapes read the same.
    read: async (name) => {
      var reply = await __call({workspace:'read', name:String(name)});
      var data = reply && reply.data !== undefined ? reply.data : reply;
      return data ? data.text : undefined;
    },
    list: async (folder = '') => {
      var reply = await __call({workspace:'list', name:String(folder)});
      var data = reply && reply.data !== undefined ? reply.data : reply;
      return (data && data.entries) || [];
    },
    write: (name, data) => artifact(name, data),
  }),
  // Cookies for the whole browser: filtered by url or domain. Values stay hidden unless asked,
  // so listing never carries a token into a trace.
  cookies: Object.freeze({
    list: async (filter = {}) => (await __step({op:'cookies', target:__hostTarget(), action:'list', ...filter})).data,
    get: async (name, filter = {}) => (await __step({op:'cookies', target:__hostTarget(), action:'get', name:String(name), ...filter})).data,
    set: async (cookie) => (await __step({op:'cookies', target:__hostTarget(), action:'set', ...cookie})).data,
    remove: async (name, filter = {}) => (await __step({op:'cookies', target:__hostTarget(), action:'remove', name:String(name), ...filter})).data,
    clear: async (filter = {}) => (await __step({op:'cookies', target:__hostTarget(), action:'clear', ...filter})).data,
  }),
  // Every tab the session worked in, after the fact: a bounded store that survives a tab closing.
  network: Object.freeze({
    list: async (filter = {}) => (await __step({op:'networkStore', target:__hostTarget(), action:'list', ...__netFilter(filter)})).data,
    get: async (id) => (await __step({op:'networkStore', target:__hostTarget(), action:'get', id:String(id)})).data,
    body: async (id) => (await __step({op:'networkStore', target:__hostTarget(), action:'body', id:String(id)})).data,
    curl: async (id, options = {}) => (await __step({op:'networkStore', target:__hostTarget(), action:'curl', id:String(id), ...(options.secrets ? {secrets:true} : {})})).data,
    origins: async () => (await __step({op:'networkStore', target:__hostTarget(), action:'origins'})).data,
    stats: async () => (await __step({op:'networkStore', target:__hostTarget(), action:'stats'})).data,
    har: async (filter = {}) => (await __step({op:'networkStore', target:__hostTarget(), action:'har', ...__netFilter(filter)})).data,
    save: async (name = 'network.har', filter = {}) => { var har = await browser.network.har(filter); await artifact(name, JSON.stringify(har)); return {saved: name}; },
    clear: async () => (await __step({op:'networkStore', target:__hostTarget(), action:'clear'})).data,
  }),
  // What is queued or running: per-tab queues and the browser-wide write lock.
  scheduler: async () => (await __step({op:'scheduler', target:__hostTarget()})).data,
  // Windows and zoom: the browser's own window list, resizing, and per-tab zoom.
  windows: __windows,
  setZoom: (factor, tabId) => __zoom(factor, tabId),
  // Whether tabs an agent opens are grouped. browser.tabGrouping(false) turns grouping off and
  // takes back every tab an agent had grouped; browser.tabGrouping() reads the setting.
  tabGrouping: async (enabled) => {
    var result = await __call(typeof enabled === 'boolean'
      ? {tabGroups:'set', enabled}
      : {tabGroups:'get'});
    return result.enabled === true;
  },
  pool: (items, worker, options = {}) => __pool(items, worker, options),
  // Close every tab this chat/session opened (page.keep tabs stay), returning {closed, remaining}.
  reset: () => __call({tabs:'reset'}),
  // Everything this chat or session opened, closed: a failed run leaves no stray tabs.
  session: Object.freeze({
    close: () => __call({session:'close'}),
    reap: () => __call({session:'reap'}),
  }),
  // Many pages past the cell deadline: start a job, then check it in a later cell.
  job: __job,
  // Bulk capture over many URLs (a job mode): browser.sweep(urls, {gate, capture, play, evidence}).
  sweep: __sweep,
  // Stop a running job: browser.jobCancel(jobId), then browser.job(id) reports cancelled.
  jobCancel: (id) => __call({job:{action:'cancel', id:String(id)}}),
  downloads: Object.freeze({
    list: (text = "", options = {}) => __call({downloads:"list", text, ...options}),
  }),
  // Messages to other installed extensions that accept them, by extension id.
  sendToExtension: (id, message) => __call({extension: String(id), message}),
  // Lasting changes to sites, applied on every visit: {name, sites, css, zaps, actions, network, js}.
  boosts: Object.freeze({
    list: (url) => __call({boosts:"list", ...(url ? {url: String(url)} : {})}),
    get: (id) => __call({boosts:"get", id}),
    save: async (boost) => { var saved = await __call({boosts:"save", boost}); if (saved && saved.warning) console.log(saved.warning); return saved; },
    remove: (id) => __call({boosts:"remove", id}),
    enable: (id, enabled = true) => __call({boosts:"enable", id, enabled}),
  }),
  history: Object.freeze({
    search: (text = "", options = {}) => __call({history:"search", text, ...options}),
  }),
  bookmarks: Object.freeze({
    search: (query, options = {}) => __call({bookmarks:"search", query, ...options}),
    tree: () => __call({bookmarks:"tree"}),
    children: (id) => __call({bookmarks:"children", id}),
    create: (bookmark) => __call({bookmarks:"create", ...bookmark}),
    update: (id, changes) => __call({bookmarks:"update", id, ...changes}),
    move: (id, destination) => __call({bookmarks:"move", id, ...destination}),
    remove: (id, options = {}) => __call({bookmarks:"remove", id, ...options}),
  }),
  // Agents sometimes ask for a tab object by id: browser.tab(tabId or a listed tab).
  tab: async (tab) => bu.use(typeof tab === 'object' && tab ? (tab.target || tab) : tab),
  getTab: async (tab) => browser.tab(tab),
  // A tab another chat is driving can't be shared; the agent gets its own copy of the page
  // instead (the conflict only shows on first use, hence the tiny read).
  attachTab: async (target) => {
    target = await __tabTarget(target);
    try {
      await __step({op:'attachTab', target});
      var attached = await bu.use(target);
      await attached.inspect(() => 1);
      return attached;
    } catch (error) {
      var url = [...__tabs.values()].find(tab => __key(tab.target) === __key(target))?.url;
      if (!/CLAIM_CONFLICT|TAB_OWNED_ELSEWHERE/.test(String(error && error.message || error)) || !url) throw error;
      console.log('That tab is in use by another chat, so this chat opened its own copy: ' + url);
      return browser.openTab(url, {newTab: true});
    }
  },
  page: (target) => (__lastTarget = target, Object.freeze(__extendPage(target, {
    target,
    // Why the last navigation failed, if it did: { code, url, stage, message, at }. The page is
    // left as it is, so it can still be read or evaluated.
    get lastError() { return __lastErrors.get(__key(target)) || null; },
    // Both page.url / page.title (properties) and page.url() / await page.title() (Playwright) work.
    get url() { return __callableString(() => __tabs.get(__key(target))?.url || __states.get(__key(target))?.url); },
    get title() { return __callableString(() => __tabs.get(__key(target))?.title,
      () => __withTimeout(browser.page(target).inspect(() => document.title), 5000, 'PAGE_READ_TIMEOUT')); },
    [Symbol.for('nodejs.util.inspect.custom')]() { return {target,url:String(this.url),title:String(this.title)}; },
    waitForEvent: (event, options = {}) => __event(target,event,options),
    expect: async (event, action, options = {}) => {var wait=__event(target,event,options);await wait.ready;try {await action();return await wait;}catch(error){await wait.dispose().catch(()=>{});throw error;}},
    frames: async () => (await __step({op:'frames',target,action:'list'})).data.map(info=>__framePage(target,info)),
    // Files from the workspace, or image/file URLs (saved to the workspace first). The selector can be
    // the file input, or the upload button or drop zone it belongs to; leave it out for the page's only one.
    upload: async (selector, files) => {
      if (files === undefined) { files = selector; selector = 'input[type=file]'; }
      var local = [];
      for (var file of [].concat(files)) local.push(__isMediaUrl(file) ? (await __saveMedia(target, file, {folder:'uploads'}))[0].saved : file);
      return __step({op:'upload',target,selector,files:local});
    },
    // Saves images, videos or files into the workspace: a URL, or a selector (img, video, a, canvas,
    // or any element with a background image); {all:true} saves every match. Uses the user's cookies.
    saveMedia: (what, options = {}) => __saveMedia(target, what, options),
    setFileInputFiles: (backendNodeId, files) => __step({op:'upload',target,backendNodeId,files}),
    clickAt: (x,y) => __step({op:'pointer',target,action:'click',x,y}),
    doubleClickAt: (x,y) => __step({op:'pointer',target,action:'doubleClick',x,y}),
    hover: (x,y) => __step({op:'pointer',target,action:'hover',x,y}),
    drag: (x,y,toX,toY) => __step({op:'pointer',target,action:'drag',x,y,toX,toY}),
    keyboard: (keys) => __step({op:'keys',target,keys}),
    reconnect: () => __step({op:'reconnect',target}),
    download: async (url, filename) => (await __step({op:'downloads',target,action:'start',url,...(filename?{filename}:{})})).data,
    resolveDownload: async (token) => (await __step({op:'downloads',target,action:'resolve',token})).data,
    waitForDownload: async (downloadId, options = {}) => {var deadline=Date.now()+(options.timeoutMs??20000);while(Date.now()<deadline){var result=(await __step({op:'downloads',target,action:'wait',downloadId,timeoutMs:Math.min(1000,deadline-Date.now())})).data;if(result.state==='complete')return result;if(result.state==='interrupted')throw Error('DOWNLOAD_INTERRUPTED: '+result.error);}throw Error('TIMEOUT: download still in progress; do not start it again');},
    cancelDownload: (downloadId) => __step({op:'downloads',target,action:'cancel',downloadId}),
    read: (selector, options = {}) => __step({op:"read", target, selector: String(selector),
      ...(options.limit !== undefined ? {limit: __clamp(options.limit, 1, 100)} : {}),
      ...(options.textLimit !== undefined ? {textLimit: __clamp(options.textLimit, 1, 4000)} : {}),
      ...(Array.isArray(options.attributes) ? {attributes: options.attributes.filter(a => /^[\\w-]{1,80}$/.test(a)).slice(0, 10)} : {})}),
    // What this page is: ready, empty, loading, login, challenge, not-found or error, with why.
    readiness: async () => (await __step({op:'readiness', target})).data,
    // Waits out loading, then returns the readiness it settled on (or the last one, timedOut).
    waitReady: async (options = {}) => {
      var deadline = Date.now() + (options.timeoutMs ?? 15000);
      while (true) {
        var state = (await __step({op:'readiness', target})).data;
        if (state.state !== 'loading') return state;
        if (Date.now() >= deadline) return {...state, timedOut: true};
        await __sleep(Math.min(500, Math.max(100, options.intervalMs ?? 250)));
      }
    },
    // A number waits that many milliseconds; a selector waits for it (timeouts above the engine cap keep polling).
    wait: (selector, options = {}) => typeof selector === 'number' ? __sleep(selector) : __waitSelector(target, selector, options),
    navigate: async (url, options = {}) => {
      var destination = __absoluteUrl(url, target);
      try {
        var result = await __step({op:"navigate", target, url: destination,
          ...(options.referer ? {referer: String(options.referer)} : {}),
          ...(options.present === false ? {present:false} : {}),
          ...(options.timeoutMs ? {timeoutMs: Math.max(500, Math.min(Number(options.timeoutMs) || 0, 120000))} : {})});
        __lastErrors.delete(__key(target));
        return result;
      } catch (error) {
        __noteNavError(target, destination, 'navigate', error);
        throw error;
      }
    },
    diagnostics: (clear = false) => __step({op:"diagnostics", target, clear}),
    // The address the browser connected to for this page, i.e. what its resolver returned.
    dns: async () => {
      var entries = await browser.page(target).network.list().catch(() => []);
      var hit = entries.find((entry) => entry.remoteIPAddress);
      if (!hit) return null;
      var host = '';
      try { host = new URL(hit.url).hostname; } catch (error) {}
      return {host, address: hit.remoteIPAddress, url: hit.url};
    },
    console: async (options = {}) => {
      var entries = (await __step({op:"diagnostics", target, clear: !!options.clear})).data.console || [];
      return options.errors ? entries.filter((entry) => /error|exception/i.test(entry.level || '')) : entries;
    },
    dialogs: async (mode = 'accept', promptText = '') => {
      var shim = '(' + __dialogShim.toString() + ')(' + JSON.stringify({mode, promptText}) + ')';
      await __step({op:'cdp', target, method:'Page.addScriptToEvaluateOnNewDocument', params:{source: shim}});
      await __step({op:'evaluate', target, expression: shim});
      return {mode};
    },
    pdf: async (name = 'page.pdf', options = {}) => {
      var result = await __step({op:'cdp', target, method:'Page.printToPDF', params:{printBackground:true, ...options}});
      await __call({workspace:'artifact', name, value: result.data.value.data, base64: true});
      return {saved: name};
    },
    emulate: async (options = {}) => {
      var page = browser.page(target), device = __devices[String(options.device || '').toLowerCase()];
      var apply = async () => {
        if (device) {
          await page.cdp('Emulation.setDeviceMetricsOverride', {width: device.width, height: device.height, deviceScaleFactor: device.scale, mobile: true});
          await page.cdp('Emulation.setTouchEmulationEnabled', {enabled: true});
          await page.cdp('Emulation.setUserAgentOverride', {userAgent: device.userAgent});
        }
        if (options.colorScheme) await page.cdp('Emulation.setEmulatedMedia', {features: [{name: 'prefers-color-scheme', value: options.colorScheme}]});
        if (options.timezone) await page.cdp('Emulation.setTimezoneOverride', {timezoneId: options.timezone});
        if (options.locale) await page.cdp('Emulation.setLocaleOverride', {locale: options.locale});
      };
      if (options.reset) {
        await page.cdp('Emulation.clearDeviceMetricsOverride', {}).catch(() => {});
        await page.cdp('Emulation.setTouchEmulationEnabled', {enabled: false}).catch(() => {});
        await page.cdp('Emulation.setUserAgentOverride', {userAgent: ''}).catch(() => {});
        await page.cdp('Emulation.setEmulatedMedia', {features: []}).catch(() => {});
        await page.cdp('Emulation.setTimezoneOverride', {timezoneId: ''}).catch(() => {});
        await page.cdp('Emulation.setLocaleOverride', {}).catch(() => {});
        return {reset: true};
      }
      if (options.device && !device) throw Error('Unknown device; use one of ' + Object.keys(__devices).join(', '));
      // Reload before emulating: a reload can reconnect the debugger, and a reconnected session
      // starts without the overrides it had.
      if (device && options.reload !== false) await page.cdp('Page.reload', {});
      await apply();
      return {device: options.device, colorScheme: options.colorScheme, timezone: options.timezone, locale: options.locale};
    },
    popups: () => __step({op:"popups", target}),
    removePreview: (scriptId) => __step({op:"siteScript", target, action:"remove", scriptId}),
    snapshot: (options = {}) => { const {max,target:ignored,...filters}=options; return __step({op:'observe',target,kind:'semantic',...filters}); },
    locator: (selector, options = {}) => __locator(target,__withOptions({kind:'query',by:'css',value:String(selector)}, options)),
    getByRole: (role, options = {}) => __locator(target,__withOptions({kind:'locator',role,name:options.name === undefined ? '' : String(options.name),exact:options.name !== undefined && options.exact !== false}, options)),
    getByText: (value, options = {}) => __locator(target,__withOptions({kind:'query',by:'text',value:String(value)}, options)),
    getByLabel: (value, options = {}) => __locator(target,__withOptions({kind:'query',by:'label',value:String(value)}, options)),
    getByPlaceholder: (value, options = {}) => __locator(target,__withOptions({kind:'query',by:'placeholder',value:String(value)}, options)),
    press: (element, key, options = {}) => __press(target, __element(target, element), key, options),
    screenshot: (options = {}) => options.labels ? __labeledScreenshot(target) : __step({op:'observe', target, kind:'screenshot'}),
    diffScreenshot: (baseline, options = {}) => __diffScreenshot(target, baseline, options),
    recordDemonstration: (options = {}) => __recordDemonstration(target, options),
    click: (element) => __step({op:'click',target,element:__wire(__element(target,element)),observe:false}),
    fill: (element, value) => __step({op:'fill',target,element:__wire(__element(target,element)),value:String(value),observe:false}),
    evaluate: async (fn, arg) => (await __step({op:'evaluate',target,expression:__expression(fn,arg)})).data.value,
    inspect: async (fn, arg) => (await __step({op:'evaluate',target,expression:__expression(fn,arg)},true)).data.value,
    // Functions the page exposes on window, with their arity: what a page script can be built on.
    functions: async () => browser.page(target).inspect(__pageFunctions),
    // Extra request headers for this tab (delegates to page.rules.headers).
    setExtraHTTPHeaders: (headers) => __call({rules:'headers', target, headers}),
    pdfText: (options = {}) => browser.page(target).inspect(__readPdfText,options),
    cdp: async (method, params = {}) => (await __step({op:'cdp',target,method,params})).data.value,
    permissions: Object.freeze({
      allow: (type) => __call({permission:'set', target, type, setting:'allow'}),
      block: (type) => __call({permission:'set', target, type, setting:'block'}),
      reset: (type) => __call({permission:'set', target, type, setting:'ask'}),
    }),
    setLocation: async (latitude, longitude, accuracy = 50) => {
      await __call({permission:'set', target, type:'location', setting:'allow'});
      await __step({op:'cdp', target, method:'Emulation.setGeolocationOverride', params:{latitude, longitude, accuracy}});
      // When the OS has location turned off, Chrome still denies the request; answer it with the
      // chosen coordinates instead, on this page and on pages this tab loads later.
      const shim = '(' + __geolocationShim.toString() + ')(' + JSON.stringify({latitude, longitude, accuracy}) + ')';
      await __step({op:'cdp', target, method:'Page.addScriptToEvaluateOnNewDocument', params:{source: shim}});
      await __step({op:'evaluate', target, expression: shim});
      return {latitude, longitude};
    },
    rules: Object.freeze({
      block: (options) => __call({rules:"block", target, ...options}),
      headers: (headers) => __call({rules:"headers", target, headers}),
      mock: (url, body, contentType) => __call({rules:"mock", target, url, body, contentType}),
      list: () => __call({rules:"list", target}),
      clear: () => __call({rules:"clear", target}),
    }),
    network: Object.freeze({
      start: (options = {}) => __call({network:'start', target, ...options}),
      // The tab is recorded from its first request on, so this works without start(). An empty
      // list says why it is empty (it never is a bare []).
      list: async (options = {}) => {
        var filter = typeof options === 'string' ? {match: options} : options;
        var incremental = filter.cursor === true || filter.since !== undefined;
        var reply;
        try { reply = await __call({network:'list', target, ...filter}); }
        catch (error) {
          if (!/Not recording/.test(String(error && error.message))) throw error;
          await __call({network:'start', target});
          console.log('[ok] network capture started now (it was off, so nothing earlier was recorded); repeat the action or reload, then list again');
          reply = incremental ? {entries: [], cursor: 0} : [];
        }
        var entries = incremental ? (reply && reply.entries) || [] : reply;
        if (!entries.length) {
          var state = await __call({network:'state', target}).catch(() => ({}));
          var note = state.note;
          if (!note && state.recent && state.recent.length)
            note = 'no request matches ' + (filter.match ? '"' + filter.match + '"' : JSON.stringify(filter)) + ' here; captured: ' + state.recent.join(', ');
          if (note) {
            console.log('[ok] ' + note);
            Object.defineProperty(entries, 'note', {value: note, enumerable: false});
          }
        }
        // {since: lastCursor} reads only what arrived: {entries, cursor} for the next poll.
        return incremental ? {entries, cursor: (reply && reply.cursor) || 0} : entries;
      },
      // Resolves with the first request finishing after this call whose URL matches (substring or
      // /regex/), optionally a method and statuses: {url, status, headers, body}. Use it instead of
      // a sleep after a click, or start it first and await it after the click.
      waitFor: async (options = {}, extra = {}) => {
        var filter = typeof options === 'string' || options instanceof RegExp ? {match: options} : {...options, ...extra};
        if (filter.match instanceof RegExp) { filter.regex = true; filter.match = filter.match.source; }
        if (!filter.match && !filter.method && !filter.status) throw Error('page.network.waitFor needs a match (a URL part or /regex/), a method or a status');
        return __call({network:'waitFor', target, ...filter});
      },
      get: (id) => __call({network:'get', target, id}),
      // Every captured request as a Node fetch script would need it: method, url, headers,
      // cookies and postData. {requests, script} — script is runnable Node (fetch + a body loop).
      export: async (filter = {}) => {
        var entries;
        try { entries = await __call({network:'list', target, ...filter}); }
        catch (error) {
          if (!/Not recording/.test(String(error && error.message))) throw error;
          await __call({network:'start', target});
          entries = [];
        }
        var requests = [];
        for (var entry of entries.slice(0, 200)) {
          var full = await __call({network:'get', target, id:entry.id});
          var headers = full.requestHeaders || {};
          var cookieName = Object.keys(headers).find((name) => name.toLowerCase() === 'cookie');
          requests.push({
            method: full.method,
            url: full.url,
            headers,
            cookies: cookieName ? headers[cookieName] : '',
            postData: full.requestBody === undefined ? null : full.requestBody,
            status: full.status,
            responseHeaders: full.responseHeaders || {},
          });
        }
        var script = '// Captured requests; fetch with the same method, headers and body.\\n' +
          'globalThis.requests = ' + JSON.stringify(requests, null, 2) + ';\\n';
        return {requests, script};
      },
      // Failed requests grouped by endpoint: statuses, sizes, timing, block headers and the last
      // success. Repeated probes of the same limit collapse into one entry.
      failures: async (options = {}) => {
        try { return await __call({network:'failures', target, ...(typeof options === 'string' ? {match: options} : options)}); }
        catch (error) {
          if (!/Not recording/.test(String(error && error.message))) throw error;
          await __call({network:'start', target});
          console.log('[ok] network capture started now; repeat the action, then failures() again');
          return [];
        }
      },
      body: (id) => __call({network:'body', target, id}),
      har: () => __call({network:'har', target}),
      save: async (name = 'network.har') => (await artifact(name, JSON.stringify(await __call({network:'har', target}))), {saved: name}),
      clear: () => __call({network:'clear', target}),
      stop: () => __call({network:'stop', target}),
    }),
    fetchJson: async (url, init = {}) => {
      var result = await browser.page(target).evaluate(async ({url, init}) => {
        var response = await fetch(url, {credentials: 'include', ...init});
        var text = await response.text();
        try { return {status: response.status, data: JSON.parse(text)}; } catch { return {status: response.status, text: text.slice(0, 200000)}; }
      }, {url, init});
      if (result.status >= 400) throw Error('HTTP ' + result.status + ' from ' + url + ': ' + JSON.stringify(result.data ?? result.text).slice(0, 300));
      return result.data ?? result.text;
    },
    // Hands this tab to the user: it stays open after the run instead of being tidied away.
    keep: () => { __keptTabs.add(target.tabId); return __call({tabs:'keep', tabIds:[target.tabId]}); },
    close: () => browser.closeTab(target),
    waitFor: (fn, options = {}) => __waitCondition(target, typeof fn === 'function' ? '('+fn.toString()+')()' : String(fn), typeof options === 'number' ? options : (options.timeoutMs ?? options.timeout ?? 5000)),
    // Also takes {direction, amount} or a wheel-style {deltaY}.
    scroll: async (direction = 'down', amount = 1200, element) => {
      if (direction && typeof direction === 'object') {
        var o = direction;
        direction = o.direction || ((o.deltaY ?? o.y ?? 1) < 0 ? 'up' : 'down');
        amount = o.amount ?? Math.abs(o.deltaY ?? o.y ?? 1200);
      }
      var remaining = Math.max(40, Math.round(Number(amount) || 1200)), result;
      do {
        var chunk = Math.min(1200, Math.max(40, remaining));
        result = await __step({op:'scroll', target, direction, amount: chunk, ...(element ? {element} : {})});
        remaining -= chunk;
      } while (remaining >= 40);
      return result;
    },
    scrollToEnd: async (options = {}) => {
      const page = browser.page(target);
      const maxSteps = Math.min(40, Math.max(1, options.maxSteps || 30));
      let boundaryCount = 0, stalled = 0, last;
      for (let i = 0; i < maxSteps; i++) {
        last = await page.scroll(options.direction || 'down', options.amount || 1200, options.element);
        boundaryCount = last.scroll.atBoundary ? boundaryCount + 1 : 0;
        stalled = last.scroll.moved ? 0 : stalled + 1;
        if (boundaryCount >= 2) return {reachedEnd:true, reason:'boundary', steps:i+1, scroll:last.scroll};
        if (stalled >= 3) return {reachedEnd:false, reason:'no_progress', steps:i+1, scroll:last.scroll};
      }
      return {reachedEnd:false, reason:'step_limit', steps:maxSteps, scroll:last.scroll};
    },
  }))),
});
`;
