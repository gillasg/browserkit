// Sites in browser code: site skills (helpers saved per site), mapped site APIs, and learning
// a site's API while the agent works in it. Evaluated in the code sandbox with the other APIs.
export const browserSitesApi = `
var __skillCache = new Map();
async function __siteSkills(url) {
  var host; try { host = new URL(url).hostname; } catch { return []; }
  var cached = __skillCache.get(host);
  if (cached && Date.now() - cached.at < 60000) return cached.list;
  var list = await __call({siteSkill:'list', url}).catch(() => []);
  __skillCache.set(host, {at: Date.now(), list});
  return list;
}
// Skills on the current site load by themselves, once per chat (again after one is saved), so
// their helpers are defined without the agent having to remember skills.load.
var __loadedSkills = new Map();
async function __autoLoadSkills(url) {
  var known = await __siteSkills(url);
  var lines = [];
  for (var item of known.slice(0, 4)) {
    if (__loadedSkills.has(item.name)) continue;
    try {
      var info = await skills.load(item.name);
      lines.push(item.name + (info.defines.length ? ' (defines ' + info.defines.join(', ') + ')' : '') + ' - ' + item.description.slice(0, 80));
    } catch (error) {
      __loadedSkills.set(item.name, []);
      lines.push(item.name + ' failed to load: ' + String(error && error.message || error).slice(0, 120));
    }
  }
  var notes = '';
  try { notes = String(await __call({siteNotes: url}) || '').trim(); } catch {}
  var parts = [];
  if (lines.length) parts.push('Site skills loaded: ' + lines.join('; '));
  if (notes) parts.push('Site notes for ' + url + ':\\n' + notes.slice(0, 6000));
  return parts.join('\\n\\n');
}
var skills = Object.freeze({
  list: (url) => __call({siteSkill:'list', url: url ?? (__lastTarget ? browser.page(__lastTarget).url : undefined)}),
  load: async (name) => {
    var skill = await __call({siteSkill:'get', name});
    var before = new Set(Object.keys(globalThis));
    // Same rules as a cell: top-level const/let/function persist. A skill whose code returns an
    // object (the function form) has its function members defined as globals.
    var value = await (0, eval)(__repl(skill.code));
    if (value && typeof value === 'object')
      for (var [key, member] of Object.entries(value)) if (typeof member === 'function') globalThis[key] = member;
    var defines = Object.keys(globalThis).filter(key => !before.has(key) && typeof globalThis[key] === 'function');
    __loadedSkills.set(skill.name, defines);
    return {name: skill.name, domains: skill.domains, description: skill.description, examples: skill.examples, defines};
  },
  save: async (skill) => {
    // The function form: its body runs on load, and the object it returns becomes globals.
    var code = typeof skill.code === 'function' ? 'return await (' + skill.code.toString() + ')()' : skill.code;
    var saved = await __call({siteSkill:'save', skill: {...skill, code}});
    __skillCache.clear();
    __loadedSkills.delete(saved.saved);
    return saved;
  },
  remove: async (name) => { __skillCache.clear(); __loadedSkills.delete(name); return __call({siteSkill:'delete', name}); },
});
// Mapped site APIs (site-to-api): call an operation, or watch it for items new or changed since the last watch.
// write repeats a routine write the page has proven; batch runs one over many items, paced.
// Every method takes the site first, or one object: siteMapper.call('a.com', 'op', {q}) and
// siteMapper.call({site: 'a.com', operation: 'op', params: {q}}) are the same call.
var __siteObject = value => value && typeof value === 'object' && !Array.isArray(value) ? value : undefined;
var siteMapper=Object.freeze({
  code:async (url,options={})=>{
    var value=await __call({siteMapper:'code',url:String(url),options});
    var encoded=JSON.stringify(value);
    if (encoded.length > 60000) {
      var host='site'; try { host=new URL(String(url)).hostname.replace(/^www\\./,''); } catch {}
      var saved=await artifact('site-code/'+host+'.json', encoded).catch(() => undefined);
      if (saved) return {summary:value.summary || 'Site code output saved', artifact:saved.path, routes:value.routes?.length || 0, files:value.files?.length || 0, matches:value.matches?.length || 0};
    }
    return value;
  },
  sites:()=>__call({siteMapper:'sites'}),
  operations:site=>__call({siteMapper:'operations', ...(__siteObject(site) || {site})}),
  call:(site,operation,params={})=>__call({siteMapper:'call', ...(__siteObject(site) || {site,operation,params})}),
  undo:(site,operation,params={})=>__call({siteMapper:'undo', ...(__siteObject(site) || {site,operation,params})}),
  write:(site,operation,params={})=>__call({siteMapper:'write', ...(__siteObject(site) || {site,operation,params})}),
  batch:(site,operation,items,options={})=>{
    var one = __siteObject(site);
    return one ? __writeBatch(one.site, one.operation, one.items, one.options || one) : __writeBatch(site,operation,items,options);
  },
  watch:(site,operation,params={},options={})=>__call({siteMapper:'watch', ...(__siteObject(site) || {site,operation,params,...options})}),
  action:(site,name,inputs={})=>__call({siteMapper:'action', ...(__siteObject(site) || {site,name,params:inputs})}),
  channel:(site,id,options={})=>__call({siteMapper:'channel', ...(__siteObject(site) || {site,name:id,params:options})}),
});
// Site pack tools: callable helpers saved with the site. Node tools run through the host; page
// tools run here in the page with the current document. Only the current host's tools resolve.
function __siteToolTarget() {
  if (!__lastTarget) throw Error('NO_TAB: open a tab before using site tools');
  return __lastTarget;
}
async function __siteToolHost() {
  var url = String(browser.page(__siteToolTarget()).url);
  return {url, host: new URL(url).hostname.replace(/^www\./, '')};
}
function __siteToolGroup(kind) {
  return new Proxy({}, {
    get: (_target, name) => {
      if (typeof name !== 'string') return undefined;
      if (name === 'list')
        return async () => (await __call({siteTool: {action: 'list', ...(await __siteToolHost())}}));
      return async (args = {}) => {
        var where = await __siteToolHost();
        if (kind === 'tool') return __call({siteTool: {action: 'run', url: where.url, name, args}});
        var tool = await __call({siteTool: {action: 'page', url: where.url, name}});
        return browser.page(__siteToolTarget()).inspect('(' + tool.code + ')(' + JSON.stringify(args) + ')');
      };
    },
  });
}
// One entry point for what already exists on a site: mapped operations, recipes, flows, site
// tools, learned notes, site skills and WebMCP tools. Reads sort before writes.
var __siteCapabilities = async (host) => {
  var url = host ? (/^https?:/.test(host) ? host : 'https://' + host) : (__lastTarget ? String(await browser.page(__lastTarget).url()) : '');
  var siteName = host || (url ? new URL(url).hostname.replace(/^www\\./, '') : '');
  if (!siteName) throw Error('SITE_UNKNOWN: pass a site or open a tab first');
  var base = await __call({siteCapabilities: {host: siteName}});
  var webmcp = __lastTarget ? await browser.page(__lastTarget).webmcp.list().catch(() => ({tools: []})) : {tools: []};
  return {
    site: siteName,
    abilities: Array.isArray(base && base.abilities) ? base.abilities : [],
    operations: Array.isArray(base && base.operations) ? base.operations : [],
    notes: String((base && base.notes) || ''),
    webmcp: (webmcp && webmcp.tools) || [],
  };
};
var __siteHostName = async (site) => {
  if (site) {
    var text = String(site);
    if (/^https?:/.test(text)) return new URL(text).hostname.replace(/^www\\./, '');
    return text.replace(/^www\\./, '').split('/')[0];
  }
  if (!__lastTarget) throw Error('SITE_UNKNOWN: pass a site or open a tab first');
  return new URL(String(await browser.page(__lastTarget).url())).hostname.replace(/^www\\./, '');
};
// Saves an ability for the current site (or spec.site). A script way may be a function; a
// demonstration's skill ({name, code}) is saved as a page-script ability.
var __saveAbility = async (spec = {}) => {
  var value = {...spec};
  value.site = await __siteHostName(value.site || (Array.isArray(value.domains) ? value.domains[0] : undefined));
  var source = (code) => typeof code === 'function' ? code.toString() : code;
  if (Array.isArray(value.ways)) value.ways = value.ways.map(way => way && way.kind === 'script' ? {...way, code: source(way.code)} : way);
  if (value.code) value.code = source(value.code);
  return __call({abilitySave: value});
};
var saveAbility = __saveAbility;
var __siteAbilities = {
  run: async (name, inputs = {}, options = {}) => __call({abilityRun: {site: await __siteHostName(options.site), name, inputs, ...(options.via ? {via: options.via} : {}), ...(options.key ? {key: String(options.key)} : {}), ...(options.limit ? {limit: Number(options.limit)} : {}), ...(options.cursor ? {cursor: String(options.cursor)} : {})}}),
  test: async (name, site) => __call({abilityRun: {site: await __siteHostName(site), name, test: true}}),
  list: async (site) => __call({abilityList: {site: await __siteHostName(site)}}),
  notes: async (site) => __call({siteNotes: await __siteHostName(site)}),
};
var __siteBase = {tools: __siteToolGroup('tool'), pageTools: __siteToolGroup('pageTool'), capabilities: __siteCapabilities, run: __siteAbilities.run, test: __siteAbilities.test, save: __saveAbility, list: __siteAbilities.list, notes: __siteAbilities.notes};
var site = Object.freeze(new Proxy(__siteBase, {
  get: (target, name) => {
    if (typeof name !== 'string' || name in target) return target[name];
    if (name === 'then' || name === 'toJSON' || name === 'inspect') return undefined;
    return async (inputs = {}, options = {}) => target.run(name, inputs, options);
  },
}));
// Saved reads: a page whose content the agent read this cell (page.data, page.markdown,
// page.table) has its visible text saved after the cell, so when the user comes back to it the
// page can show what changed since. The same text the page itself compares against.
var __readTargets = new Map();
function __noteRead(target) { if (target) __readTargets.set(__key(target), target); }
var __pageText = '(() => { var root = document.querySelector("main, [role=main]") || document.body; return {url: location.href, text: root ? root.innerText : ""}; })()';
async function __saveReads() {
  for (var target of [...__readTargets.values()]) {
    try {
      var page = await __call({op: 'evaluate', target, expression: __pageText});
      var value = page && page.data && page.data.value;
      if (value && value.text) await __call({savedRead: {url: value.url, text: String(value.text).slice(0, 400000)}});
    } catch {}
  }
  __readTargets.clear();
}
// Learning a site's API while working. Every tab the agent acts in records the site's own
// requests (passively: no trackers, no cookies, no passwords); after each cell they are tagged
// with the page step that sent them and built into the site's API at once (no model). New
// operations are announced once per chat, in the cell's output.
var __learning = new Set(), __actions = [], __announced = new Set(), __learnTouched = new Map(), __handedOff = false;
var __wallNoted = new Set();
/** One suggestion per endpoint per chat after repeated refusals; never a stop. */
async function __wallNote() {
  for (var target of [...__learnTouched.values()]) {
    var list;
    try { list = await __call({network: 'failures', target}); } catch { continue; }
    for (var item of list || []) {
      if (!item || item.attempts < 3) continue;
      var statuses = item.statuses || [];
      if (!statuses.some(s => s === 403 || s === 429 || s >= 500)) continue;
      var key = item.method + ' ' + item.path;
      if (__wallNoted.has(key)) continue;
      __wallNoted.add(key);
      var size = item.lastSuccess && item.lastSuccess.requestBytes ? ' Last success: ' + item.lastSuccess.requestBytes + ' B.' : '';
      console.log('Note: ' + key + ' has refused ' + item.attempts + ' attempts (' + statuses.join('/') + ').' + size + ' page.network.failures() has the details. If this is a site-side block, reporting it may be better than more attempts.');
    }
  }
}
async function __learnOn(target, step) {
  var key = __key(target);
  __learnTouched.set(key, target);
  if (step) {
    __actions.push({at: Date.now(), key, label: __stepLabel(step)});
    if (__actions.length > 60) __actions.shift();
  }
  if (__learning.has(key)) return;
  __learning.add(key);
  await __call({network: 'learn-start', target}).catch(() => {});
}
// 'click "Remove from Watch later"', 'fill "Search"', 'press Enter', 'open https://…'.
function __stepLabel(step) {
  var element = step.element || {}, name;
  if (element.kind === 'backend' || element.kind === 'ref') {
    var state = __states.get(__key(step.target));
    var node = state && state.nodes.find(n => n.backendNodeId === element.backendNodeId || (element.ref && n.ref === element.ref));
    name = node && node.name;
  } else name = element.name || element.value || element.text;
  if (step.op === 'navigate') return 'open ' + String(step.url || '').slice(0, 120);
  var quoted = name ? ' "' + String(name).replace(/"/g, "'").slice(0, 60) + '"' : '';
  if (step.op === 'keys' || step.op === 'press') return 'press ' + (step.keys || step.key || '') + (quoted ? ' in' + quoted : '');
  return step.op + quoted;
}
async function __learnFromCell() {
  var lines = [], approved = __handedOff;
  __handedOff = false;
  for (var target of [...__learnTouched.values()]) {
    try {
      var har = await __call({network: 'take', target});
      var entries = (har && har.log && har.log.entries) || [];
      if (!entries.length) continue;
      var key = __key(target);
      for (var entry of entries) {
        var at = Date.parse(entry.startedDateTime);
        var cause = __actions.filter(a => a.key === key && a.at <= at + 50 && at - a.at < 15000).pop();
        if (cause) entry._step = cause.label;
      }
      var url = (__tabs.get(key) && __tabs.get(key).url) || entries[0].request.url;
      var result = await __call({siteMapper: 'learn-live', site: new URL(String(url)).hostname, har, approved});
      for (var op of (result && result.learned) || []) {
        // Only operations this cell's own actions caused (or a write it proved): unrelated
        // page-load requests (a checkout widget, an animation JSON) stay in siteMapper.operations.
        if (!op.related && !op.proven) continue;
        var seen = result.site + '|' + op.id + '|' + (op.proven ? 'proven' : '');
        if (__announced.has(seen)) continue;
        __announced.add(seen);
        lines.push(__learnedLine(result.site, op));
        __siteFacts.delete(result.site);
      }
    } catch {}
  }
  __learnTouched.clear();
  if (!lines.length) return;
  var shown = lines.slice(0, 3);
  if (lines.length > 3) shown.push('(+' + (lines.length - 3) + ' more: siteMapper.operations(site))');
  console.log(shown.join('\\n'));
}
function __learnedLine(site, op) {
  var what = op.role === 'read' ? 'read' : op.proven ? 'write, proven by ' + (op.step || 'the page') : op.kind === 'consequential' ? 'write that stays in the page' : 'write';
  var text = 'Learned on ' + site + ': ' + op.id + ' (' + what + '). ' + op.how;
  if (op.varies && op.varies.length) text += '. Per item: ' + op.varies.join('; ');
  return text;
}
// One write over many items: paced (3 a second unless told), the first checked with
// options.verify(result, item) when given, stopping at the first error or rate limit. What is
// left continues in the page, and that run repairs the operation.
async function __writeBatch(site, operation, items, options = {}) {
  if (!Array.isArray(items)) throw Error('siteMapper.batch(site, operation, items): items is an array of params objects');
  var gap = 1000 / Math.max(0.2, Math.min(10, Number(options.perSecond) || 3));
  var label = options.label || operation, results = [], stopped;
  bu.progress(0, items.length, label);
  for (var index = 0; index < items.length; index++) {
    var started = Date.now();
    try {
      var value = await siteMapper.write(site, operation, items[index]);
      if (index === 0 && typeof options.verify === 'function' && !(await options.verify(value, items[0])))
        throw Error('the first write did not do what the page does (verify returned false)');
      results.push({ok: true});
    } catch (error) {
      stopped = {index, item: items[index], error: String(error && error.message || error).slice(0, 300)};
      break;
    }
    bu.progress(index + 1, items.length, label);
    var wait = gap - (Date.now() - started);
    if (wait > 0 && index < items.length - 1) await new Promise(resolve => setTimeout(resolve, wait));
  }
  var done = results.length, remaining = items.slice(done);
  console.log('[batch] ' + operation + ': ' + done + '/' + items.length + ' done' + (stopped ? '; stopped at item ' + (stopped.index + 1) + ': ' + stopped.error + '. Do the remaining ' + remaining.length + ' in the page; that repairs the operation.' : ''));
  return {done, total: items.length, ...(stopped ? {stopped, remaining} : {})};
}
`;
