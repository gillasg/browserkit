// Playwright-compatible names on top of the browser_code API. Models reach for Playwright by
// habit (page.title(), page.goto(), locator.innerText(), page.$$eval...), so those calls work as
// a Playwright user expects instead of failing and costing a model turn. Reads run in the page;
// actions reuse the engine's own click/fill/press so they keep its waiting and verification.
export const browserPlaywrightApi = `
// A string that can also be called, so page.url and page.url() both work.
function __callableString(read, call) {
  var fn = call || (() => read());
  return new Proxy(fn, {
    get(_, key) {
      var value = read() || '';
      if (key === Symbol.toPrimitive || key === 'toString' || key === 'valueOf' || key === 'toJSON') return () => value;
      if (key === Symbol.for('nodejs.util.inspect.custom')) return () => value;
      var member = value[key];
      return typeof member === 'function' ? member.bind(value) : member;
    },
  });
}
// A page read must not hang a model turn when the execution context is gone.
function __withTimeout(promise, ms, code) {
  var timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(code || 'PAGE_READ_TIMEOUT')), ms); }),
  ]).finally(() => clearTimeout(timer));
}
// Compare two screenshots in the page (canvas, no native dependencies) and optionally return a
// red-marked PNG. Images arrive in chunks because a single evaluate expression is capped at
// 20k characters and a screenshot is much larger. Used by page.diffScreenshot.
function __diffImageParts(options) {
  var store = window.__browserkitDiffParts || {};
  var beforeSource = (store[options.id + ':before'] || []).join('');
  var afterSource = (store[options.id + ':after'] || []).join('');
  delete store[options.id + ':before'];
  delete store[options.id + ':after'];
  if (!Object.keys(store).length) delete window.__browserkitDiffParts;
  function load(source) {
    return new Promise(function (resolve, reject) {
      var image = new Image();
      image.onload = function () { resolve(image); };
      image.onerror = function () { reject(new Error('SCREENSHOT_DECODE_FAILED')); };
      image.src = source;
    });
  }
  return (async function () {
    var before = await load(beforeSource), after = await load(afterSource);
    if (before.width !== after.width || before.height !== after.height)
      throw new Error('SCREENSHOT_SIZE_MISMATCH: ' + before.width + 'x' + before.height + ' vs ' + after.width + 'x' + after.height);
    var width = before.width, height = before.height;
    var canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    var context = canvas.getContext('2d', { willReadFrequently: true });
    context.drawImage(before, 0, 0);
    var first = context.getImageData(0, 0, width, height).data;
    context.clearRect(0, 0, width, height);
    context.drawImage(after, 0, 0);
    var second = context.getImageData(0, 0, width, height).data;
    var diff = context.createImageData(width, height), changed = 0, limit = options.threshold * 255;
    for (var i = 0; i < first.length; i += 4) {
      var delta = Math.max(Math.abs(first[i] - second[i]), Math.abs(first[i + 1] - second[i + 1]), Math.abs(first[i + 2] - second[i + 2]));
      if (delta > limit) {
        changed++;
        diff.data[i] = 255; diff.data[i + 1] = 0; diff.data[i + 2] = 0; diff.data[i + 3] = 255;
      } else {
        diff.data[i] = first[i]; diff.data[i + 1] = first[i + 1]; diff.data[i + 2] = first[i + 2]; diff.data[i + 3] = 80;
      }
    }
    var image = '';
    if (options.wantImage) {
      context.putImageData(diff, 0, 0);
      image = canvas.toDataURL('image/png');
    }
    return { matches: changed === 0, width: width, height: height, changedPixels: changed, totalPixels: width * height, changedRatio: changed / (width * height), threshold: options.threshold, image: image };
  })();
}
async function __diffPush(target, id, side, data) {
  var size = 12000;
  for (var i = 0; i < data.length; i += size) {
    var part = { key: id + ':' + side, chunk: data.slice(i, i + size) };
    await __isolatedEval(target, '(' + function (part) {
      var store = window.__browserkitDiffParts || (window.__browserkitDiffParts = {});
      (store[part.key] || (store[part.key] = [])).push(part.chunk);
    }.toString() + ')(' + JSON.stringify(part) + ')');
  }
}
async function __diffScreenshot(target, baseline, options) {
  options = options || {};
  var threshold = options.threshold === undefined ? 0.1 : Number(options.threshold);
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) throw new Error('SCREENSHOT_DIFF_THRESHOLD: use a number from 0 to 1');
  var before;
  var baselineMime = baseline && baseline.mimeType ? baseline.mimeType : 'image/jpeg';
  if (
    typeof baseline === 'string' &&
    baseline.indexOf('data:') !== 0 &&
    /\\.(png|jpe?g|webp)$/i.test(baseline)
  ) {
    var stored = await __call({ workspace: 'image', name: baseline });
    before = 'data:' + (stored.mimeType || 'image/png') + ';base64,' + stored.dataBase64;
  } else {
    before = typeof baseline === 'string' ? baseline : baseline && (baseline.dataBase64 || (baseline.data && baseline.data.dataBase64));
  }
  if (!before) throw new Error('SCREENSHOT_BASELINE_REQUIRED: pass page.screenshot(), a workspace image path, or a base64 image');
  if (before.indexOf('data:') !== 0) before = 'data:' + baselineMime + ';base64,' + before;
  var current = await __step({ op: 'observe', target: target, kind: 'screenshot' });
  var shot = current && (current.data || current);
  if (!shot || !shot.dataBase64) throw new Error('SCREENSHOT_CAPTURE_FAILED');
  var after = 'data:' + (shot.mimeType || 'image/jpeg') + ';base64,' + shot.dataBase64;
  var id = 'diff-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  await __diffPush(target, id, 'before', before);
  await __diffPush(target, id, 'after', after);
  var result;
  try {
    result = await __isolatedEval(target, '(' + __diffImageParts.toString() + ')(' + JSON.stringify({ id: id, threshold: threshold, wantImage: Boolean(options.path) }) + ')');
  } finally {
    await __isolatedEval(target, '(' + function (key) {
      var store = window.__browserkitDiffParts;
      if (!store) return;
      delete store[key + ':before'];
      delete store[key + ':after'];
      if (!Object.keys(store).length) delete window.__browserkitDiffParts;
    }.toString() + ')(' + JSON.stringify(id) + ')').catch(function () {});
  }
  if (options.path) {
    var name = String(options.path);
    if (!/\\.png$/i.test(name)) throw new Error('SCREENSHOT_DIFF_PATH: the diff output must end in .png');
    var base64 = String(result.image || '').replace(/^data:image\\/png;base64,/, '');
    if (!base64) throw new Error('SCREENSHOT_DIFF_IMAGE: the diff image was empty');
    await __call({ workspace: 'artifact', name: name, value: base64, base64: true });
    delete result.image;
    result.path = name;
  }
  return result;
}
// Resolves a locator spec to elements inside the page (runs page-side, so it must be self-contained).
function __resolveInPage(spec, within) {
  var roots = within ? [within] : spec.scopeSpec ? __resolveInPage(spec.scopeSpec) : spec.scope ? [...document.querySelectorAll(spec.scope)] : [document];
  var all = (selector) => roots.flatMap((root) => [...root.querySelectorAll(selector)]);
  var xpath = (value) => roots.flatMap((root) => {
    var result = document.evaluate(value, root, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
    return Array.from({length: result.snapshotLength}, (_, i) => result.snapshotItem(i));
  });
  var text = (el) => (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim();
  var pattern = spec.regex ? new RegExp(spec.regex[0], spec.regex[1]) : null;
  var match = (value) => pattern ? pattern.test(value) : spec.exact ? value === spec.value : value.toLowerCase().includes(String(spec.value).toLowerCase());
  var found;
  if (spec.by === 'css') found = all(spec.value);
  else if (spec.by === 'xpath') found = xpath(spec.value);
  else if (spec.by === 'text') found = all('body *').filter((el) => match(text(el)) && ![...el.children].some((child) => match(text(child))));
  else if (spec.by === 'label') found = all('input,textarea,select,[contenteditable]').filter((el) => [...(el.labels || [])].some((label) => match(text(label))) || match(el.getAttribute('aria-label') || ''));
  else if (spec.by === 'placeholder') found = all('[placeholder]').filter((el) => match(el.getAttribute('placeholder') || ''));
  else {
    var roles = {button:'button,[role=button],input[type=button],input[type=submit]', link:'a[href],[role=link]',
      textbox:'input:not([type]),input[type=text],input[type=search],input[type=email],input[type=tel],input[type=url],input[type=number],input[type=password],textarea,[role=textbox],[role=searchbox]',
      searchbox:'input[type=search],[role=searchbox]', heading:'h1,h2,h3,h4,h5,h6,[role=heading]', checkbox:'input[type=checkbox],[role=checkbox]',
      radio:'input[type=radio],[role=radio]', combobox:'select,[role=combobox]', option:'option,[role=option]', img:'img,[role=img]',
      listitem:'li,[role=listitem]', list:'ul,ol,[role=list]', row:'tr,[role=row]', cell:'td,[role=cell]', table:'table,[role=table]', tab:'[role=tab]', menuitem:'[role=menuitem]', dialog:'dialog,[role=dialog]'};
    found = all(roles[spec.role] || '[role="' + spec.role + '"]');
    var name = (el) => (el.getAttribute('aria-label') || text(el) || el.value || el.alt || el.title || '').replace(/\\s+/g, ' ').trim();
    if (pattern) found = found.filter((el) => pattern.test(name(el)));
    else if (spec.name) found = found.filter((el) => spec.exact ? name(el) === spec.name : name(el).toLowerCase().includes(spec.name.toLowerCase()));
  }
  var textMatch = (el, wanted) => Array.isArray(wanted) ? new RegExp(wanted[0], wanted[1]).test(text(el)) : text(el).toLowerCase().includes(String(wanted).toLowerCase());
  for (var filter of spec.filters || []) {
    if (filter.hasText !== undefined) found = found.filter((el) => textMatch(el, filter.hasText));
    if (filter.hasNotText !== undefined) found = found.filter((el) => !textMatch(el, filter.hasNotText));
    if (filter.has) found = found.filter((el) => __resolveInPage(filter.has, el).length > 0);
    if (filter.hasNot) found = found.filter((el) => __resolveInPage(filter.hasNot, el).length === 0);
    if (filter.and) { var both = __resolveInPage(filter.and, within); found = found.filter((el) => both.includes(el)); }
    if (filter.or) {
      var either = __resolveInPage(filter.or, within);
      found = [...new Set([...found, ...either])].sort((a, b) => a === b ? 0 : a.compareDocumentPosition(b) & 4 ? -1 : 1);
    }
  }
  if (Number.isInteger(spec.index)) found = spec.index < 0 ? found.slice(spec.index).slice(0, 1) : found.slice(spec.index, spec.index + 1);
  return found;
}
function __spec(element) {
  if (element.kind === 'locator') return {role: element.role, name: element.name, exact: element.exact, scope: element.scope, scopeSpec: element.scopeSpec, filters: element.filters, regex: element.regex, index: element.index};
  return {by: element.by, value: element.value, exact: element.exact, scope: element.scope, scopeSpec: element.scopeSpec, filters: element.filters, regex: element.regex, index: element.index};
}
// Runs a read on the matched elements in the page: op receives (elements, arg). The expression is
// assembled as source, not eval'd in the page, so strict Content-Security-Policy pages allow it.
function __locatorRead(target, element, index, op, arg) {
  var expression = '(() => { var found = (' + __resolveInPage.toString() + ')(' + JSON.stringify(__spec(element)) + ');' +
    (index === undefined ? '' : ' var index = ' + Number(index) + '; found = index < 0 ? found.slice(index).slice(0, 1) : found.slice(index, index + 1);') +
    ' return (' + op.toString() + ')(found, ' + (arg === undefined ? 'undefined' : JSON.stringify(arg)) + '); })()';
  return browser.page(target).inspect(expression);
}
// An indexed locator (nth/first/last) cannot use the engine's unique-match targeting, so it is
// clicked at the element's centre after scrolling it into view.
async function __clickIndexed(target, element, index, options) {
  var box = await __locatorRead(target, element, index, (found) => {
    var el = found[0];
    if (!el) throw new Error('TARGET_NOT_FOUND: no element matches');
    el.scrollIntoView({block: 'center', inline: 'center'});
    var rect = el.getBoundingClientRect();
    return {x: rect.left + rect.width / 2, y: rect.top + rect.height / 2};
  });
  var page = browser.page(target);
  return options && options.clickCount === 2 ? page.doubleClickAt(box.x, box.y) : page.clickAt(box.x, box.y);
}
var __mouseAt = new Map();
function __extendLocator(target, element, base, index) {
  var self = () => __locator(target, element, index);
  var read = (op, arg) => __locatorRead(target, element, index, op, arg);
  // Filtered and regex locators resolve in the page, so actions on them click the element at its index (first by default).
  var indexed = index !== undefined || Boolean(element.filters || element.regex);
  var at0 = index === undefined ? 0 : index;
  var at = (i) => __locator(target, element, i);
  return Object.assign(base, {
    first: () => at(0), last: () => at(-1), nth: (i) => at(i),
    all: async () => Array.from({length: await read((found) => found.length)}, (_, i) => at(i)),
    count: () => read((found) => found.length),
    filter: (options = {}) => __locator(target, __withOptions(element, options), index),
    and: (other) => __locator(target, __withFilter(element, {and: __spec(other.element)}), index),
    or: (other) => __locator(target, __withFilter(element, {or: __spec(other.element)}), index),
    innerText: () => read((found) => found.length ? found[0].innerText : (() => { throw new Error('TARGET_NOT_FOUND: no element matches'); })()),
    textContent: () => read((found) => found.length ? found[0].textContent : null),
    innerHTML: () => read((found) => found.length ? found[0].innerHTML : ''),
    inputValue: () => read((found) => found.length ? found[0].value : ''),
    getAttribute: (name) => read((found, name) => found.length ? found[0].getAttribute(name) : null, name),
    isVisible: () => read((found) => found.some((el) => { var r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden'; })),
    isChecked: () => read((found) => Boolean(found[0] && found[0].checked)),
    allInnerTexts: () => read((found) => found.map((el) => el.innerText)),
    allTextContents: () => read((found) => found.map((el) => el.textContent || '')),
    evaluate: (fn, arg) => read('(found, arg) => (' + fn.toString() + ')(found[0], arg)', arg),
    evaluateAll: (fn, arg) => read('(found, arg) => (' + fn.toString() + ')(found, arg)', arg),
    waitFor: (options = {}) => __waitUntil(() => read((found) => found.length), options.timeout ?? 10000),
    ...(indexed ? {
      click: (options) => __clickIndexed(target, element, at0, options),
      dblclick: () => __clickIndexed(target, element, at0, {clickCount: 2}),
      fill: async (value) => { await __clickIndexed(target, element, at0); await browser.page(target).keyboard('ControlOrMeta+a'); return browser.page(target).keyboard(String(value)); },
    } : {
      dblclick: async () => __clickIndexed(target, element, 0, {clickCount: 2}),
    }),
    type: (value) => self().fill(value),
    pressSequentially: (value) => self().fill(value),
    selectOption: (value) => self().fill(Array.isArray(value) ? value[0] : (value && value.label) || (value && value.value) || value),
    check: async () => { if (!(await self().isChecked())) await self().click(); },
    uncheck: async () => { if (await self().isChecked()) await self().click(); },
    // Page-side reads only see what is inside the op, so the not-found check is inline.
    hover: async () => { var b = await read((found) => { if (!found.length) throw new Error('TARGET_NOT_FOUND: no element matches'); found[0].scrollIntoView({block: 'center', inline: 'center'}); var r = found[0].getBoundingClientRect(); return {x: r.left + r.width / 2, y: r.top + r.height / 2}; }); await browser.page(target).hover(b.x, b.y); return b; },
    boundingBox: () => read((found) => { if (!found.length) return null; var r = found[0].getBoundingClientRect(); return {x: r.left, y: r.top, width: r.width, height: r.height}; }),
    scrollIntoViewIfNeeded: () => read((found) => { if (found[0]) found[0].scrollIntoView({block: 'center'}); return true; }),
  });
}
// Page-side: rows of the first matching table (or role=table grid) keyed by header text.
function __readTable(selector, options) {
  var table = document.querySelector(selector);
  if (!table) throw new Error('TARGET_NOT_FOUND: no table matches ' + selector);
  var clean = (el) => (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim();
  var rows = [...table.querySelectorAll('tr,[role=row]')].map((row) => [...row.querySelectorAll('th,td,[role=cell],[role=columnheader],[role=gridcell]')].map(clean));
  rows = rows.filter((cells) => cells.some(Boolean));
  if (!rows.length) return [];
  var headers = rows[0].map((cell, i) => cell || 'column' + (i + 1));
  var body = rows.slice(1, 1 + (options.limit || 500));
  return options.raw ? rows.slice(0, 1 + (options.limit || 500)) : body.map((cells) => Object.fromEntries(headers.map((h, i) => [h, cells[i] ?? ''])));
}
function __readLinks(selector) {
  var root = document.querySelector(selector) || document.body;
  return [...root.querySelectorAll('a[href]')].slice(0, 500).map((a) => ({text: (a.innerText || a.getAttribute('aria-label') || '').replace(/\\s+/g, ' ').trim().slice(0, 200), href: a.href}));
}
// google.search: real Google results through the user's browser (their region and language),
// parsed into {title, url, source, snippet}. Run queries one after another, never in parallel.
var google = Object.freeze({
  search: async (query, options = {}) => {
    var page = await __call({google: 'search', query, ...options});
    return __parseGoogle(page.html, options.limit ?? 10);
  },
});
function __parseGoogle(html, limit) {
  var doc = new DOMParser().parseFromString(html, 'text/html');
  var clean = (text) => (text || '').replace(/\\s+/g, ' ').trim();
  var seen = new Set(), results = [];
  for (var heading of doc.querySelectorAll('a[href] h3, h3 a[href]')) {
    var link = heading.closest('a[href]') || heading.querySelector('a[href]');
    var href = link && link.getAttribute('href') || '';
    if (href.startsWith('/url?')) href = new URL(href, 'https://www.google.com').searchParams.get('q') || '';
    if (!/^https?:/.test(href) || /^https?:\\/\\/([a-z]+\\.)?google\\./.test(href) || seen.has(href)) continue;
    seen.add(href);
    var block = link.closest('[data-rpos], [data-hveid], .g') || link.parentElement;
    var title = clean(heading.textContent);
    var snippet = clean(block && block.textContent).replace(title, '').slice(0, 400);
    var source = (() => { try { return new URL(href).hostname.replace(/^www\\./, ''); } catch { return ''; } })();
    results.push({title, url: href, source, snippet});
    if (results.length >= limit) break;
  }
  if (!results.length && /unusual traffic|detected unusual|captcha/i.test(html))
    throw new Error('GOOGLE_BLOCKED: Google asked for a check. Use the websearch tool, or open the results in a tab.');
  return results;
}
async function __waitUntil(check, timeout) {
  var deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await check()) return; await new Promise((done) => setTimeout(done, 250)); }
  throw new Error('TIMEOUT: element did not appear');
}
function __extendPage(target, base) {
  var css = (selector) => base.locator(selector);
  var keys = base.keyboard;
  var keyboard = Object.assign((combo) => keys(combo), {
    press: (combo) => keys(combo),
    type: (text) => keys(String(text)),
    insertText: (text) => keys(String(text)),
  });
  var byRole = base.getByRole, byText = base.getByText, coordHover = base.hover;
  // Agents sometimes reach for page.playwright.X: it is the page itself.
  base.playwright = base;
  return __extendPageSurface(target, __extendPageControls(target, __extendPageEvents(target, __extendPageData(target, Object.assign(base, {
    // Playwright accepts a RegExp for names and text. The engine's own targeting matches strings,
    // so a regex locator resolves in the page and acts on its first match.
    getByRole: (role, options = {}) => options.name instanceof RegExp
      ? __locator(target, {kind: 'locator', role, regex: [options.name.source, options.name.flags]})
      : byRole(role, options),
    getByText: (value, options = {}) => value instanceof RegExp
      ? __locator(target, {kind: 'query', by: 'text', regex: [value.source, value.flags]})
      : byText(value, options),
    // Playwright-style text snapshot of the page: the same view as bu.state().
    ariaSnapshot: (options = {}) => bu.state({...options, target}),
    // A common guess for the same view.
    domSnapshot: (options = {}) => bu.state({...options, target}),
    goto: (url, options) => base.navigate(url, options),
    hover: (a, b) => typeof a === 'string' ? css(a).first().hover() : coordHover(a, b),
    reload: () => base.cdp('Page.reload', {}),
    goBack: () => base.evaluate(() => history.back()),
    goForward: () => base.evaluate(() => history.forward()),
    content: () => base.evaluate(() => document.documentElement.outerHTML),
    $: (selector) => css(selector).first(),
    $$: (selector) => css(selector).all(),
    $eval: (selector, fn, arg) => css(selector).first().evaluate(fn, arg),
    $$eval: (selector, fn, arg) => css(selector).evaluateAll(fn, arg),
    textContent: (selector) => css(selector).first().textContent(),
    innerText: (selector) => css(selector).first().innerText(),
    getAttribute: (selector, name) => css(selector).first().getAttribute(name),
    inputValue: (selector) => css(selector).first().inputValue(),
    isVisible: (selector) => css(selector).isVisible(),
    hoverSelector: (selector) => css(selector).first().hover(),
    waitForSelector: (selector, options = {}) => base.locator(selector).first().waitFor({timeout: options.timeout ?? options.timeoutMs ?? 5000}),
    bringToFront: async () => undefined,
    check: (selector) => css(selector).first().check(),
    uncheck: (selector) => css(selector).first().uncheck(),
    selectOption: (selector, value) => css(selector).first().selectOption(value),
    dblclick: (selector) => css(selector).first().dblclick(),
    type: (selector, value) => css(selector).first().fill(value),
    waitForLoadState: (state, options = {}) => base.waitFor(state === 'domcontentloaded' ? () => document.readyState !== 'loading' : () => document.readyState === 'complete', {timeoutMs: options.timeout ?? 8000}),
    waitForURL: (pattern, options = {}) => __waitUntil(async () => {
      var url = await base.evaluate(() => location.href);
      return pattern instanceof RegExp ? pattern.test(url) : String(url).includes(String(pattern).replace(/\\*\\*/g, ''));
    }, options.timeout ?? 15000),
    waitForTimeout: (ms) => new Promise((done) => setTimeout(done, Math.min(ms, 30000))),
    // Extraction: a table as rows keyed by its header cells, and links with their text.
    table: (selector = 'table', options = {}) => (__noteRead(target), base.inspect('(' + __readTable.toString() + ')(' + JSON.stringify(selector) + ', ' + JSON.stringify(options) + ')')),
    // Every row of a list, scrolling lists that only draw what is on screen (code-api-list.ts).
    list: (selector, options) => (__noteRead(target), __collectList(base, selector, options)),
    scrollers: (options) => (__noteRead(target), __readScrollers(base, options)),
    links: (selector = 'body') => base.inspect('(' + __readLinks.toString() + ')(' + JSON.stringify(selector) + ')'),
    keyboard,
    mouse: Object.freeze({
      click: (x, y, options = {}) => options.clickCount === 2 ? base.doubleClickAt(x, y) : base.clickAt(x, y),
      dblclick: (x, y) => base.doubleClickAt(x, y),
      // {steps} moves in that many small mouse events from the last position, as a person would.
      move: async (x, y, options = {}) => {
        var steps = Math.max(1, Math.min(200, Math.round(options.steps ?? 1))), from = __mouseAt.get(__key(target)) || {x, y};
        for (var i = 1; i <= steps; i++)
          await base.cdp('Input.dispatchMouseEvent', {type: 'mouseMoved', x: from.x + (x - from.x) * i / steps, y: from.y + (y - from.y) * i / steps});
        __mouseAt.set(__key(target), {x, y});
        return {x, y, t: Date.now()};
      },
      down: (options = {}) => { var at = __mouseAt.get(__key(target)) || {x: 0, y: 0}; return base.cdp('Input.dispatchMouseEvent', {type: 'mousePressed', x: at.x, y: at.y, button: options.button || 'left', clickCount: 1}); },
      up: (options = {}) => { var at = __mouseAt.get(__key(target)) || {x: 0, y: 0}; return base.cdp('Input.dispatchMouseEvent', {type: 'mouseReleased', x: at.x, y: at.y, button: options.button || 'left', clickCount: 1}); },
      wheel: (_dx, dy) => base.scroll(dy >= 0 ? 'down' : 'up', Math.abs(dy) || 600),
    }),
  })))));
}
`;
