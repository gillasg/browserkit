// The page object and the browser surface around it: tabs, navigation, rules, network,
// readiness, sessions and emulation. Evaluated in the same sandbox realm as code-api.ts.
import { locatorShorthandSource } from "./locator-shorthand.js";
export const browserFastApi = `
${locatorShorthandSource}
var __states = new Map(), __tabs = new Map(), __seen = new Map(), __dirty = new Map(), __opened = new Map(), __busy = new Set(), __keptTabs = new Set(), __closedTabs = new Map(), __focusedWindowId, __attachedTarget, __lastTarget;
var __labels = new Map();
var __key = target => JSON.stringify(target);
// The last navigation failure per tab: page.lastError = { code, url, stage, message, at }.
var __lastErrors = new Map();
function __noteNavError(target, url, stage, error) {
  var message = String(error && error.message || error);
  __lastErrors.set(__key(target), { code: message.split(':')[0] || 'NAVIGATION_FAILED', url: String(url || ''), stage, message, at: new Date().toISOString() });
}
// A bare tab id from browser.tabs() or a step line stands for that tab's full target.
// Printed tabs show what an agent reads (id, title, url, active); the rest stays usable but
// leaves printouts and JSON, so listing many tabs costs little context.
function __compactTab(tab) {
  var entry = {id: tab.target.tabId, title: tab.title, url: tab.url, active: tab.active};
  if (typeof tab.mine === 'boolean') entry.mine = tab.mine;
  if (typeof tab.label === 'string') entry.label = tab.label;
  if (typeof tab.control === 'string') entry.control = tab.control;
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
// A label (p2) stands for a tab whose id may have changed; the engine re-binds it by URL.
async function __labelTarget(label) {
  var known = __labels.get(label);
  if (known && __tabs.get(__key(known))) return known;
  var found = (await __step({op:'session', target: __hostTarget(), action:'resolve', label: String(label)})).data;
  __labels.set(found.label || String(label), found.tab.target);
  __tabs.set(__key(found.tab.target), found.tab);
  return found.tab.target;
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
// Page-side helpers (recording, media) run in an isolated world: the page cannot see their
// variables, and they still see the page's DOM and events. One context per tab, remade after a
// navigation drops it.
var __worlds = new Map();
async function __isolatedEval(target, expression) {
  var key = __key(target);
  for (var attempt = 0; ; attempt++) {
    var contextId = __worlds.get(key);
    if (!contextId) {
      var tree = (await __step({op:'cdp', target, method:'Page.getFrameTree', params:{}}, true)).data.value;
      var frame = tree && tree.frameTree && tree.frameTree.frame;
      if (!frame || !frame.id) throw Error('NO_FRAME');
      var made = (await __step({op:'cdp', target, method:'Page.createIsolatedWorld', params:{frameId: frame.id, worldName: 'browserkit-helper'}}, true)).data.value;
      contextId = made && made.executionContextId;
      if (!contextId) throw Error('NO_CONTEXT');
      __worlds.set(key, contextId);
    }
    try {
      var reply = (await __step({op:'cdp', target, method:'Runtime.evaluate', params:{expression, contextId, returnByValue:true, awaitPromise:true}}, true)).data.value;
      if (reply && reply.exceptionDetails)
        throw Error(reply.exceptionDetails.exception && reply.exceptionDetails.exception.description || reply.exceptionDetails.text || 'HELPER_FAILED');
      return reply && reply.result ? reply.result.value : undefined;
    } catch (error) {
      __worlds.delete(key);
      if (attempt >= 1 || !/context|Cannot find/i.test(String(error && error.message || error))) throw error;
    }
  }
}
// What the page itself can check about being driven. Never patches anything: it only reads.
function __stealthProbe() {
  var globals = Object.getOwnPropertyNames(window).filter((name) => /^(__aeon|__browserkit|browserkit-)/.test(name));
  var overlays = [...document.querySelectorAll('[id^="aeon-"],[id^="browserkit-"],[data-aeon-overlay],[data-browserkit-overlay]')].map((node) => node.id ? '#' + node.id : node.tagName.toLowerCase());
  var wrapped = [], leaks = [];
  var native = /\\{\\s*\\[native code\\]\\s*\\}/;
  var functions = [['window.open', window.open], ['window.confirm', window.confirm], ['window.prompt', window.prompt], ['window.alert', window.alert], ['HTMLMediaElement.play', HTMLMediaElement.prototype.play]];
  for (var pair of functions) {
    var fn = pair[1];
    if (typeof fn !== 'function') continue;
    if (!native.test(Function.prototype.toString.call(fn))) wrapped.push(pair[0]);
    if (Object.getOwnPropertyNames(fn).includes('toString')) leaks.push(pair[0] + ' has its own toString');
    for (var sym of Object.getOwnPropertySymbols(fn)) leaks.push(pair[0] + ' has ' + String(sym));
  }
  for (var symbol of Object.getOwnPropertySymbols(window)) {
    var name = Symbol.keyFor(symbol) || String(symbol);
    if (/browserkit|aeon/i.test(name)) leaks.push('window has ' + name);
  }
  var geolocationShim = false;
  try { geolocationShim = !native.test(Function.prototype.toString.call(navigator.geolocation.getCurrentPosition)); } catch {}
  return {webdriver: navigator.webdriver === true, globals, overlays, wrapped, geolocationShim, leaks};
}
function __beginCell() { __dirty.clear(); __hasDelivered=false; __deliveryValue=undefined; }
async function __step(step, readOnly = false) {
  var startedAt = Date.now();
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
  if (result.kind === 'tab') { __lastTarget = result.tab.target; __tabs.set(__key(__lastTarget),result.tab); if (result.tab.label) __labels.set(result.tab.label, result.tab.target); await __learnOn(__lastTarget); }
  if (result.kind === 'tabs') for (var tab of result.tabs) { __tabs.set(__key(tab.target),tab); if (tab.label) __labels.set(tab.label, tab.target); }
  var observation = result.kind === 'semantic' ? result : result.observation;
  if (observation) {
    __states.set(__key(step.target), observation);
    __dirty.delete(__key(step.target));
  }
  if (action) {
    var moved = before && result.url && before.split('#')[0] !== result.url.split('#')[0] && ['click','fill','press'].includes(step.op);
    console.log('[ok] ' + step.op + (result.outcome ? ' ' + result.outcome : '') + (result.url ? ' -> ' + result.url : '') + (moved ? ' (page changed from ' + before + ')' : '') +
      (result.data && result.data.settle ? ' (' + result.data.settle.why + ')' : '') + ' ' + (Date.now() - startedAt) + ' ms' + (result.note ? ' - ' + result.note : ''));
  }
  if (action && step.op !== 'observe' && step.target) { try { await __autoAfter(step.target, step); } catch {} }
  return result;
}
function __element(target, element) {
  if (element && typeof element === 'object' && !element.kind) {
    if (typeof element.text === 'string') return {kind:'query',by:'text',value:element.text};
    if (typeof element.ref === 'string' && typeof element.snapshotId === 'string') return {kind:'ref',ref:element.ref,snapshotId:element.snapshotId};
    throw Error('INVALID_ELEMENT: use page.getByText(text).click(), page.locator(css).click(), an observed id, or a target with kind');
  }
  if (typeof element !== 'number' && typeof element !== 'string') return element;
  // A string that is not an observed id is a locator shorthand or CSS selector.
  var looksLikeId = typeof element === 'number' || /^(\\d+|e\\d+|f\\d+:e\\d+|[a-z]\\d+)$/i.test(element);
  if (!looksLikeId) return __parseSelector(element).spec;
  var state = __states.get(__key(target));
  if (!state) throw Error('Observe this page with bu.state() before using an id');
  var node = state.nodes.find(n => n.backendNodeId === element || n.ref === element || (typeof element === "string" && n.backendNodeId === Number(element)));
  if (!node) throw Error('STALE_REF: id absent from the latest state; observe again');
  return node.backendNodeId && !node.frame ? {kind:'backend',backendNodeId:node.backendNodeId,documentEpoch:state.documentEpoch}
    : {kind:'ref',snapshotId:state.snapshotId,ref:node.ref};
}
// XPath and filtered shorthands cannot travel in the engine's element schema; use a page-side
// locator (the indexed path) instead.
function __locatorFor(target, element) {
  if (typeof element !== 'string') return null;
  var parsed = __parseSelector(element);
  return parsed.spec.by === 'xpath' || parsed.index !== undefined || parsed.spec.filters || parsed.spec.scopeSpec
    ? __locator(target, parsed.spec, parsed.index === undefined ? 0 : parsed.index)
    : null;
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
  if (state.diff) {
    var d = state.diff;
    return [
      state.url,
      'diff reset=' + Boolean(d.reset) + ' added=' + d.added.length + ' removed=' + d.removed.length + ' changed=' + d.changed.length + ' unchanged=' + d.unchanged,
      d.added.length ? 'added: ' + d.added.join(',') : '',
      d.removed.length ? 'removed: ' + d.removed.join(',') : '',
      d.changed.length ? 'changed: ' + d.changed.join(',') : '',
    ].filter(Boolean).join('\\n');
  }
  var key = __key(state.target) + ':' + state.documentEpoch;
  var previous = __seen.get(key) || new Map(), next = new Map();
  var lines = [state.url], repeats = __repeats(state.nodes), printed = new Set(), unchanged = 0;
  delta = delta && previous.size > 0;
  for (var n of state.nodes) {
    if (n.role.toLowerCase() === 'heading') {lines.push('## '+n.name);continue;}
    if (['statictext','paragraph'].includes(n.role.toLowerCase())) {lines.push(n.name);continue;}
    var text = (n.frame || !n.backendNodeId ? '[' + n.ref + '] ' : '[' + n.backendNodeId + '] ') + n.role + ' ' + JSON.stringify(n.name);
    if (n.value !== undefined) text += ' = ' + JSON.stringify(n.value);
    for (var prop of ['disabled','checked','focused','expanded','selected','pressed','mixed'])
      if (n[prop] !== undefined) text += ' ' + prop + '=' + n[prop];
    var id = n.frame || !n.backendNodeId ? n.ref : n.backendNodeId;
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
    if (typeof target === 'string') {
      if (!/^p\\d{1,3}$/.test(target)) throw Error('TARGET_LOST: bu.use takes a tab, a tab id or a session label (p1, p2…)');
      return __labelTarget(target).then(bu.use);
    }
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
  // {selector} points the amber cursor at the element; {start: true} registers the hand-off and
  // returns at once ({wait, cancel}), for a click that opens a prompt the page then blocks on.
  handoff: async (message, options = {}) => {
    var target = options.target || __lastTarget;
    if (!target) throw Error('Use bu.use(attachedTarget) or browser.page(target) first');
    if (options.wait === true) return __handoffUntilClear(message, target, options);
    __handedOff = true;
    var spotlight = options.selector ? await browser.page(target).locator(options.selector).boundingBox().catch(() => null) : null;
    var request = {message: String(message ?? '').slice(0, 500), target, ...(spotlight ? {spotlight} : {})};
    if (options.start) {
      await __call({handoff: {...request, start: true}});
      return Object.freeze({wait: () => bu.handoff(message, {target}), cancel: () => __call({handoff: {target, cancel: true}})});
    }
    var outcome = await __call({handoff: request});
    __states.delete(__key(target));
    if (outcome === 'cancelled') throw Error('HANDOFF_CANCELLED: the user cancelled the hand-off');
    return 'done';
  },
  // The user clicked or typed in this tab: the agent is paused until they give it back.
  control: async () => (await __step({op:'control', target, action:'status'})).data,
  waitForControl: async (options = {}) =>
    (await __step({op:'control', target, action:'wait', timeoutMs: Math.min(Number(options.timeoutMs ?? options.timeout ?? 30000) || 0, 120000)})).data,
  giveBack: async () => (await __step({op:'control', target, action:'giveback'})).data,
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
