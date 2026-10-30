// The browser surface beyond the core page API: rendered HTML and page state, page search and
// element styles, frame diagnostics, deterministic extract and collect, settle and emulation,
// request blocking, animation and performance reads, and icon tiles. Everything here is built
// from the steps the engine already has (evaluate, cdp, observe, navigate) so it needs no new
// extension message; the pieces that do (windows, zoom) call the extension directly.

export const browserSurfaceApi = `
// ---------- page helpers (serialized into the page) ----------
function __htmlOf(options) {
  var root = options.selector ? document.querySelector(options.selector) : (options.outer ? document.documentElement : document.body);
  if (!root) return { error: 'nothing matches ' + options.selector };
  var clone = root.cloneNode(true);
  if (options.stripScripts !== false) for (var el of clone.querySelectorAll('script,style,noscript,link[rel=stylesheet]')) el.remove();
  for (var attr of ['data-aeon-overlay']) for (var marked of clone.querySelectorAll?.('[' + attr + ']') || []) marked.remove();
  var html = options.outer ? clone.outerHTML : clone.innerHTML;
  var max = Math.max(1000, options.max || 200000);
  return { html: html.length > max ? html.slice(0, max) : html, length: html.length, truncated: html.length > max };
}
function __stateOf() {
  var scroll = { x: Math.round(window.scrollX), y: Math.round(window.scrollY), height: Math.round(document.documentElement.scrollHeight), viewport: { width: window.innerWidth, height: window.innerHeight } };
  var headings = [...document.querySelectorAll('h1,h2,h3')].slice(0, 20).map((node) => ({ level: Number(node.tagName.slice(1)), text: (node.innerText || '').trim().slice(0, 200) }));
  var forms = [...document.forms].slice(0, 10).map((form) => ({ action: form.action, method: form.method, fields: [...form.elements].filter((el) => el.name).map((el) => el.name).slice(0, 30) }));
  return {
    url: location.href,
    title: document.title,
    readyState: document.readyState,
    fromHistory: performance.getEntriesByType('navigation')[0]?.type || 'navigate',
    scroll,
    headings,
    forms,
    counts: { links: document.links.length, images: document.images.length, iframes: document.querySelectorAll('iframe').length, dialogs: document.querySelectorAll('dialog,[role=dialog]').length, busy: document.querySelectorAll('[aria-busy=true]').length },
  };
}
function __findIn(text, options) {
  var needle = String(text || '').toLowerCase();
  var pattern = options.regex ? new RegExp(text, options.flags || 'i') : null;
  var max = Math.min(Math.max(options.max || 20, 1), 100);
  var matches = [];
  var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (var node = walker.nextNode(); node && matches.length < max; node = walker.nextNode()) {
    var value = (node.textContent || '').replace(/\\s+/g, ' ').trim();
    if (!value) continue;
    var hit = pattern ? pattern.test(value) : value.toLowerCase().includes(needle);
    if (!hit) continue;
    var el = node.parentElement;
    if (!el || el.closest('script,style,noscript')) continue;
    matches.push({ text: value.slice(0, 300), tag: el.tagName.toLowerCase(), role: el.getAttribute('role') || '', id: el.id || undefined, className: typeof el.className === 'string' ? el.className.slice(0, 120) : undefined });
  }
  return { matches, count: matches.length, query: String(text) };
}
function __stylesOf(selector, props) {
  var el = document.querySelector(selector);
  if (!el) return { error: 'nothing matches ' + selector };
  var computed = getComputedStyle(el);
  var wanted = props && props.length ? props : ['display', 'position', 'color', 'backgroundColor', 'fontSize', 'fontWeight', 'visibility', 'opacity', 'zIndex', 'width', 'height', 'overflow'];
  var styles = {};
  for (var prop of wanted) styles[prop] = computed.getPropertyValue(prop.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase()));
  var rect = el.getBoundingClientRect();
  return { selector, tag: el.tagName.toLowerCase(), styles, box: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) } };
}
function __animationsOf() {
  if (!document.getAnimations) return { animations: [], unsupported: true };
  return { animations: document.getAnimations().slice(0, 100).map((animation) => {
    var effect = animation.effect || {};
    var target = effect.target;
    return {
      name: animation.animationName || animation.id || undefined,
      playState: animation.playState,
      currentTime: animation.currentTime,
      duration: effect.getTiming ? effect.getTiming().duration : undefined,
      iterations: effect.getTiming ? effect.getTiming().iterations : undefined,
      target: target ? (target.tagName ? target.tagName.toLowerCase() + (target.id ? '#' + target.id : '') : undefined) : undefined,
    };
  }) };
}
function __settleOf(quietMs, timeoutMs) {
  return new Promise((done) => {
    var start = Date.now();
    var last = Date.now();
    var lastHtml = document.body ? document.body.innerHTML.length : 0;
    var timer = setInterval(() => {
      var html = document.body ? document.body.innerHTML.length : 0;
      if (html !== lastHtml) { lastHtml = html; last = Date.now(); }
      var quiet = Date.now() - last;
      if (quiet >= quietMs || Date.now() - start >= timeoutMs) {
        clearInterval(timer);
        done({ settled: quiet >= quietMs, quietMs: quiet, waitedMs: Date.now() - start, readyState: document.readyState });
      }
    }, 100);
  });
}
function __collectRows(spec) {
  var textOf = (node) => (node.innerText ?? node.textContent ?? '').trim();
  var normalize = (raw) => {
    if (typeof raw === 'object' && raw) return raw;
    var selector = String(raw || '');
    var all = /\\[\\]$/.test(selector);
    selector = selector.replace(/\\[\\]$/, '').replace(/^\\?/, '').replace(/\\?$/, '');
    var at = selector.lastIndexOf('@');
    return at > 0 ? { selector: selector.slice(0, at), attr: selector.slice(at + 1), all } : { selector, all };
  };
  var readField = (row, raw) => {
    var field = normalize(raw);
    var nodes = [];
    try { nodes = field.selector ? [...row.querySelectorAll(field.selector)] : [row]; } catch { nodes = []; }
    if (field.contains) nodes = nodes.filter((node) => textOf(node).includes(field.contains));
    var picked = field.all ? nodes : nodes.slice(0, 1);
    var values = picked.map((node) => {
      var value = field.property ? node[field.property] : field.attr ? node.getAttribute(field.attr) : textOf(node);
      if (typeof value === 'string') {
        value = value.trim();
        if (field.match) {
          var match = new RegExp(field.match, field.flags || '').exec(value);
          value = match ? (match[field.group ?? 1] ?? match[0]) : null;
        }
        if (typeof value === 'string' && field.strip) value = value.split(field.strip).join('').trim();
        if (value === '') value = null;
      }
      return value;
    });
    if (field.all) return values.filter((value) => value !== null);
    return values[0] ?? (field.default ?? null);
  };
  var setNested = (target, path, value) => {
    var parts = String(path).split('.');
    var current = target;
    for (var part of parts.slice(0, -1)) {
      if (!current[part] || typeof current[part] !== 'object') current[part] = {};
      current = current[part];
    }
    current[parts[parts.length - 1]] = value;
  };
  var read = () => [...document.querySelectorAll(spec.row)].slice(0, spec.max || 200).map((row) => {
    var out = {};
    for (var [name, field] of Object.entries(spec.fields || {})) setNested(out, name, readField(row, field));
    return out;
  });
  var expand = (spec.expand || []).flatMap((entry) => {
    if (/^[\\[#.]/.test(entry)) return [...document.querySelectorAll(entry)];
    return [...document.querySelectorAll('button, a, [role=button]')].filter((node) => textOf(node).toLowerCase().includes(String(entry).toLowerCase()));
  });
  for (var button of expand.slice(0, 40)) { try { button.click(); } catch {} }
  if (!spec.scroll) return read();
  return new Promise((done) => {
    var seen = 0, idle = 0, rounds = 0;
    var timer = setInterval(() => {
      rounds += 1;
      var count = document.querySelectorAll(spec.row).length;
      if (count >= (spec.max || 200) || rounds >= 200) { clearInterval(timer); done(read()); return; }
      if (count === seen) idle += 1; else { idle = 0; seen = count; }
      if (idle >= (spec.idleRounds || 3)) { clearInterval(timer); done(read()); return; }
      window.scrollTo(0, document.body.scrollHeight);
    }, 350);
  });
}
function __iconBoxes(max, selector) {
  var textOf = (node) => (node.innerText ?? node.textContent ?? '').trim();
  var nodes = [...document.querySelectorAll(selector || 'button,[role=button],a')];
  return nodes.filter((node) => {
    var rect = node.getBoundingClientRect();
    if (rect.width < 8 || rect.height < 8 || rect.width > 160 || rect.height > 160) return false;
    if (textOf(node).length > 0) return false;
    return !!node.querySelector('svg,img');
  }).slice(0, max || 40).map((node, index) => {
    var rect = node.getBoundingClientRect();
    return {
      index,
      label: node.getAttribute('aria-label') || node.getAttribute('title') || node.getAttribute('data-testid') || undefined,
      tag: node.tagName.toLowerCase(),
      box: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
    };
  });
}
// A screenshot is saved in the workspace and returned as {saved: absolute path}. The image itself
// stays off the printed result (megabytes of base64) unless {inline: true} or {save: false}, but
// code can still read .dataBase64. {path} names the file; it is always written inside the workspace.
async function __savedShot(shot, options) {
  if (!shot.data) throw new Error('SCREENSHOT_CAPTURE_FAILED');
  var mimeType = shot.mimeType || 'image/png';
  var result = {mimeType};
  if (options.save !== false) {
    var asked = String(options.path || options.name || '').replace(/\\\\/g, '/');
    var outside = /^([a-z]:)?\\//i.test(asked) || asked.startsWith('../');
    var name = !asked ? 'screens/' + Date.now() + '.' + (mimeType.split('/')[1] === 'jpeg' ? 'jpg' : mimeType.split('/')[1]) : outside ? 'screens/' + asked.split('/').pop() : asked;
    var file = await artifact(name, __bytesFromBase64(shot.data));
    result.saved = (file && file.path) || name;
    if (outside) result.note = 'browser code writes only inside its workspace, so ' + asked + ' was saved there instead';
  }
  Object.defineProperty(result, 'dataBase64', {value: shot.data, enumerable: options.inline === true || options.save === false});
  return result;
}
function __bytesFromBase64(base64) {
  var binary = atob(base64);
  var bytes = new Uint8Array(binary.length);
  for (var index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

// ---------- automatic screenshots and diffs after actions ----------
var __auto = { on: false, screenshots: true, diff: true, save: true, full: false, settleMs: 0, shots: [], last: new Map(), busy: false };
function __options(config = {}) {
  for (var key of ['on', 'screenshots', 'diff', 'save', 'full']) if (config[key] !== undefined) __auto[key] = config[key] === true;
  if (config.settleMs !== undefined) __auto.settleMs = Math.max(0, Math.min(Number(config.settleMs) || 0, 60000));
  return { on: __auto.on, screenshots: __auto.screenshots, diff: __auto.diff, save: __auto.save, full: __auto.full, settleMs: __auto.settleMs };
}
async function __autoAfter(target, step) {
  if (!__auto.on || __auto.busy) return;
  __auto.busy = true;
  try {
    if (__auto.settleMs) { try { await browser.page(target).settle({quietMs: __auto.settleMs, timeoutMs: 10000}); } catch {} }
    if (!__auto.screenshots) return;
    var shot = await __step({op:'observe', target, kind:'screenshot'});
    var data = shot && (shot.data || shot);
    if (!data || !data.dataBase64) return;
    var stamp = new Date().toISOString().replace(/[:.]/g, '-');
    var name = 'screens/' + stamp + '-after-' + String(step.op) + (__auto.full ? '-full' : '') + '.jpg';
    if (__auto.save) await artifact(name, __bytesFromBase64(data.dataBase64));
    var previous = __auto.last.get(__key(target));
    var diff;
    if (__auto.diff && previous) {
      try { diff = await __diffScreenshot(target, previous, {}); }
      catch (error) { diff = { error: String((error && error.message) || error) }; }
    }
    __auto.last.set(__key(target), data.dataBase64);
    __auto.shots.push({ step: step.op, name: __auto.save ? name : null, at: new Date().toISOString(),
      ...(diff ? { diff: { changedRatio: diff.changedRatio, changedPixels: diff.changedPixels, ...(diff.error ? { error: diff.error } : {}) } } : {}) });
  } finally { __auto.busy = false; }
}

// ---------- page additions ----------
function __extendPageSurface(target, base) {
  return Object.assign(base, {
    // The rendered HTML, with scripts and styles removed by default.
    html: async (options = {}) => (await __step({op:'evaluate', target, expression: '(' + __htmlOf.toString() + ')(' + JSON.stringify({
      selector: options.selector,
      outer: options.outer === true,
      stripScripts: options.stripScripts !== false,
      max: Math.min(Math.max(options.max || 200000, 1000), 1000000),
    }) + ')'})).data.value,
    // Where the page is: url, title, scroll, headings, forms and counts.
    state: async () => (await __step({op:'evaluate', target, expression: '(' + __stateOf.toString() + ')()'})).data.value,
    // Find text on the page without reading all of it.
    find: async (text, options = {}) => (await __step({op:'evaluate', target, expression: '(' + __findIn.toString() + ')(' + JSON.stringify(String(text)) + ',' + JSON.stringify({
      max: options.max || 20,
      regex: options.regex === true,
      flags: options.flags || 'i',
    }) + ')'})).data.value,
    // Computed styles and the box for one element.
    styles: async (selector, options = {}) => (await __step({op:'evaluate', target, expression: '(' + __stylesOf.toString() + ')(' + JSON.stringify(String(selector)) + ',' + JSON.stringify(options.props || []) + ')'})).data.value,
    // Frames: the main document and a named, url-matched or indexed sub-frame.
    mainFrame: async () => __framePage(target, { frameId: '', url: (await page.url()), name: 'main', main: true }),
    frame: async (match) => {
      var frames = await __step({op:'frames', target, action:'list'});
      var list = frames.data || [];
      var wanted = typeof match === 'number' ? list[match] : typeof match === 'string'
        ? list.find((item) => (item.name || '') === match) || list.find((item) => String(item.url || '').includes(match))
        : list.find((item) => (match.name && item.name === match.name) || (match.url && String(item.url || '').includes(match.url))) || (match.index !== undefined ? list[match.index] : undefined);
      if (!wanted) throw Error('FRAME_NOT_FOUND: ' + JSON.stringify(match) + '; page.frames() lists ' + list.length + ' frames');
      return __framePage(target, wanted);
    },
    // Every frame with its url, name and whether it is the main document.
    diagnoseFrames: async () => {
      var frames = (await __step({op:'frames', target, action:'list'})).data || [];
      var main = await page.url();
      return { frames: frames.map((frame) => ({ frameId: frame.frameId, url: frame.url, name: frame.name || undefined, main: String(frame.url || '') === String(main) })), count: frames.length };
    },
    // A stable read: fresh tab, readiness, script, validation, retries, cleanup.
    extract: async (spec) => {
      var script = spec.script;
      if (!script) throw Error('EXTRACT_SCRIPT: pass script as an async function over (page, bu) or a page expression');
      var attempts = Math.max(1, Math.min(spec.retries === undefined ? 1 : spec.retries + 1, 5));
      var errors = [];
      for (var attempt = 1; attempt <= attempts; attempt++) {
        var tab;
        try {
          if (spec.url) {
            tab = await browser.openTab(spec.url, { newTab: true, quiet: true });
            page = tab;
            target = tab.target;
          }
          if (spec.ready !== false) await page.waitReady({ timeoutMs: spec.readyTimeoutMs || 10000 });
          var value = await (0, eval)('(' + script + ')(page, bu)');
          var data = await value;
          if (spec.schema && !__validShape(data, spec.schema)) throw Error('EXTRACT_SCHEMA: the value does not match the schema');
          var rows = Array.isArray(data) ? data : (spec.rowKey ? [data] : data);
          if (spec.rowKey && Array.isArray(rows)) {
            var seen = new Set();
            rows = rows.filter((row) => {
              var key = row && typeof row === 'object' ? String(row[spec.rowKey]) : String(row);
              if (seen.has(key)) return false;
              seen.add(key);
              return true;
            });
          }
          if (spec.format === 'jsonl' && Array.isArray(rows) && spec.out) {
            await artifact(spec.out, rows.map((row) => JSON.stringify(row)).join('\\n'));
          }
          return { ok: true, data: rows, attempts: attempt, url: await page.url() };
        } catch (error) {
          errors.push(String(error && error.message || error));
        } finally {
          if (tab && spec.fresh !== false) { try { await page.close(); } catch {} }
        }
      }
      return { ok: false, attempts, errors };
    },
    // Rows from a list: field specs, expand buttons, scroll, dedupe, JSONL.
    collect: async (spec = {}) => {
      if (!spec.row) throw Error('COLLECT_ROW: pass row as a CSS selector');
      var expression = '(' + __collectRows.toString() + ')(' + JSON.stringify({
        row: spec.row, fields: spec.fields || {}, expand: spec.expand || [], scroll: false,
        max: spec.max || 200, idleRounds: spec.idleRounds || 3,
      }) + ')';
      var list = [], seen = new Set(), idle = 0, rounds = 0;
      var keyOf = (row) => spec.key && row && row[spec.key] !== undefined ? String(row[spec.key]) : JSON.stringify(row);
      while (true) {
        var batch = (await __step({op:'evaluate', target, expression})).data.value || [];
        var added = 0;
        for (var row of batch) {
          var key = spec.dedupe === false ? rounds + ':' + added : keyOf(row);
          if (seen.has(key)) continue;
          seen.add(key);
          list.push(row);
          added += 1;
          if (list.length >= (spec.max || 200)) break;
        }
        rounds += 1;
        if (!spec.scroll || rounds >= 100 || list.length >= (spec.max || 200)) break;
        if (added === 0) idle += 1; else idle = 0;
        if (idle >= (spec.idleRounds || 3)) break;
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
        await __sleep(350);
      }
      if (spec.out) await artifact(spec.out, list.map((row) => JSON.stringify(row)).join('\\n'));
      return { rows: list, count: list.length, ...(spec.out ? { saved: spec.out } : {}) };
    },
    // Waits until the page is quiet: no loading, no pending requests, quiet for quietMs.
    settle: async (options = {}) => (await __step({op:'settle', target, quietMs: Math.min(Math.max(options.quietMs || 500, 50), 10000), timeoutMs: Math.min(Math.max(options.timeoutMs || 10000, 100), 60000)})).data,    // Screenshot with full-page, annotation, and save choices.
    screenshot: async (options = {}) => {
      if (options.labels) return __labeledScreenshot(target);
      var params = { format: options.format || 'png', captureBeyondViewport: options.fullPage === true };
      if (options.annotate) {
        await __step({op:'evaluate', target, expression: '(' + __annotateShim.toString() + ')(' + JSON.stringify(options.annotate === true ? {} : options.annotate) + ')'});
      }
      var shot = options.fullPage || options.annotate || options.path || options.name
        ? {data: (await page.cdp('Page.captureScreenshot', params)).data, mimeType: 'image/' + params.format}
        : await __step({op:'observe', target, kind:'screenshot'}).then((result) => ({data: result.data && result.data.dataBase64, mimeType: result.data && result.data.mimeType}));
      return __savedShot(shot, options);
    },
    // Emulation: network conditions, CPU throttle, viewport and touch.
    emulateNetwork: async (options = {}) => page.cdp('Network.emulateNetworkConditions', {
      offline: options.offline === true,
      latency: Math.max(0, options.latency || 0),
      downloadThroughput: options.download === undefined ? -1 : Math.max(0, options.download) * 1024,
      uploadThroughput: options.upload === undefined ? -1 : Math.max(0, options.upload) * 1024,
    }),
    emulateCPU: async (rate) => page.cdp('Emulation.setCPUThrottlingRate', { rate: Math.min(Math.max(Number(rate) || 1, 1), 20) }),
    emulateViewport: async (options = {}) => {
      await page.cdp('Emulation.setDeviceMetricsOverride', {
        width: Math.max(200, Number(options.width) || 1280),
        height: Math.max(200, Number(options.height) || 800),
        deviceScaleFactor: Number(options.scale ?? 1),
        mobile: options.mobile === true,
      });
      if (options.touch !== undefined) await page.cdp('Emulation.setTouchEmulationEnabled', { enabled: options.touch === true });
      return { viewport: { width: options.width || 1280, height: options.height || 800, mobile: options.mobile === true } };
    },
    touch: (enabled = true) => page.cdp('Emulation.setTouchEmulationEnabled', { enabled: enabled !== false }),
    // Stop matching requests before they are sent, or let them through again.
    abort: async (patterns) => page.cdp('Network.setBlockedURLs', { urls: [].concat(patterns).map(String) }),
    abortClear: async () => page.cdp('Network.setBlockedURLs', { urls: [] }),
    animations: async () => (await __step({op:'evaluate', target, expression: '(' + __animationsOf.toString() + ')()'})).data.value,
    performance: async () => {
      await page.cdp('Performance.enable', {});
      var metrics = await page.cdp('Performance.getMetrics', {});
      var values = Object.fromEntries((metrics.metrics || []).map((metric) => [metric.name, metric.value]));
      return { metrics: values, navigation: await page.evaluate(() => {
        var entry = performance.getEntriesByType('navigation')[0];
        return entry ? { domContentLoaded: Math.round(entry.domContentLoadedEventEnd), load: Math.round(entry.loadEventEnd), ttfb: Math.round(entry.responseStart), transferSize: entry.transferSize } : null;
      }) };
    },
    // Writes the rendered HTML (scripts stripped by default) to a workspace file.
    saveHtml: async (name = 'page.html', options = {}) => {
      var html = await page.html(options);
      await artifact(String(name), html.html);
      return { saved: String(name), length: html.length, truncated: html.truncated === true };
    },
    // What automatic screenshots are set to, and the last few they took.
    autoState: () => ({ ...__options(), shots: __auto.shots.slice(-10) }),
    // A Chrome performance trace saved as a workspace artifact.
    trace: async (options = {}) => {
      var events = [];
      var complete;
      var done = new Promise((resolve) => { complete = resolve; });
      // One subscription is set up at a time: two concurrent subscribe steps for the same tab
      // reach Chrome out of order and the second is rejected as a claim conflict.
      var data = page.onCdp('Tracing.dataCollected', (params) => { for (var item of (params.value || [])) events.push(item); });
      await data.ready;
      var finished = page.onCdp('Tracing.tracingComplete', () => { complete(); });
      await finished.ready;
      await page.cdp('Tracing.start', { categories: options.categories || 'devtools.timeline,v8,blink.user_timing,loading', transferMode: 'ReportEvents' });
      await __sleep(Math.min(Math.max(Number(options.seconds) || 2, 0.5), 30) * 1000);
      await page.cdp('Tracing.end', {});
      await Promise.race([done, __sleep(10000)]);
      try { await data.stop(); } catch {}
      try { await finished.stop(); } catch {}
      var name = String(options.out || ('traces/trace-' + Date.now() + '.json'));
      await artifact(name, JSON.stringify({ traceEvents: events }));
      return { saved: name, events: events.length };
    },
    // Small screenshots of icon-only controls, not the whole page.
    iconTiles: async (options = {}) => {
      var boxes = (await __step({op:'evaluate', target, expression: '(' + __iconBoxes.toString() + ')(' + JSON.stringify(options.max || 30) + ',' + JSON.stringify(options.selector || '') + ')'})).data.value || [];
      var saved = [];
      for (var box of boxes) {
        if (box.box.width < 8 || box.box.height < 8) continue;
        var shot = await page.cdp('Page.captureScreenshot', { format: 'png', clip: { x: box.box.x, y: box.box.y, width: box.box.width, height: box.box.height, scale: 1 } });
        var name = (options.folder || 'icons') + '/' + String(box.label || ('icon-' + box.index)).replace(/[^\\w.-]+/g, '-') + '.png';
        await artifact(name, __bytesFromBase64(shot.data));
        saved.push({ label: box.label, name, box: box.box });
      }
      return { tiles: saved, count: saved.length };
    },
  });
}
function __validShape(value, schema) {
  if (schema === 'array' || schema === 'rows') return Array.isArray(value);
  if (schema === 'object') return !!value && typeof value === 'object' && !Array.isArray(value);
  if (schema && typeof schema === 'object' && schema.required) {
    if (!value || typeof value !== 'object') return false;
    return schema.required.every((key) => value[key] !== undefined);
  }
  return true;
}
// Annotation for screenshots: numbered boxes over interactive elements, as a page overlay.
function __annotateShim() {
  var layer = document.createElement('div');
  layer.setAttribute('data-aeon-overlay', 'annotate');
  layer.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483647';
  var index = 0;
  for (var node of document.querySelectorAll('button,a,[role=button],input,select,textarea')) {
    var rect = node.getBoundingClientRect();
    if (rect.width < 6 || rect.height < 6 || rect.bottom < 0 || rect.top > innerHeight) continue;
    index += 1;
    var box = document.createElement('div');
    box.style.cssText = 'position:absolute;left:' + rect.left + 'px;top:' + rect.top + 'px;width:' + rect.width + 'px;height:' + rect.height + 'px;border:2px solid #ff2d55;border-radius:3px;font:12px/1 monospace;color:#fff';
    box.innerHTML = '<span style="background:#ff2d55;padding:1px 3px;position:absolute;left:-2px;top:-16px">' + index + '</span>';
    layer.appendChild(box);
  }
  document.documentElement.appendChild(layer);
  return { boxes: index };
}
`;

// The browser-level additions (windows, zoom) use requests the extension answers directly.
export const browserWindowApi = `
var __windows = Object.freeze({
  list: () => __call({windows:'list'}),
  resize: (windowId, size) => __call({windows:'resize', windowId, width: Math.round(size.width), height: Math.round(size.height)}),
  close: (windowId) => __call({windows:'close', windowId}),
});
var __zoom = (factor, tabId) => __call({windows:'zoom', factor: Math.min(Math.max(Number(factor) || 1, 0.25), 5), ...(tabId === undefined ? {} : {tabId})});
`;
