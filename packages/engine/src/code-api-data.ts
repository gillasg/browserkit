// Data helpers for browser_code: calling a site's endpoints from inside its page, the page's
// embedded data and metadata, clean Markdown, session export, fetching without a tab, and a
// pool that works through many URLs in parallel tabs. Evaluated in the sandbox realm.
export const browserDataApi = `
// Headers the browser sets itself; a replayed request must not carry the recorded copies.
var __replayDropped = /^(:|host$|connection$|content-length$|cookie$|origin$|referer$|accept-encoding$|keep-alive$|transfer-encoding$|te$|upgrade$|via$|proxy-|sec-|priority$)/i;

function __pageRequest(request) {
  return (async () => {
    var headers = new Headers(request.headers || {});
    if (request.csrf) {
      var meta = document.querySelector('meta[name="csrf-token"],meta[name="_csrf"],meta[name="csrf"],meta[name="x-csrf-token"]');
      var cookie = document.cookie.match(/(?:^|; )(?:XSRF-TOKEN|xsrf-token|csrftoken|_csrf|csrf_token)=([^;]+)/);
      var token = (meta && meta.getAttribute('content')) || (cookie && decodeURIComponent(cookie[1]));
      if (token && !headers.has('x-csrf-token')) headers.set('x-csrf-token', token);
      if (token && cookie && !headers.has('x-xsrf-token')) headers.set('x-xsrf-token', token);
    }
    var body = request.json !== undefined ? JSON.stringify(request.json) : request.body;
    if (request.json !== undefined && !headers.has('content-type')) headers.set('content-type', 'application/json');
    var response = await fetch(request.url, {method: request.method || 'GET', headers, body,
      credentials: request.credentials || 'include', redirect: 'follow'});
    var text = await response.text();
    var result = {status: response.status, ok: response.ok, url: response.url,
      headers: Object.fromEntries(response.headers)};
    try { result.json = JSON.parse(text); } catch { result.text = text.slice(0, 2000000); }
    return result;
  })();
}

function __readMetadata() {
  var meta = {};
  document.querySelectorAll('meta[property],meta[name]').forEach((tag) => {
    var key = tag.getAttribute('property') || tag.getAttribute('name');
    var value = tag.getAttribute('content');
    if (key && value && /^(og:|twitter:|article:|product:|description$|keywords$|author$|robots$)/i.test(key)) meta[key] = value;
  });
  var link = (rel) => document.querySelector('link[rel="' + rel + '"]')?.href;
  return {
    url: location.href, title: document.title, lang: document.documentElement.lang || undefined,
    description: meta.description, canonical: link('canonical'), icon: link('icon') || link('shortcut icon'),
    alternates: [...document.querySelectorAll('link[rel="alternate"][hreflang]')].map((tag) => ({lang: tag.hreflang, url: tag.href})),
    meta,
  };
}

// Runs in the page, so the metadata reader is passed in rather than referenced.
function __readPageData(readMetadata, options) {
  // Every array of objects inside the embedded data, by path: a Next/Nuxt/Redux page keeps what
  // it renders in here, so this is the cheapest way to the data behind the layout.
  function dataLists(root, limit) {
    var found = [];
    function walk(value, path, depth) {
      if (!value || typeof value !== 'object' || depth > 8 || found.length >= limit) return;
      if (Array.isArray(value)) {
        var first = value[0];
        if (!value.length) return;
        if (first && typeof first === 'object' && !Array.isArray(first))
          found.push({path: path, count: value.length, keys: Object.keys(first).slice(0, 12), sample: value.slice(0, 5)});
        // Nested lists live inside the items too (a page of orders with its lines).
        walk(first, path + '[]', depth + 1);
        return;
      }
      for (var key of Object.keys(value).slice(0, 60)) walk(value[key], path ? path + '.' + key : key, depth + 1);
    }
    walk(root, '', 0);
    return found;
  }
  var parse = (text) => { try { return JSON.parse(text); } catch { return undefined; } };
  var plain = (value) => { try { return JSON.parse(JSON.stringify(value)); } catch { return undefined; } };
  var data = {}, notes = [], partial = false;
  var jsonLdTags = [...document.querySelectorAll('script[type="application/ld+json"]')];
  var jsonLd = jsonLdTags.map((tag) => parse(tag.textContent)).filter(Boolean);
  if (jsonLd.length) data.jsonLd = jsonLd;
  if (jsonLd.length < jsonLdTags.length) {
    partial = true;
    notes.push((jsonLdTags.length - jsonLd.length) + ' JSON-LD block(s) were not valid JSON');
  }
  var next = document.getElementById('__NEXT_DATA__');
  if (next) {
    data.nextData = parse(next.textContent);
    if (data.nextData === undefined) {
      partial = true;
      notes.push('__NEXT_DATA__ was not valid JSON');
    }
  }
  for (var name of ['__NUXT__', '__NUXT_DATA__', '__APOLLO_STATE__', '__INITIAL_STATE__', '__PRELOADED_STATE__', '__REDUX_STATE__', '__INITIAL_DATA__', '__DATA__', '__STATE__', '__remixContext', '__staticRouterHydrationData']) {
    var value = window[name];
    if (value && typeof value === 'object') { var copy = plain(value); if (copy !== undefined) data[name] = copy; }
  }
  if (Array.isArray(window.__next_f)) {
    var flight = window.__next_f.map((chunk) => chunk && chunk[1]).filter((chunk) => typeof chunk === 'string').join('');
    data.nextFlight = flight.slice(0, 1000000);
    if (flight.length > 1000000) {
      partial = true;
      notes.push('nextFlight cut at 1,000,000 characters');
    }
  }
  var scripts = [...document.querySelectorAll('script[type="application/json"]')]
    .filter((tag) => tag.id !== '__NEXT_DATA__');
  var kept = scripts.filter((tag) => tag.textContent.length < 3000000)
    .map((tag) => ({id: tag.id || undefined, data: parse(tag.textContent)})).filter((item) => item.data !== undefined);
  if (kept.length) data.jsonScripts = kept;
  if (kept.length < scripts.length) {
    partial = true;
    notes.push((scripts.length - kept.length) + ' JSON script(s) were too large or not valid JSON');
  }
  if (options && options.summary) {
    var sources = {};
    for (var source of Object.keys(data)) {
      var item = data[source];
      if (Array.isArray(item)) sources[source] = {items: item.length};
      else if (item && typeof item === 'object') {
        var arrays = {};
        for (var field of Object.keys(item)) if (Array.isArray(item[field])) arrays[field] = item[field].length;
        sources[source] = {keys: Object.keys(item).slice(0, 10), arrays: arrays};
      } else sources[source] = {};
    }
    var params = [];
    try { params = [...new URL(location.href).searchParams.keys()]; } catch {}
    return {sources: sources, urlParams: params, partial, notes};
  }
  var find = options && Array.isArray(options.find) ? options.find.map(String).slice(0, 12) : [];
  var lists = dataLists(data, 20);
  if (find.length) {
    var hits = lists.filter((list) => list.sample[0] && find.every((key) => key in list.sample[0]));
    if (!hits.length)
      notes.push('no array of objects with ' + find.join(', ') + ' in the page data; source keys: ' + Object.keys(data).join(', '));
    return {
      find: find,
      lists: hits.map((list) => ({path: list.path, count: list.count, keys: list.keys,
        items: list.sample.slice(0, Math.max(1, Math.min(50, Number(options.max) || 10)))})),
      sources: Object.keys(data),
      partial,
      notes,
    };
  }
  if (lists.length) data.lists = lists.slice(0, 5).map((list) => ({path: list.path, count: list.count, keys: list.keys}));
  data.metadata = readMetadata();
  if (partial) { data.partial = true; data.notes = notes; }
  return data;
}

// HTML to Markdown, in the page: headings, paragraphs, lists, links, emphasis, code, quotes,
// images and tables. With mainOnly, navigation, headers, footers and asides are skipped. The
// result says when it saw less than the page holds (a feed or replies outside the area, a cut).
function __readMarkdown(options) {
  var skip = /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE|SVG|CANVAS|IFRAME|OBJECT|SELECT|BUTTON|INPUT|TEXTAREA)$/;
  var chrome = /^(NAV|HEADER|FOOTER|ASIDE|FORM)$/;
  var noise = /(^|[-_ ])(nav|menu|footer|header|sidebar|cookie|consent|banner|share|social|related|newsletter|breadcrumb|advert|promo|popup|modal)([-_ ]|$)/i;
  var main = document.querySelector('main, [role="main"], #main, #content, .content');
  var articles = [...document.querySelectorAll('article')];
  var root, outside = 0;
  if (options.selector) root = document.querySelector(options.selector);
  else if (options.mainOnly === false) root = document.body;
  else if (main) root = main;
  else if (articles.length) root = articles.length === 1 ? articles[0] : (articles[0].parentElement || document.body);
  else root = document.body;
  if (!options.selector && options.mainOnly !== false && main && articles.length) {
    var missing = articles.filter((article) => !main.contains(article));
    var parent = main.parentElement;
    if (missing.length && parent && missing.every((article) => parent.contains(article))) root = parent;
  }
  if (!root) return {markdown: '', partial: false, notes: [], chars: 0};
  if (main && options.mainOnly !== false && !options.selector)
    outside = articles.filter((article) => !root.contains(article)).length;
  if (!options.selector && options.mainOnly !== false)
    outside = Math.max(outside, articles.filter((article) => !root.contains(article)).length);
  var hidden = (element) => { var style = getComputedStyle(element); return style.display === 'none' || style.visibility === 'hidden' || element.getAttribute('aria-hidden') === 'true'; };
  var hiddenArticles = articles.filter((article) => hidden(article) || !!article.closest('[hidden]'));
  var absolute = (url) => { try { return new URL(url, location.href).href; } catch { return url; } };
  var clean = (text) => text.replace(/\\s+/g, ' ');
  function inline(node) {
    if (node.nodeType === 3) return clean(node.textContent);
    if (node.nodeType !== 1 || skip.test(node.tagName) || hidden(node)) return '';
    var inner = () => [...node.childNodes].map(inline).join('');
    switch (node.tagName) {
      case 'A': { var text = inner().trim(); var href = node.getAttribute('href'); return href && text && !href.startsWith('javascript:') ? '[' + text + '](' + absolute(href) + ')' : text; }
      case 'STRONG': case 'B': { var bold = inner().trim(); return bold ? '**' + bold + '** ' : ''; }
      case 'EM': case 'I': { var italic = inner().trim(); return italic ? '_' + italic + '_ ' : ''; }
      case 'CODE': return '\`' + node.textContent + '\`';
      case 'BR': return '\\n';
      case 'IMG': { var alt = node.getAttribute('alt'); return alt ? '![' + clean(alt) + '](' + absolute(node.getAttribute('src') || '') + ')' : ''; }
      default: return block(node) ? '\\n' + blocks(node) + '\\n' : inner();
    }
  }
  function block(node) { return /^(P|DIV|SECTION|ARTICLE|MAIN|UL|OL|LI|H[1-6]|PRE|BLOCKQUOTE|TABLE|FIGURE|FIGCAPTION|DL|DT|DD|HR|HEADER|FOOTER|NAV|ASIDE)$/.test(node.tagName); }
  function table(node) {
    var rows = [...node.querySelectorAll('tr')].map((row) => [...row.children].map((cell) => clean(inline(cell)).trim().replace(/\\|/g, '\\\\|')));
    if (!rows.length) return '';
    var width = Math.max(...rows.map((row) => row.length));
    var line = (row) => '| ' + Array.from({length: width}, (_, index) => row[index] || '').join(' | ') + ' |';
    return [line(rows[0]), '| ' + Array(width).fill('---').join(' | ') + ' |', ...rows.slice(1).map(line)].join('\\n');
  }
  function element(node, depth) {
    var tag = node.tagName;
    if (/^H[1-6]$/.test(tag)) return '#'.repeat(Number(tag[1])) + ' ' + clean(inline(node)).trim();
    if (tag === 'PRE') return '\`\`\`\\n' + node.textContent.replace(/\\n$/, '') + '\\n\`\`\`';
    if (tag === 'BLOCKQUOTE') return blocks(node, depth).split('\\n').map((line) => '> ' + line).join('\\n');
    if (tag === 'TABLE') return table(node);
    if (tag === 'HR') return '---';
    if (tag === 'UL' || tag === 'OL') return [...node.children].filter((child) => child.tagName === 'LI').map((item, index) =>
      '  '.repeat(depth) + (tag === 'OL' ? (index + 1) + '. ' : '- ') + blocks(item, depth + 1).trim()).join('\\n');
    return blocks(node, depth);
  }
  function blocks(node, depth = 0) {
    var parts = [], line = '';
    var flush = () => { if (line.trim()) parts.push(line.trim()); line = ''; };
    for (var child of node.childNodes) {
      if (child.nodeType === 1 && (skip.test(child.tagName) || hidden(child))) continue;
      if (child.nodeType === 1 && options.mainOnly !== false && child !== root && (chrome.test(child.tagName) || noise.test((child.id || '') + ' ' + (typeof child.className === 'string' ? child.className : '')))) continue;
      if (child.nodeType === 1 && block(child)) { flush(); var text = element(child, depth); if (text.trim()) parts.push(text.trim()); }
      else line += inline(child);
    }
    flush();
    return parts.join(depth ? '\\n' : '\\n\\n');
  }
  var title = options.title === false ? '' : '# ' + document.title.trim() + '\\n\\n';
  var markdown = (title + blocks(root)).replace(/\\n{3,}/g, '\\n\\n').trim();
  var max = options.max || 200000;
  var notes = [], partial = false;
  if (outside) {
    partial = true;
    notes.push(outside + ' repeated item' + (outside === 1 ? '' : 's') + ' (a feed or replies) outside the read area');
  }
  if (hiddenArticles.length) {
    partial = true;
    notes.push(hiddenArticles.length + ' repeated item' + (hiddenArticles.length === 1 ? '' : 's') + ' hidden behind Show more/Show replies');
  }
  if (markdown.length > max) {
    markdown = markdown.slice(0, max);
    partial = true;
    notes.push('cut at ' + max + ' characters');
  }
  return {markdown, partial, notes, chars: markdown.length};
}

// Puts "Show more", "Show replies", "Read more" and the like back into view, inside the main
// content only, at most ten times. It never clicks a control that posts, follows, likes, buys or
// navigates: only buttons whose whole label is one of these expansions.
function __expandRead(options) {
  var root = document.querySelector('main, [role="main"], #main, #content, .content') || document.body;
  var allowed = /^(show more|show replies|show \\d+ more|show more replies|read more|view more|see more|load more|more replies)$/i;
  var danger = /\\b(post|reply|follow|like|buy|order|purchase|subscribe|send|share|delete|block|report|retweet|repost|message|pay)\\b/i;
  var clicked = [], skipped = [];
  var max = Math.max(0, Math.min(10, Number(options.max) || 10));
  for (var button of root.querySelectorAll('button, [role="button"], a[role="button"]')) {
    if (clicked.length >= max || button.disabled) break;
    if (button.tagName === 'A' || button.closest('a[href]')) continue;
    var text = (button.innerText || button.getAttribute('aria-label') || '').replace(/\\s+/g, ' ').trim();
    if (!text) continue;
    if (!allowed.test(text) && !allowed.test(button.getAttribute('aria-label') || '')) { skipped.push(text.slice(0, 60)); continue; }
    if (danger.test(text) && !/^(show replies|show more replies|more replies)$/i.test(text)) { skipped.push(text.slice(0, 60)); continue; }
    try { button.click(); clicked.push(text); } catch {}
  }
  // Every other button on the page is skipped: report each label once, a dozen at most.
  var unique = [...new Set(skipped)];
  return {clicked, skipped: unique.slice(0, 12), ...(skipped.length > 12 ? {skippedTotal: skipped.length} : {})};
}

// Waits for the main content to settle: the text stops growing and no new resources arrive for
// a short while, capped at five seconds. Called only by page.read.
function __waitRead(options) {
  var root = document.querySelector('main, [role="main"], #main, #content, .content') || document.body;
  var max = Math.max(200, Math.min(5000, Number(options.maxMs) || 5000));
  var min = Math.min(max, Math.max(0, Number(options.minMs) || 1500));
  var started = Date.now(), lastText = -1, lastResources = -1, stable = 0;
  return new Promise((done) => {
    var finish = (settled) => done({settled, ms: Date.now() - started, chars: root ? root.innerText.length : 0, partial: !settled, ...(settled ? {} : {note: 'content was still changing after ' + max + ' ms'})});
    var tick = () => {
      var text = root ? root.innerText.length : 0;
      var resources = performance.getEntriesByType('resource').length;
      if (text === lastText && resources === lastResources) stable += 1;
      else { stable = 0; lastText = text; lastResources = resources; }
      if (stable >= 2 && Date.now() - started >= min) return finish(true);
      if (Date.now() - started >= max) return finish(false);
      setTimeout(tick, 200);
    };
    tick();
  });
}


function __extendPageData(target, base) {
  var inspect = (fn, arg) => base.inspect('(' + fn.toString() + ')(' + JSON.stringify(arg ?? {}) + ')');
  return Object.assign(base, {
    // A request made by the page itself: its cookies, its origin, its CSRF token (csrf: true).
    request: (url, init = {}) => inspect(__pageRequest, typeof url === 'object' ? url : {...init, url}),
    // Re-sends a recorded request (page.network.list) from the page, with optional changes.
    replay: async (id, changes = {}) => {
      var entry = await __call({network: 'get', target, id});
      var headers = {};
      for (var [name, value] of Object.entries(entry.requestHeaders || {})) if (!__replayDropped.test(name)) headers[name] = value;
      var url = new URL(changes.url || entry.url);
      for (var [key, value] of Object.entries(changes.query || {})) url.searchParams.set(key, String(value));
      var request = {url: url.href, method: changes.method || entry.method, headers: {...headers, ...(changes.headers || {})}};
      if (changes.json !== undefined) {
        // No merge with the recording: an omitted field must not be silently replayed.
        request.json = changes.json;
      } else if (changes.body !== undefined) request.body = changes.body;
      return inspect(__pageRequest, request);
    },
    data: (options = {}) => (__noteRead(target), base.inspect('(' + __readPageData.toString() + ')(' + __readMetadata.toString() + ', ' + JSON.stringify(options) + ')')),
    metadata: () => base.inspect('(' + __readMetadata.toString() + ')()'),
    markdown: async (options = {}) => {
      __noteRead(target);
      var result = await inspect(__readMarkdown, options);
      return result.partial
        ? result.markdown + '\\n\\n[PARTIAL: ' + (result.notes.join('; ') || 'read cut') + ']'
        : result.markdown;
    },
    // One read of the page: data, the main repeated list, Markdown and the panels that scroll on
    // their own, merged and capped. It expands "show more" controls and waits for the content to
    // settle; both only here. Everything fits a time budget (timeMs), so a huge page returns what
    // it has instead of running into the cell deadline.
    read: async (options = {}) => {
      __noteRead(target);
      var deadline = Date.now() + Math.max(5000, Number(options.timeMs) || 30000);
      var max = Math.max(2000, Math.min(200000, Number(options.max) || 40000));
      var expanded = options.expand === false
        ? {clicked: [], skipped: []}
        : await inspect(__expandRead, {max: options.maxClicks ?? 10}).catch(() => ({clicked: [], skipped: []}));
      var waited = await inspect(__waitRead, {maxMs: options.waitMs ?? 5000}).catch(() => ({settled: false, partial: true, note: 'the settle wait failed'}));
      var markdown = await inspect(__readMarkdown, {...options, max});
      var data = await base.inspect(
        '(' + __readPageData.toString() + ')(' + __readMetadata.toString() + ', ' + JSON.stringify({...options, summary: options.summary === true}) + ')'
      );
      var list = null, listNote;
      try {
        list = await __collectList(base, options.list || null, {
          max: Math.min(500, Number(options.maxItems) || 200),
          ...(options.maxScrolls ? {maxScrolls: options.maxScrolls} : {}),
          deadline: Math.min(deadline - 8000, Date.now() + 12000),
        });
      } catch (error) {
        listNote = 'no repeated list: ' + String(error && error.message || error).slice(0, 200);
      }
      var scrollers = options.scrollers === false
        ? []
        : await __readScrollers(base, {deadline, maxChars: Math.floor(max / 2)}).catch(() => []);
      // A panel whose text did not grow while scrolling is already in the Markdown.
      var panels = scrollers.filter((panel) => panel.grew).map(({grew, height, view, ...panel}) => panel);
      var notes = [
        ...(expanded.clicked.length ? ['expanded ' + expanded.clicked.length + ' control(s): ' + expanded.clicked.join(', ')] : []),
        ...(markdown.notes || []),
        ...((data && data.notes) || []),
        ...(waited.note ? [waited.note] : []),
        ...(listNote ? [listNote] : []),
      ];
      var partial = !!(markdown.partial || (data && data.partial) || (list && list.partial) || waited.partial || panels.some((panel) => !panel.complete));
      var result = {
        url: await base.inspect(() => location.href),
        title: await base.inspect(() => document.title),
        data,
        list,
        markdown: markdown.markdown,
        ...(panels.length ? {scrollers: panels} : {}),
        wait: waited,
        expand: expanded,
        partial,
        notes,
      };
      var serialized = JSON.stringify(result);
      if (serialized.length > max) {
        var saved = 'page-read-' + new Date().toISOString().replace(/[:.]/g, '-') + '.json';
        var file = await artifact(saved, serialized).catch(() => null);
        var where = (file && file.path) || saved;
        result.partial = true;
        result.artifact = where;
        result.notes.push('the full read (' + serialized.length + ' characters) is saved as ' + where);
        result.data = {partial: true, note: 'data omitted here; the full read is saved as ' + where};
        result.markdown = result.markdown.slice(0, Math.max(500, Math.floor(max * 0.6))) + '\\n\\n[PARTIAL: cut to ' + max + ' characters; full read saved as ' + where + ']';
        if (result.list) result.list = {...result.list, items: result.list.items.slice(0, 30), partial: true, note: 'list cut to 30 items; full read saved as ' + where};
        serialized = JSON.stringify(result);
        if (serialized.length > max) {
          var skeleton = {...result, markdown: '', list: null, data: null, scrollers: undefined};
          var room = Math.max(0, max - JSON.stringify(skeleton).length - 250);
          result.markdown = result.markdown.slice(0, room);
          result.list = null;
          delete result.scrollers;
          result.data = {partial: true, note: 'omitted to keep the read under ' + max + ' characters'};
          result.notes.push('list and data omitted to keep the read under ' + max + ' characters');
        }
      }
      return result;
    },
    status: async () => {
      var status = await base.inspect(() => performance.getEntriesByType('navigation')[0]?.responseStatus ?? null);
      return status === null || status === undefined || status === '' ? null : Number(status);
    },
    // The page's session: every cookie (HttpOnly too) and its web storage.
    session: async (options = {}) => {
      var result = {url: await base.inspect(() => location.href)};
      if (options.cookies !== false) result.cookies = (await base.cdp('Network.getCookies', {urls: [result.url]})).cookies;
      if (options.storage !== false) Object.assign(result, await base.inspect(() => ({
        localStorage: Object.fromEntries(Object.entries(localStorage)),
        sessionStorage: Object.fromEntries(Object.entries(sessionStorage)),
      })));
      return result;
    },
  });
}

var __sleep = (ms) => new Promise((done) => setTimeout(done, ms));

// Works through many URLs (or items with a url) in parallel tabs, reusing each tab. Retries
// failures, backs off when a site answers 429 or 503, and spaces requests to the same host.
async function __pool(items, worker, options = {}) {
  var concurrency = Math.min(Math.max(Number(options.concurrency ?? 4), 1), 10);
  var retries = Math.max(Number(options.retries ?? 2), 0);
  var spacing = Math.max(Number(options.perHostDelayMs ?? 0), 0);
  var queue = items.map((item, index) => ({item, index, attempts: 0}));
  var results = new Array(items.length), lastHit = new Map(), backoff = new Map();
  var urlOf = (item) => typeof item === 'string' ? item : item && item.url;
  async function wait(host) {
    var until = Math.max((lastHit.get(host) ?? 0) + spacing, backoff.get(host) ?? 0);
    lastHit.set(host, Math.max(Date.now(), until));
    if (until > Date.now()) await __sleep(until - Date.now());
  }
  // The runner's tab is stored on 'tab' as soon as it exists, so a failure never leaks it.
  async function attempt(job, tab) {
    var url = urlOf(job.item);
    if (url) {
      await wait(new URL(url).host);
      if (tab.page) await tab.page.goto(url, {present: false});
      else tab.page = await browser.openTab(url, {new: true, present: false});
      var status = await tab.page.status().catch(() => null);
      if (status === 429 || status === 503) {
        var host = new URL(url).host;
        backoff.set(host, Date.now() + Math.min(60000, 2000 * 2 ** job.attempts));
        throw Object.assign(Error('HTTP ' + status + ' from ' + host), {retryable: true});
      }
    } else if (!tab.page) throw Error('Each item needs a url (or be one)');
    return worker(tab.page, job.item, job.index);
  }
  async function runner() {
    var tab = {};
    try {
      while (queue.length) {
        var job = queue.shift();
        try {
          results[job.index] = {ok: true, item: job.item, value: await attempt(job, tab)};
        } catch (error) {
          if (job.attempts++ < retries) { queue.push(job); continue; }
          results[job.index] = {ok: false, item: job.item, error: String(error && error.message || error)};
        }
        if (options.onProgress) options.onProgress(results.filter(Boolean).length, items.length);
      }
    } finally {
      if (tab.page && options.keepTabs !== true) await tab.page.close().catch(() => {});
    }
  }
  await Promise.all(Array.from({length: Math.min(concurrency, items.length)}, runner));
  return results;
}
`;
