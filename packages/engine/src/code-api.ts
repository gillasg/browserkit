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
      var result = await __step({op:'listTabs', ...(query ? {query} : {})});
      __focusedWindowId = result.focusedWindowId;
      return result.tabs.map(tab => __listedTab(__compactTab(tab)));
    },
    {list: async (query) => browser.tabs(query)}),
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
        throw Error('TARGET_LOST: tab ' + known.tabId + ' for ' + (origin || url) + ' was closed; pass {newTab: true} only if you mean to open it again');
      } finally { __busy.delete(__key(known)); }
    }
    const result = await __step({op:'openTab', clientInstanceId, url,
      foreground: options.foreground === true,
      ...(options.quiet === true ? {quiet:true} : {}),
      ...(options.present === false ? {present:false} : {}),
      ...(options.window ? {window: {width: Math.round(options.window.width ?? 1920), height: Math.round(options.window.height ?? 1080)}} : {})});
    if (!options.window) __opened.set(origin || url, result.tab.target);
    await bu.use(result.tab.target);
    if (result.navigation === 'failed') {
      console.log('[warn] tab ' + result.tab.target.tabId + ' opened, but ' + url + ' did not load: ' + (result.reason || 'navigation failed') + '; the tab is still yours (page.navigation is "failed", page.reason says why)');
    }
    return __openResult(result.tab, false, result.navigation === 'failed' ? result.reason : undefined);
  },
  // Fetch without a tab: from the extension, with the user's cookies (credentials: 'omit' to skip).
  // A failed fetch carries why it failed: kind (dns, tls, refused, reset, timeout, cors,
  // blocked-page), host, and networkBlock for a name that resolves to a block or sinkhole page.
  fetch: async (url, init = {}) => {
    try { return await __call({fetch: {...init, url: String(url)}}); }
    catch (error) { throw __fetchFailure(error); }
  },
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
  pool: (items, worker, options = {}) => __pool(items, worker, options),
  // Close every tab this chat/session opened (page.keep tabs stay), returning {closed, remaining}.
  reset: () => __call({tabs:'reset'}),
  // Many pages past the cell deadline: start a job, then check it in a later cell.
  job: __job,
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
      if (!/CLAIM_CONFLICT/.test(String(error && error.message || error)) || !url) throw error;
      console.log('That tab is in use by another chat, so this chat opened its own copy: ' + url);
      return browser.openTab(url, {newTab: true});
    }
  },
  page: (target) => (__lastTarget = target, Object.freeze(__extendPage(target, {
    target,
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
    navigate: (url, options = {}) => __step({op:"navigate", target, url: __absoluteUrl(url, target),
      ...(options.present === false ? {present:false} : {})}),
    diagnostics: (clear = false) => __step({op:"diagnostics", target, clear}),
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
      if (device) {
        await page.cdp('Emulation.setDeviceMetricsOverride', {width: device.width, height: device.height, deviceScaleFactor: device.scale, mobile: true});
        await page.cdp('Emulation.setTouchEmulationEnabled', {enabled: true});
        await page.cdp('Emulation.setUserAgentOverride', {userAgent: device.userAgent});
      }
      if (options.colorScheme) await page.cdp('Emulation.setEmulatedMedia', {features: [{name: 'prefers-color-scheme', value: options.colorScheme}]});
      if (options.timezone) await page.cdp('Emulation.setTimezoneOverride', {timezoneId: options.timezone});
      if (options.locale) await page.cdp('Emulation.setLocaleOverride', {locale: options.locale});
      if (device && options.reload !== false) await page.cdp('Page.reload', {});
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
        var entries;
        try { entries = await __call({network:'list', target, ...filter}); }
        catch (error) {
          if (!/Not recording/.test(String(error && error.message))) throw error;
          await __call({network:'start', target});
          console.log('[ok] network capture started now (it was off, so nothing earlier was recorded); repeat the action or reload, then list again');
          entries = [];
        }
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
        return entries;
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
export const browserFastApi = `
var __states = new Map(), __tabs = new Map(), __seen = new Map(), __dirty = new Map(), __opened = new Map(), __busy = new Set(), __keptTabs = new Set(), __closedTabs = new Map(), __focusedWindowId, __attachedTarget, __lastTarget;
var __key = target => JSON.stringify(target);
// A bare tab id from browser.tabs() or a step line stands for that tab's full target.
// Printed tabs show what an agent reads (id, title, url, active); the rest stays usable but
// leaves printouts and JSON, so listing many tabs costs little context.
function __compactTab(tab) {
  var entry = {id: tab.target.tabId, title: tab.title, url: tab.url, active: tab.active};
  if (typeof tab.mine === 'boolean') entry.mine = tab.mine;
  for (var [key, value] of Object.entries({...tab, tabId: tab.target.tabId}))
    if (!(key in entry)) Object.defineProperty(entry, key, {value, enumerable: false});
  return entry;
}
// openTab returns a page (so page.title() and page.url() keep working) with the tab it used
// exposed as id, tab and reused; navigation is "ok", or "failed" with the page's reason.
function __openResult(tab, reused, failedReason) {
  var page = browser.page(tab.target);
  var id = tab.target.tabId;
  return new Proxy(page, {
    get: (object, key) => {
      if (key === 'id') return id;
      if (key === 'reused') return reused === true;
      if (key === 'navigation') return failedReason === undefined ? 'ok' : 'failed';
      if (key === 'reason') return failedReason;
      return object[key];
    },
  });
}
function __listedTab(entry) {
  var page;
  // Built on first use without changing the current page (browser.page sets __lastTarget).
  var asPage = () => {
    if (page) return page;
    var current = __lastTarget;
    page = browser.page(entry.target);
    __lastTarget = current;
    return page;
  };
  var plain = new Set(['then', 'toJSON', 'constructor', 'inspect']);
  return new Proxy(entry, {
    get: (object, key) => key in object || typeof key === 'symbol' || plain.has(key) ? object[key] : asPage()[key],
  });
}
async function __tabTarget(target) {
  // A tab id, a tab from browser.tabs(), a page, or a target itself.
  if (target && typeof target === 'object' && target.target) return target.target;
  if (typeof target !== 'number') return target;
  if (__closedTabs.has(target)) {
    var closed = __closedTabs.get(target);
    throw Error('CLOSED_BY_YOU: tab ' + target + (closed.url ? ' (' + closed.url + ')' : '') + ' was closed by you');
  }
  var find = () => [...__tabs.values()].find(tab => tab.target.tabId === target);
  var tab = find() || (await browser.tabs(), find());
  if (!tab) throw Error('TARGET_LOST: tab ' + target + ' is not open (closed, or never opened); browser.tabs() lists live tabs');
  return tab.target;
}
function __clamp(value, min, max) { return Math.min(max, Math.max(min, Math.round(Number(value)) || min)); }
function __sleep(ms) { return new Promise((done) => setTimeout(done, Math.min(30000, Math.max(0, Number(ms) || 0)))); }
// A browser.fetch failure that named its kind and host (see native-browser-fetch): the message
// stays readable and kind, host and networkBlock are fields an agent can branch on.
function __fetchFailure(error) {
  var text = String(error && error.message || error);
  var found = /\\[fetch kind=([a-z-]+) host=([^ \\]]*)([^\\]]*)\\]/.exec(text);
  if (!found) return error;
  var fields = {};
  for (var pair of found[3].trim().split(/\\s+/)) {
    var at = pair.indexOf('=');
    if (at > 0) fields[pair.slice(0, at)] = pair.slice(at + 1);
  }
  var failure = Error(text.replace(found[0], '').trim());
  failure.kind = found[1];
  failure.host = found[2];
  if (fields.networkBlock) failure.networkBlock = fields.networkBlock === 'true';
  if (fields.detail) failure.detail = fields.detail;
  return failure;
}
function __absoluteUrl(url, target) {
  url = String(url);
  try { return new URL(url).href; } catch {}
  var base = __tabs.get(__key(target))?.url;
  try { return new URL(url, base).href; } catch { return url; }
}
// Playwright-style timeouts longer than the engine's cap keep polling in capped steps until the deadline.
async function __untilDeadline(totalMs, run) {
  var deadline = Date.now() + Math.min(120000, Math.max(100, Number(totalMs) || 5000)), last;
  do {
    var chunk = Math.min(8000, Math.max(100, deadline - Date.now()));
    try { return await run(chunk); }
    catch (error) { if (!/TIMEOUT/.test(String(error && error.message))) throw error; last = error; }
  } while (Date.now() < deadline - 100);
  throw last;
}
function __waitSelector(target, selector, options) {
  if (typeof options === 'number') options = {timeout: options};
  else if (typeof options === 'string') options = {state: options};
  var state = {detached: 'hidden', attached: 'attached', visible: 'visible', hidden: 'hidden', editable: 'editable'}[options.state] || 'visible';
  return __untilDeadline(options.timeoutMs ?? options.timeout ?? 5000, (timeoutMs) => __step({op:'wait', target, selector: String(selector), state, timeoutMs}));
}
function __waitCondition(target, expression, timeout) {
  return __untilDeadline(timeout, (timeoutMs) => __step({op:'waitFor', target, expression, timeoutMs}));
}
function __beginCell() { __dirty.clear(); __hasDelivered=false; __deliveryValue=undefined; }
async function __step(step, readOnly = false) {
  if (step.target && __closedTabs.has(step.target.tabId)) {
    var closed = __closedTabs.get(step.target.tabId);
    var note = 'closed by you (tab ' + step.target.tabId + (closed.url ? ', ' + closed.url : '') + ')';
    console.log('[closed] ' + note + '; no ' + step.op + ' ran');
    return {kind:'closed', target:step.target, url:closed.url, note};
  }
  if (step.target) __lastTarget = step.target;
  var action = ['click','fill','press','scroll','navigate','evaluate','cdp','upload','pointer','keys','reconnect'].includes(step.op);
  if(step.op==='frames' && ['click','fill','cdp'].includes(step.action))action=true;
  if (readOnly) action=false;
  var wasDirty = step.target && __dirty.has(__key(step.target));
  if (action) __dirty.set(__key(step.target), step.target);
  if (step.target) await __learnOn(step.target, action ? step : undefined);
  var before = step.target && __tabs.get(__key(step.target))?.url;
  var result = await __call(step);
  // An evaluate that only read the page leaves it clean: no final observation, no log line.
  if (step.op === 'evaluate' && result.data && result.data.changed === false) {
    if (!wasDirty) __dirty.delete(__key(step.target));
    action = false;
  }
  if (result.url && step.target && __tabs.has(__key(step.target))) __tabs.set(__key(step.target), {...__tabs.get(__key(step.target)), url: result.url});
  if (result.kind === 'tab') { __lastTarget = result.tab.target; __tabs.set(__key(__lastTarget),result.tab); await __learnOn(__lastTarget); }
  if (result.kind === 'tabs') for (var tab of result.tabs) __tabs.set(__key(tab.target),tab);
  var observation = result.kind === 'semantic' ? result : result.observation;
  if (observation) {
    __states.set(__key(step.target), observation);
    __dirty.delete(__key(step.target));
  }
  if (action) {
    var moved = before && result.url && before.split('#')[0] !== result.url.split('#')[0] && ['click','fill','press'].includes(step.op);
    console.log('[ok] ' + step.op + (result.outcome ? ' ' + result.outcome : '') + (result.url ? ' -> ' + result.url : '') + (moved ? ' (page changed from ' + before + ')' : '') +
      (result.data && result.data.settle ? ' (' + result.data.settle.why + ')' : '') + (result.note ? ' - ' + result.note : ''));
  }
  return result;
}
function __element(target, element) {
  if (element && typeof element === 'object' && !element.kind) {
    if (typeof element.text === 'string') return {kind:'query',by:'text',value:element.text};
    if (typeof element.ref === 'string' && typeof element.snapshotId === 'string') return {kind:'ref',ref:element.ref,snapshotId:element.snapshotId};
    throw Error('INVALID_ELEMENT: use page.getByText(text).click(), page.locator(css).click(), an observed id, or a target with kind');
  }
  if (typeof element !== 'number' && typeof element !== 'string') return element;
  // A string that is not an observed id is a CSS selector, as in Playwright's page.click(selector).
  var looksLikeId = typeof element === 'number' || /^(\\d+|e\\d+|[a-z]\\d+)$/i.test(element);
  if (!looksLikeId) return {kind:'query',by:'css',value:element};
  var state = __states.get(__key(target));
  if (!state) throw Error('Observe this page with bu.state() before using an id');
  var node = state.nodes.find(n => n.backendNodeId === element || n.ref === element || (typeof element === "string" && n.backendNodeId === Number(element)));
  if (!node) throw Error('STALE_REF: id absent from the latest state; observe again');
  return node.backendNodeId ? {kind:'backend',backendNodeId:node.backendNodeId,documentEpoch:state.documentEpoch}
    : {kind:'ref',snapshotId:state.snapshotId,ref:node.ref};
}
// Many controls with the same role and name (YouTube's 40 "Action menu" buttons) print as one
// line with all their ids, instead of 40 near-identical lines.
function __repeats(nodes) {
  var groups = new Map();
  for (var n of nodes) {
    if (['heading','statictext','paragraph'].includes(n.role.toLowerCase()) || n.value !== undefined) continue;
    var group = n.role + '|' + n.name;
    groups.set(group, (groups.get(group) || []).concat([n.backendNodeId || n.ref]));
  }
  return new Map([...groups].filter(([, ids]) => ids.length > 4));
}
// delta: the observation that ends a cell. On the same document it prints only what changed.
function __formatState(state, max = 3000, delta = false) {
  var key = __key(state.target) + ':' + state.documentEpoch;
  var previous = __seen.get(key) || new Map(), next = new Map();
  var lines = [state.url], repeats = __repeats(state.nodes), printed = new Set(), unchanged = 0;
  delta = delta && previous.size > 0;
  for (var n of state.nodes) {
    if (n.role.toLowerCase() === 'heading') {lines.push('## '+n.name);continue;}
    if (['statictext','paragraph'].includes(n.role.toLowerCase())) {lines.push(n.name);continue;}
    var text = (n.backendNodeId ? '[' + n.backendNodeId + '] ' : '[' + n.ref + '] ') + n.role + ' ' + JSON.stringify(n.name);
    if (n.value !== undefined) text += ' = ' + JSON.stringify(n.value);
    for (var prop of ['disabled','checked','focused','expanded','selected','pressed','mixed'])
      if (n[prop] !== undefined) text += ' ' + prop + '=' + n[prop];
    var id = n.backendNodeId || n.ref;
    var changed = previous.size && previous.get(id) !== text;
    next.set(id,text);
    var group = repeats.get(n.role + '|' + n.name);
    if (group && !changed) {
      if (printed.has(group)) continue;
      printed.add(group);
      text = '[' + group.join(',') + '] ' + n.role + ' ' + JSON.stringify(n.name) + ' x' + group.length;
    }
    if (delta && !changed) { unchanged++; continue; }
    if (changed) text = '* ' + text;
    lines.push(text);
  }
  if (delta) {
    lines.push(unchanged ? '[' + unchanged + ' unchanged lines hidden; bu.state() shows the whole page]' : '');
    __seen.set(key,next);
    var short = lines.filter(Boolean).join('\\n');
    return short.length > max ? short.slice(0, max) + '\\n[... clipped; bu.state() for more]' : short;
  }
  __seen.set(key,next);
  while (__seen.size > 32) __seen.delete(__seen.keys().next().value);
  if (state.text) {
    var labels = new Set(state.nodes.map(n=>n.name));
    lines.push(state.text.split('\\n').filter(line=>!labels.has(line)).join('\\n'));
  }
  if (state.truncated) lines.push('[observation truncated; use a focused snapshot or page.evaluate]');
  var text = lines.join('\\n');
  max = Math.min(30000, Math.max(500, max));
  if (text.length > max) text = text.slice(0, Math.floor(max * .8)) + '\\n[... clipped; bu.state({max:30000}) for more]\\n' + text.slice(-Math.floor(max * .2));
  return text;
}
// Until a tab exists, page.goto(url) opens the chat's working tab; other calls explain what to do.
function __lazyPage() {
  return new Proxy({}, {get: (_, key) => typeof key === 'symbol' || key === 'then' ? undefined : async (...args) => {
    if (key === 'goto' || key === 'navigate') {
      var tab = await browser.openTab(String(args[0]));
      return {opened: true, url: String(await tab.url())};
    }
    throw Error('No page is open yet: start with await page.goto(url) (or browser.openTab(url)).');
  }});
}
Object.defineProperty(globalThis,'page',{value:__lazyPage(),writable:true,configurable:true});
var __progressAt = 0;
var bu = Object.freeze({
  // Long jobs run in one cell and report as they go: bu.progress(47, 77, 'Removing') shows
  // "Removing 47/77" to the user while the cell runs. At most a few updates a second are sent.
  progress: (done, total, label) => {
    var now = Date.now();
    if (now - __progressAt < 400 && done !== total && done !== 0) return;
    __progressAt = now;
    __call({progress: {done: Number(done), total: total == null ? undefined : Number(total), label: label == null ? undefined : String(label)}}).catch(() => {});
  },
  use: target => {
    if (typeof target === 'number') return __tabTarget(target).then(bu.use);
    if (!target || typeof target !== 'object') throw Error('TARGET_LOST: bu.use needs a tab from browser.tabs(), a tab id, or a target');
    var entry = __tabs.get(__key(target));
    if (!entry && __attachedTarget && __key(target) === __key(__attachedTarget))
      entry = {target, url:'', title:''};
    if (!entry) throw Error('TARGET_LOST: tab ' + (target.tabId ?? target.target?.tabId ?? '?') + ' is not open; browser.tabs() lists live tabs, browser.attachTab(tab) attaches one');
    __lastTarget = target; globalThis.page = browser.page(target); return globalThis.page;
  },
  state: async (options = {}) => {
    var target = options.target || __lastTarget;
    if (!target) throw Error('Use bu.use(attachedTarget) or browser.page(target) first');
    var {final, ...snapshot} = options;
    var state = await browser.page(target).snapshot(snapshot);
    var text = __formatState(state, options.max, final);
    var loaded = await __autoLoadSkills(state.url);
    if (loaded) text = loaded + '\\n' + text;
    var here = await __here(target, state.url);
    if (here) text = here + String.fromCharCode(10) + text;
    var challenge = await __challengeNote(target, state.url);
    if (challenge) text = challenge + String.fromCharCode(10) + text;
    console.log(text);
    return text;
  },
  click: (id) => browser.page(__lastTarget).click(__element(__lastTarget, id)),
  type: async (id, text, options = {}) => {
    var target = __lastTarget;
    var element = __element(target, id);
    var result = await browser.page(target).fill(element, text);
    if (options.enter) result = await browser.page(target).press(element, 'Enter', {focus:false});
    return result;
  },
  handoff: async (message, options = {}) => {
    var target = options.target || __lastTarget;
    if (!target) throw Error('Use bu.use(attachedTarget) or browser.page(target) first');
    __handedOff = true;
    var outcome = await __call({handoff: {message: String(message).slice(0, 500), target}});
    __states.delete(__key(target));
    if (outcome === 'cancelled') throw Error('HANDOFF_CANCELLED: the user cancelled the hand-off');
    return 'done';
  },
  signIn: async (options = {}) => {
    var target = options.target || __lastTarget;
    if (!target) throw Error('Use bu.use(attachedTarget) or browser.page(target) first');
    var result = await __call({signIn: {target, ...(options.account ? {account: String(options.account)} : {})}});
    __states.delete(__key(target));
    return result;
  },
});
// Draws each interactive bu id on the page, captures, then removes the overlay.
async function __labeledScreenshot(target) {
  if (!__states.get(__key(target))) await browser.page(target).snapshot({});
  var state = __states.get(__key(target));
  var skip = ['heading','statictext','paragraph','generic','none'];
  var labels = [];
  for (var n of state.nodes) {
    if (!n.backendNodeId || skip.includes(n.role.toLowerCase()) || labels.length >= 120) continue;
    try {
      var box = (await __call({op:'cdp',target,method:'DOM.getBoxModel',params:{backendNodeId:n.backendNodeId}})).data.value.model.border;
      labels.push([n.backendNodeId, Math.min(box[0],box[6]), Math.min(box[1],box[3])]);
    } catch {}
  }
  var draw = '(()=>{var h=document.createElement("div");h.id="aeon-labels";h.setAttribute("data-aeon-overlay","");h.setAttribute("aria-hidden","true");h.style.cssText="position:fixed;inset:0;z-index:2147483646;pointer-events:none";for(var [id,x,y] of '+JSON.stringify(labels)+'){var b=document.createElement("b");b.textContent=id;b.style.cssText="position:fixed;left:"+Math.max(0,x)+"px;top:"+Math.max(0,y-14)+"px;font:600 11px/14px system-ui;padding:0 3px;background:#4f46e5;color:#fff;border-radius:3px;box-shadow:0 0 0 1px #fff";h.append(b)}document.documentElement.append(h)})()';
  await __call({op:'evaluate',target,expression:draw});
  try { return await __step({op:'observe', target, kind:'screenshot'}); }
  finally { await __call({op:'evaluate',target,expression:'document.getElementById("aeon-labels")?.remove()'}).catch(()=>{}); }
}
var __probeCache = new Map();
async function __fastProbe(target, url) {
  var key = __key(target) + '|' + String(url);
  var cached = __probeCache.get(key);
  if (cached && Date.now() - cached.at < 30000) return cached.text;
  var text = '';
  try {
    var data = await browser.page(target).data({summary: true});
    var sources = data && data.sources ? Object.keys(data.sources) : [];
    if (sources.length) {
      var parts = sources.slice(0, 4).map(function (name) {
        var value = data.sources[name] || {};
        return value.items != null ? name + ' ' + value.items + ' items' : name;
      });
      text = 'page.data() ' + parts.join(' · ');
      if (data.urlParams && data.urlParams.length) text += ' · url ' + data.urlParams.slice(0, 8).join(',');
    }
  } catch {}
  __probeCache.set(key, {at: Date.now(), text: text});
  return text;
}
async function __finishCell() {
  for (var target of [...__dirty.values()]) {
    try { await bu.state({target, final: true}); }
    catch (error) { if (!/UNSUPPORTED/.test(String(error && error.message))) console.log('Final observation unavailable: ' + error.message); }
  }
  __dirty.clear();
  await __wallNote();
  await __learnFromCell();
  await __saveReads();
}
`;
export const browserCapabilityApi = `
function __event(target, event, options = {}) {
  var started = __call({op:'event',target,action:'subscribe',event,...(options.frameId ? {frameId:options.frameId,frameKey:options.frameKey} : {})});
  var id, ready = started.then(result=>{id=result.data.subscriptionId;return id;});
  var cancelled = false, consumed;
  async function dispose() {cancelled=true;await ready;return __call({op:'event',target,action:'dispose',subscriptionId:id});}
  async function consume() {
    await ready;
    var deadline=Date.now()+(options.timeoutMs ?? 10000);
    try {
      while(!cancelled && Date.now()<deadline) {
        var result=await __call({op:'event',target,action:'poll',subscriptionId:id,timeoutMs:Math.min(1000,deadline-Date.now())});
        if(result.data.dropped)console.warn('Event buffer dropped '+result.data.dropped+' entries; narrow the event and verify the outcome');
        for(var item of result.data.events) if(!options.predicate || options.predicate(item.params)) return item;
      }
      throw Error(cancelled ? 'Event subscription disposed' : 'TIMEOUT: browser event not observed');
    } finally {await dispose().catch(()=>{});}
  }
  return Object.freeze({ready,dispose,then:(resolve,reject)=>(consumed??=consume()).then(resolve,reject)});
}
function __framePage(target, info) {
  var scoped={frameId:info.frameId,frameKey:info.frameKey};
  var call=async(action,fields={})=>(await __step({op:'frames',target,action,...scoped,...fields})).data;
  return Object.freeze({...info,
    evaluate:(fn,arg)=>call('evaluate',{expression:__expression(fn,arg)}),
    cdp:(method,params={})=>call('cdp',{method,params}),
    snapshot:()=>call('snapshot'),
    click:element=>call('click',typeof element==='number'?{backendNodeId:element}:{selector:element}),
    fill:(element,value)=>call('fill',{...(typeof element==='number'?{backendNodeId:element}:{selector:element}),value}),
    locator:selector=>Object.freeze({click:()=>call('click',{selector}),fill:value=>call('fill',{selector,value})}),
    getByRole:(role,options={})=>Object.freeze({click:async()=>{var state=await call('snapshot');var nodes=state.nodes.filter(n=>n.role===role && (options.name===undefined || n.name===options.name));if(nodes.length!==1)throw Error('Expected exactly one frame control');return call('click',{backendNodeId:nodes[0].backendNodeId});},fill:async value=>{var state=await call('snapshot');var nodes=state.nodes.filter(n=>n.role===role && (options.name===undefined || n.name===options.name));if(nodes.length!==1)throw Error('Expected exactly one frame control');return call('fill',{backendNodeId:nodes[0].backendNodeId,value});}}),
    upload:(selector,files)=>__step({op:'upload',target,selector,files,...scoped}),
    press:(keys)=>__step({op:'keys',target,keys,...scoped}),
    waitForEvent:(event,options={})=>__event(target,event,{...options,...scoped}),
  });
}
function __expression(fn,arg) {return typeof fn==='function' ? '('+fn.toString()+')('+(JSON.stringify(arg) ?? '')+')' : fn;}
// Written in 1M-character pieces (whole base64 quads, whole surrogate pairs), so a large file
// never becomes one oversized message.
async function artifact(name,data) {
  if (typeof Blob!=='undefined' && data instanceof Blob) data=new Uint8Array(await data.arrayBuffer());
  // Anything that isn't bytes (objects, arrays of rows) is saved as JSON.
  else if (data && typeof data==='object' && !ArrayBuffer.isView(data) && !(data instanceof ArrayBuffer) && !(Array.isArray(data) && data.every(n=>typeof n==='number'))) data=JSON.stringify(data,null,2);
  var base64=typeof data!=='string', value=base64?__encodeBytes(data):data, size=1000000, at=0, result;
  do {
    var end=Math.min(value.length,at+size);
    var last=value.charCodeAt(end-1);
    if(!base64 && end<value.length && last>=0xD800 && last<=0xDBFF) end--;
    result=await __call({workspace:at?'append':'artifact',name,value:value.slice(at,end),base64});
    at=end;
  } while(at<value.length);
  return {...result,bytes:base64?Math.floor(value.length*3/4)-(value.endsWith('==')?2:value.endsWith('=')?1:0):new TextEncoder().encode(value).length};
}
var checkpoint=(name,value)=>__call({workspace:'checkpoint',name,value});
var loadCheckpoint=name=>__call({workspace:'load',name});
var saveHelper=(name,fn)=>__call({workspace:'helper',name,value:typeof fn==='function'?'('+fn.toString()+')':fn});
var loadHelper=async name=>eval(await __call({workspace:'loadHelper',name}));
var showImage=async name=>{await __call({workspace:'image',name});return {displayed:true,path:name};};
var __hasDelivered=false,__deliveryValue;
var finish_from_js=({expression})=>{__deliveryValue=eval(expression);__hasDelivered=true;return {delivered:true};};
var reconnect=()=>browser.page(__lastTarget).reconnect();
`;
export const browserDocumentApi = `
async function __readPdfText(options = {}) {
  var root=window;
  if(options.selector) {
    var selected=document.querySelector(options.selector);
    if(!selected)throw Error('PDF_TEXT_UNAVAILABLE: viewer selector was not found');
    root=selected.contentWindow || window;
  }
  var queue=[root],seen=new Set(),documents=[],layers=[];
  while(queue.length && seen.size<64) {
    var w=queue.shift(); if(seen.has(w))continue; seen.add(w);
    try {
      var d=w.document;
      var pdf=w.PDFViewerApplication?.pdfDocument;
      if(!pdf && w.PDFVar?._transport?.loadingTask?.promise) pdf=await w.PDFVar._transport.loadingTask.promise;
      if(pdf && typeof pdf.getPage==='function')documents.push({pdf,url:w.location.href});
      else {
        var rendered=[...d.querySelectorAll('.textLayer')].map(e=>e.innerText || e.textContent || '').filter(Boolean);
        if(rendered.length)layers.push({url:w.location.href,pages:rendered});
      }
      for(var f of d.querySelectorAll('iframe,frame'))if(f.contentWindow)queue.push(f.contentWindow);
    } catch(error) { if(!/SecurityError|cross-origin|Blocked a frame/i.test(String(error)))throw error; }
  }
  if(documents.length>1)throw Error('AMBIGUOUS_PDF: choose a viewer iframe with {selector}');
  if(!documents.length) {
    if(layers.length===1)return {source:'rendered-text',url:layers[0].url,pages:layers[0].pages.map((text,i)=>({page:i+1,text})),partial:true,warning:'Only rendered text layers were available; page numbers may not match the document. Use screenshots for missing pages.'};
    throw Error('PDF_TEXT_UNAVAILABLE: no readable PDF.js document found. Use frame handles for cross-origin content or screenshots for image-only PDFs.');
  }
  var viewer=documents[0],total=viewer.pdf.numPages;
  var from=Math.max(1,options.from || 1),to=Math.min(total,options.to || total,from+99);
  var budget=Math.min(800000,Math.max(1000,options.maxChars || 200000)),pages=[],clipped=false;
  for(var i=from;i<=to;i++) {
    var content=await (await viewer.pdf.getPage(i)).getTextContent();
    var text=content.items.map(item=>item.str+(item.hasEOL?'\\n':' ')).join('').trim();
    var take=text.slice(0,budget);pages.push({page:i,text:take,truncated:take.length!==text.length});budget-=take.length;
    if(take.length!==text.length || budget<=0){clipped=i<total || take.length!==text.length;break;}
  }
  return {source:'pdfjs',url:viewer.url,totalPages:total,pages,partial:clipped || from!==1 || to!==total,
    ...(pages.every(p=>!p.text)?{warning:'No text extracted; this may be an image-only PDF. Use screenshots.'}:{})};
}
`;
