// Job and media helpers are separate pieces of the browser_code API string; all of them are
// evaluated together, so the objects below can call them by name at use time.
export const browserMediaApi = `
var __job = (items, fn, options = {}) => __call({job:{action:'start', items,
  fn: typeof fn === 'function' ? fn.toString() : String(fn), options}});
__job.status = (id) => __call({job:{action:'status', id:String(id)}});
__job.cancel = (id) => __call({job:{action:'cancel', id:String(id)}});
__job.resume = (id) => __call({job:{action:'resume', id:String(id)}});
__job.list = () => __call({job:{action:'list'}});
// Bulk "open, get past the gate, wait, capture, read, close". A mode of the durable job runtime:
// {jobId, total} at once, or the finished {results, summary} when pilot/wait asks it to block.
var __sweep = async (urls, options = {}) => {
  var items = (Array.isArray(urls) ? urls : [urls]).filter(Boolean).slice(0, 500);
  if (!items.length) throw Error('browser.sweep needs at least one url');
  var pilot = Math.max(0, Math.min(Number(options.pilot) || 0, items.length));
  if (pilot) options = {...options, pilot};
  var start = await __call({job:{action:'start', mode:'sweep', items: pilot ? items.slice(0, pilot) : items, options}});
  if (!pilot && options.wait !== true) {
    console.log('[ok] sweep ' + start.jobId + ' started for ' + start.total + ' urls; browser.job.status("' + start.jobId + '") or browser.sweep.result("' + start.jobId + '")');
    return start;
  }
  var deadline = Date.now() + Math.min(600000, start.total * (Number(options.timeoutMs) || 45000) + 60000);
  while (Date.now() < deadline) {
    var state = await __call({job:{action:'status', id:start.jobId}});
    if (state.status !== 'running') break;
    await __sleep(1000);
  }
  return await __call({job:{action:'result', id:start.jobId}});
};
__sweep.result = (id) => browser.job.result(id);
__sweep.status = (id) => browser.job.status(id);
__sweep.cancel = (id) => browser.job.cancel(id);
__sweep.resume = (id) => browser.job.resume(id);
__job.result = async (id) => {
  var result = await __call({job:{action:'result', id:String(id)}});
  if (result && result.status === 'complete' && !result.artifact) {
    try {
      var saved = await artifact('jobs/' + id + '.json', JSON.stringify(result));
      await __call({job:{action:'artifact', id:String(id), path:saved.path}}).catch(() => undefined);
      result.artifact = saved.path;
    } catch (error) {
      result.artifactError = String(error && error.message || error);
    }
  }
  return result;
};
function __isMediaUrl(value) {
  var text = String(value);
  return text.startsWith('http://') || text.startsWith('https://') || text.startsWith('data:') || text.startsWith('blob:');
}
// What an element shows: its source, link, canvas pixels or background image (blob: and data: as data).
async function __mediaSources(args) {
  var roots = [document], found = [];
  while (roots.length) { var root = roots.pop(); found.push(...root.querySelectorAll(args.selector)); for (var el of root.querySelectorAll('*')) if (el.shadowRoot) roots.push(el.shadowRoot); }
  var picked = args.all ? found : found.slice(0, 1), out = [];
  var asData = async (url) => { var blob = await (await fetch(url)).blob(); return await new Promise((done) => { var reader = new FileReader(); reader.onload = () => done(reader.result); reader.readAsDataURL(blob); }); };
  for (var item of picked) {
    var url = '';
    if (item instanceof HTMLCanvasElement) url = item.toDataURL('image/png');
    else url = item.currentSrc || item.src || item.poster || item.href || '';
    if (!url) {
      var bg = getComputedStyle(item).backgroundImage || '', start = bg.indexOf('url(');
      if (start >= 0) url = bg.slice(start + 4, bg.indexOf(')', start)).split('"').join('').split("'").join('');
    }
    if (!url) continue;
    url = new URL(url, location.href).href;
    out.push(url.startsWith('blob:') ? {url, data: await asData(url)} : {url});
  }
  return out;
}
function __mediaName(url, mime, index, options) {
  var base = 'file';
  try { base = decodeURIComponent(new URL(url).pathname.split('/').filter(Boolean).pop() || 'file'); } catch {}
  base = base.split('?')[0].replace(/[^A-Za-z0-9._-]+/g, '-').slice(-80) || 'file';
  var ext = (String(mime || '').split('/')[1] || '').split(';')[0].split('+')[0];
  if (ext === 'jpeg') ext = 'jpg';
  if (ext && !base.toLowerCase().endsWith('.' + ext) && base.indexOf('.') < 0) base += '.' + ext;
  if (options.name) {
    var dot = options.name.lastIndexOf('.');
    base = !index ? options.name : dot > 0 ? options.name.slice(0, dot) + '-' + index + options.name.slice(dot) : options.name + '-' + index;
  }
  return (options.folder || 'media') + '/' + base;
}
async function __saveMedia(target, what, options = {}) {
  var page = browser.page(target);
  var sources = __isMediaUrl(what) ? [{url: String(what)}] : await page.evaluate(__mediaSources, {selector: String(what), all: !!options.all});
  if (!sources.length) throw Error('NOT_FOUND: nothing to save for ' + what);
  var saved = [];
  for (var [index, source] of sources.entries()) {
    var data = source.data || (source.url.startsWith('data:') ? source.url : '');
    var mime, base64, bytes;
    if (data) {
      var comma = data.indexOf(',');
      mime = data.slice(5, comma).split(';')[0];
      base64 = data.slice(5, comma).includes(';base64') ? data.slice(comma + 1) : btoa(decodeURIComponent(data.slice(comma + 1)));
      bytes = Math.floor(base64.length * 3 / 4);
    } else {
      var response = await browser.fetch(source.url, {as: 'base64'});
      if (!response.ok) throw Error('DOWNLOAD_FAILED: ' + response.status + ' ' + source.url);
      if (response.truncated) throw Error('TOO_LARGE: ' + response.bytes + ' bytes at ' + source.url);
      mime = response.headers['content-type'];
      base64 = response.base64;
      bytes = response.bytes;
    }
    var name = __mediaName(source.url, mime, index, options);
    await __call({workspace:'artifact', name, value: base64, base64: true});
    saved.push({saved: name, url: source.url.startsWith('data:') ? 'data:' : source.url, mime, bytes});
  }
  return saved;
}
// Forget a tab closed through browser.closeTab, so a later openTab does not try to reuse it.
function __forgetTab(tabId) {
  for (var [key, entry] of [...__tabs])
    if (entry.target?.tabId === tabId) {
      __tabs.delete(key);
      __states.delete(key);
      __dirty.delete(key);
    }
  // Keep __opened: a later openTab without {newTab:true} must say the tab was closed instead of
  // silently opening a new one.
  __keptTabs.delete(tabId);
  if (__lastTarget?.tabId === tabId) __lastTarget = undefined;
  if (__attachedTarget?.tabId === tabId) __attachedTarget = undefined;
}
`;
