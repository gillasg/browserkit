// Media and bot checks in browser code: page.media.inspect (what is playing), page.challenges
// (bot checks, captchas, blocks and sign-in walls, also noted in bu.state), bu.handoff's wait
// for a check to clear, and the page's WebMCP tools. Page-side functions are self-contained.

export const browserMediaChallengesApi = `
// Page-side: every video and audio element, playing first, with the page's media session.
function __pageMedia() {
  var roots = [document], els = [];
  while (roots.length) {
    var root = roots.shift();
    els.push(...root.querySelectorAll('video,audio'));
    for (var el of root.querySelectorAll('*')) if (el.shadowRoot) roots.push(el.shadowRoot);
  }
  var clock = (s) => {
    if (s === Infinity) return 'live';
    if (!isFinite(s)) return '?';
    s = Math.floor(s);
    var h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), rest = String(s % 60).padStart(2, '0');
    return h ? h + ':' + String(m).padStart(2, '0') + ':' + rest : m + ':' + rest;
  };
  var media = els.map((el) => {
    var r = el.getBoundingClientRect();
    return {kind: el.tagName.toLowerCase(), playing: !el.paused && !el.ended && el.readyState > 2, paused: el.paused, ended: el.ended,
      at: clock(el.currentTime) + ' / ' + clock(el.duration), currentTime: Math.round(el.currentTime * 10) / 10,
      duration: isFinite(el.duration) ? Math.round(el.duration * 10) / 10 : null, muted: el.muted, volume: Math.round(el.volume * 100) / 100,
      rate: el.playbackRate, visible: r.width > 0 && r.height > 0, size: Math.round(r.width) + 'x' + Math.round(r.height),
      src: String(el.currentSrc || el.src || '').slice(0, 200), ...(el.getAttribute('aria-label') || el.title ? {label: el.getAttribute('aria-label') || el.title} : {})};
  });
  media.sort((a, b) => Number(b.playing) - Number(a.playing) || Number(b.visible) - Number(a.visible));
  var meta = navigator.mediaSession && navigator.mediaSession.metadata;
  return {title: document.title, ...(meta ? {session: {title: meta.title, artist: meta.artist, album: meta.album, state: navigator.mediaSession.playbackState}} : {}), media: media.slice(0, 20)};
}
async function __mediaManifest(target) {
  for (var [extension, kind] of [['.m3u8', 'hls'], ['.mpd', 'dash']]) {
    var entries = await __call({network:'list', target, match: extension}).catch(() => []);
    var hit = entries.find((entry) => String(entry.url || '').toLowerCase().includes(extension));
    if (!hit) continue;
    var full = await __call({network:'get', target, id:hit.id}).catch(() => undefined);
    return {
      kind,
      url: (full && full.url) || hit.url,
      mimeType: (full && full.mimeType) || hit.mimeType || null,
      requestHeaders: (full && full.requestHeaders) || {},
      responseHeaders: (full && full.responseHeaders) || {},
    };
  }
  return null;
}
async function __mediaInspect(target) {
  var result = await browser.page(target).inspect(__pageMedia);
  // Embedded players (YouTube, Vimeo, Spotify) play inside their own iframe.
  for (var frame of await __otherFrames(target)) {
    var inFrame = await frame.evaluate(__pageMedia).catch(() => null);
    if (inFrame && inFrame.media.length) result.media.push(...inFrame.media.map((m) => ({...m, frame: String(frame.url).slice(0, 120), frameTitle: inFrame.title})));
  }
  result.media.sort((a, b) => Number(b.playing) - Number(a.playing) || Number(b.visible) - Number(a.visible));
  var first = result.media[0], name = (result.session && result.session.title) || (first && first.frameTitle) || result.title;
  result.summary = first && first.playing ? 'playing ' + first.kind + ' ' + first.at + (first.muted ? ' (muted)' : '') + ': ' + name
    : first ? 'nothing playing (' + first.kind + ' ' + (first.ended ? 'ended' : 'paused') + ' at ' + first.at + ')' : 'no video or audio on the page';
  return result;
}

// Page-side: bot checks, captchas, blocks, rate limits and sign-in walls on the page.
function __pageChallenge() {
  var title = document.title || '', body = document.body ? String(document.body.innerText || '').slice(0, 4000) : '';
  var short = body.length < 2500, head = title + ' ' + body.slice(0, 400);
  var shown = (el) => { var r = el.getBoundingClientRect(); return r.width > 30 && r.height > 30 && getComputedStyle(el).visibility !== 'hidden'; };
  var frames = [...document.querySelectorAll('iframe')].filter(shown).map((f) => f.src || '');
  var frame = (pattern) => frames.find((src) => pattern.test(src) && !/size=invisible/.test(src));
  var has = (selector) => Boolean(document.querySelector(selector));
  var found = [], add = (kind, provider, evidence) => found.push({kind, provider, evidence: String(evidence).slice(0, 100)});
  if (/just a moment|attention required|checking your browser/i.test(title) || has('#challenge-form,#cf-challenge-running,#challenge-stage') ||
      (short && /verify you are human|checking if the site connection is secure/i.test(body))) add('bot-check', 'Cloudflare', title || 'challenge page');
  else if (frame(/challenges\\.cloudflare\\.com/)) add('captcha', 'Cloudflare Turnstile', 'Turnstile widget');
  if (frame(/captcha-delivery\\.com/)) add('captcha', 'DataDome', 'DataDome check');
  if (has('#px-captcha') || (short && /press (&|and) hold/i.test(body))) add('captcha', 'PerimeterX', 'press-and-hold check');
  if (has('input[name="g-recaptcha-response"],textarea[name="g-recaptcha-response"],input[name="h-captcha-response"],textarea[name="h-captcha-response"],input[name="cf-turnstile-response"]') || has('[role=checkbox][aria-label*="verify" i],[role=checkbox][aria-label*="robot" i]')) add('captcha', 'reCAPTCHA', 'checkbox');
  if (frame(/recaptcha\\/(api2|enterprise)\\/bframe/)) add('captcha', 'reCAPTCHA', 'image challenge open');
  else if (frame(/recaptcha\\/(api2|enterprise)\\/anchor/)) add('captcha', 'reCAPTCHA', 'checkbox');
  if (frame(/hcaptcha\\.com/)) add('captcha', 'hCaptcha', 'hCaptcha widget');
  if (frame(/arkoselabs|funcaptcha/)) add('captcha', 'Arkose', 'puzzle');
  if (location.pathname.startsWith('/sorry/') || /unusual traffic from your computer/i.test(body)) add('bot-check', 'Google', 'unusual traffic page');
  if (/access denied/i.test(title) && /reference ?#|edgesuite/i.test(body)) add('blocked', 'Akamai', 'Access Denied with a reference number');
  else if (short && /you have been blocked|request (was )?blocked|access (to this page )?(has been )?denied|403 forbidden/i.test(head)) add('blocked', location.hostname, title || body.slice(0, 80));
  if (short && /too many requests|rate limit(ed)?|error 429/i.test(head)) add('rate-limit', location.hostname, title || body.slice(0, 80));
  var password = [...document.querySelectorAll('input[type=password]')].some(shown);
  if (password && (/(log|sign)[-_]?in|auth|session/i.test(location.pathname + location.search) || /sign in|log in|login/i.test(title))) add('login', location.hostname, 'sign-in form');
  return found;
}
var __CHALLENGE_ADVICE = {
  'bot-check': 'It often clears by itself: wait a few seconds once. If it stays, bu.handoff() so the user can pass it; never retry in a loop.',
  captcha: 'A check for people: bu.handoff(message, {wait: true}) asks the user and continues once it is gone. Never solve or click through it yourself.',
  blocked: 'The site refused this request; repeating it will not help. Use another route (its API, another source) or tell the user.',
  'rate-limit': 'Slow down: wait before the next request and stop parallel requests to this site.',
  login: 'The user is signed out here: await bu.signIn() signs in with their password manager (it returns {signedIn, reason}); if it cannot (reason NO_PASSWORD_MANAGER, NO_SAVED_LOGIN, NEEDS_CODE, CAPTCHA), bu.handoff("Please sign in") and continue after.',
};
var __challengeSeen = new Set();
async function __challenges(target) {
  var found = await browser.page(target).inspect(__pageChallenge).catch(() => []);
  return (found || []).map((c) => ({...c, advice: __CHALLENGE_ADVICE[c.kind]}));
}
// bu.handoff(message, {wait: true}): the user passes a bot check or captcha in the tab and the
// cell carries on by itself once the check is gone (or they click Done), with no new message.
// Without a check on the page it is a plain hand-off that ends on Done.
async function __handoffUntilClear(message, target, options) {
  var started = Date.now(), limit = Math.min(Number(options.timeoutMs) || 600000, 1800000);
  var present = (await __challenges(target).catch(() => [])).length > 0;
  var handle = await bu.handoff(message, {target, selector: options.selector, start: true});
  var outcome = null;
  var waiting = handle.wait().then(() => { outcome = outcome || 'done'; }, () => { outcome = outcome || 'cancelled'; });
  while (!outcome && Date.now() - started < limit) {
    await new Promise((done) => setTimeout(done, 2000));
    if (outcome || !present) continue;
    var left = await __challenges(target).catch(() => null);
    if (left && !left.length) outcome = 'cleared';
  }
  if (!outcome) outcome = 'timeout';
  if (outcome === 'cleared' || outcome === 'timeout') await handle.cancel().catch(() => {});
  await Promise.race([waiting, new Promise((done) => setTimeout(done, 3000))]);
  __states.delete(__key(target));
  return {solved: outcome === 'cleared' || outcome === 'done', by: outcome, waitedMs: Date.now() - started};
}
// After openTab or goto: a page that loaded as a bot check or captcha says so at once, so a
// challenge is never read as the page itself.
async function __noteChallenge(target, url) {
  var note = await __challengeNote(target, url, 'open').catch(() => '');
  if (note) console.log('[warn] ' + note.split('\\n').join('\\n[warn] ') + ' (or bu.handoff(message, {wait: true}) and continue when it clears)');
}
// A line for bu.state (and one for opening the page), once per page and kind.
async function __challengeNote(target, url, scope = 'state') {
  var found = await __challenges(target), lines = [];
  for (var c of found) {
    var key = scope + '|' + __key(target) + '|' + String(url).split('#')[0] + '|' + c.kind + '|' + c.provider;
    if (__challengeSeen.has(key)) continue;
    __challengeSeen.add(key);
    lines.push('challenge: ' + c.kind + ' (' + c.provider + ', ' + c.evidence + '). ' + c.advice);
  }
  if (__challengeSeen.size > 200) __challengeSeen.clear();
  return lines.join('\\n');
}
async function __pageWebmcpList() {
  var ctx = navigator.modelContext || document.modelContext;
  if (!ctx || typeof ctx.getTools !== "function") return {available: false, tools: [], note: "this page registers no WebMCP tools"};
  var tools = await Promise.resolve(typeof ctx.getTools === "function" ? ctx.getTools() : []).catch(() => []);
  var listed = (tools || []).filter((tool) => !tool.window || tool.window === window);\n  if (!listed.length) return {available: false, tools: [], note: "this page registers no WebMCP tools"};\n  return {available: true, tools: listed.slice(0, 100).map((tool) => ({name: String(tool.name || "").slice(0, 120), description: String(tool.description || "").slice(0, 1000)}))};
}
async function __pageWebmcpCall(arg) {
  var ctx = navigator.modelContext || document.modelContext;
  if (!ctx || typeof ctx.getTools !== "function") return {available: false, tools: [], note: "this page registers no WebMCP tools"};
  var tools = await Promise.resolve(typeof ctx.getTools === "function" ? ctx.getTools() : []).catch(() => []);
  var tool = (tools || []).find((item) => item.name === arg.name && (!item.window || item.window === window));
  if (!tool) return {available: true, error: "tool not found"};
  var run = typeof ctx.executeTool === "function" ? ctx.executeTool(tool, JSON.stringify(arg.input || {})) : typeof ctx.invokeTool === "function" ? ctx.invokeTool(arg.name, arg.input || {}) : Promise.reject(new Error("no executeTool"));
  var timeout = new Promise((resolve) => setTimeout(() => resolve({error: "webmcp timeout"}), 4000));
  return {available: true, result: await Promise.race([Promise.resolve(run), timeout])};
}
function __extendPageControls(target, base) {
  return Object.assign(base, {
    controls: Object.freeze({
      // Form fields with label, value, options, checked, min/max, required, disabled, invalid, group, frame.
      inspect: (options = {}) => __controlsList(target, options),
      // Fields plus buttons, links, tabs and menu items; {query} narrows by text.
      directory: (options = {}) => __controlsList(target, {...(typeof options === 'string' ? {query: options} : options), actions: true}),
    }),
    batch: (steps, options = {}) => __batch(target, steps, options),
    overlays: Object.freeze({dismiss: (options = {}) => __dismissOverlays(target, options)}),
    // Age, terms, region and "click to enter" gates, besides cookies: click the affirmative
    // control, return {gate, clicked}.
    enterSite: (options = {}) => __enterSite(target, options),
    // page.media() returns every manifest this tab (and its frames/workers) requested, parsed:
    // {masters: [{url, variants: [{width, height, bandwidth, codecs, url}]}], playlists, headers}.
    media: Object.assign(async (options = {}) => __call({media:{target, ...options}}), {
      inspect: () => __mediaInspect(target),
      // The first HLS (.m3u8) or DASH (.mpd) manifest this tab requested, with its headers.
      manifest: () => __mediaManifest(target),
    }),
    challenges: async () => __challenges(target),
    webmcp: Object.freeze({
      list: () => browser.page(target).inspect(__pageWebmcpList),
      call: (name, input = {}) => browser.page(target).inspect(__pageWebmcpCall, {name, input}),
    }),
  });
}
`;
