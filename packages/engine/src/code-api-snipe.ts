// browser.snipe(): act at an exact moment (a drop, a ticket or booking release, a slot opening).
// It is a durable job: the tab is opened and warmed ahead (prepare can fill the form), the action
// fires on the millisecond, and it retries until done(page, result) says it worked or the window
// closes. Evaluated in the code sandbox with the other APIs; the runner travels to the job as text.
export const browserSnipeApi = `
async function __snipeRunner(page, item) {
  var make = (source) => source ? eval('(' + source + ')') : null;
  var prepare = make(item.prepare), fire = make(item.fire), done = make(item.done);
  var now = () => Date.now() + (item.offset || 0);
  var nap = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
  if (item.url) await page.goto(item.url);
  // Reload a minute before so the page and its session are fresh, then prepare (fill the form).
  if (item.url && item.at - now() > 90000) { await nap(item.at - now() - 60000); await page.reload().catch(() => undefined); }
  if (prepare) await prepare(page);
  if (item.at - now() > 1500) await nap(item.at - now() - 1000);
  while (now() < item.at) await nap(Math.min(4, item.at - now()));
  var firstAt = now(), attempts = 0, last;
  while (attempts === 0 || now() < item.until) {
    attempts++;
    try {
      last = await fire(page, attempts);
      if (!done || await done(page, last))
        return {ok: true, attempts, firedAt: new Date(firstAt).toISOString(), lateMs: firstAt - item.at, result: last};
    } catch (error) { last = {error: String(error && error.message || error)}; }
    await nap(item.retryMs);
    if (item.reloadEach) { await page.reload().catch(() => undefined); if (prepare) await prepare(page).catch(() => undefined); }
  }
  return {ok: false, attempts, firedAt: new Date(firstAt).toISOString(), lateMs: firstAt - item.at, last};
}
// The site's clock against ours, from its Date header (to the second), when asked to sync.
async function __snipeOffset(url) {
  try {
    var sent = Date.now();
    var response = await browser.fetch(url, {method: 'HEAD', as: 'text'});
    var header = response.headers && (response.headers.date || response.headers.Date);
    var server = Date.parse(header);
    return Number.isFinite(server) ? server + 500 - (sent + Date.now()) / 2 : 0;
  } catch { return 0; }
}
async function __snipe(options = {}) {
  var at = typeof options.at === 'number' ? options.at : Date.parse(options.at);
  if (!Number.isFinite(at)) throw Error('INVALID_ARGUMENT: browser.snipe needs at: an ISO time or epoch ms');
  if (typeof options.fire !== 'function') throw Error('INVALID_ARGUMENT: browser.snipe needs fire: async (page, attempt) => …');
  if (at - Date.now() > 55 * 60000) throw Error('TOO_EARLY: browser.snipe starts at most 55 minutes ahead; for later, create a routine with schedule {kind: "once", atUtc: a few minutes before} that calls it');
  var windowMs = Math.min(Math.max(Number(options.windowMs ?? 120000), 1000), 30 * 60000);
  var offset = options.syncClock && options.url ? await __snipeOffset(options.url) : 0;
  var item = {at, until: at + windowMs, url: options.url || '', offset,
    retryMs: Math.max(50, Number(options.retryMs ?? 500)), reloadEach: options.reloadEach === true,
    fire: options.fire.toString(),
    prepare: typeof options.prepare === 'function' ? options.prepare.toString() : '',
    done: typeof options.done === 'function' ? options.done.toString() : ''};
  var timeoutMs = Math.max(60000, item.until - Date.now() + 120000);
  var started = await __job([item], __snipeRunner, {concurrency: 1, timeoutMs, quiet: options.quiet});
  console.log('[ok] snipe ' + started.jobId + ' fires at ' + new Date(at).toISOString() + (offset ? ' (site clock ' + Math.round(offset) + ' ms off)' : '') + '; browser.job.result("' + started.jobId + '") after');
  if (options.wait !== true) return started;
  while (true) {
    var state = await browser.job.status(started.jobId);
    if (state.status !== 'running') break;
    await __sleep(500);
  }
  return browser.job.result(started.jobId);
}
`;
