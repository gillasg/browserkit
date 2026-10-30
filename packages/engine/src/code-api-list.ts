// page.list(selector?, options?): every row of a list, including lists that only draw the rows
// on screen (virtualized job boards, feeds, inboxes, grids) and lists that load more on scroll.
// The sandbox scrolls the list's own scroller a screen at a time, collecting rows as they are
// drawn, until the end stops moving; then it puts the scroll position back.

export const browserListApi = `
// Page-side, one screen: scroll ({scrollTo} for a position), tell the list, wait, then read the
// rows drawn now. Background tabs deliver scroll events late (with animation frames), so lists
// that redraw on scroll would lag behind; the event sent here keeps the rows in step.
function __listStep(selector, options) {
  var clean = (text) => (text || '').replace(/\\s+/g, ' ').trim();
  var visible = (el) => el.getClientRects().length > 0;
  var guesses = ['[data-index]', '[data-key]', '[role=row]', '[role=listitem]', '[role=article]', 'article', 'li'];
  var rowsOf = (css) => { var found = [...document.querySelectorAll(css)]; return found.filter((row) => !found.some((other) => other !== row && other.contains(row))); };
  var chosen = selector || guesses.find((css) => [...document.querySelectorAll(css)].filter(visible).length >= 3);
  if (!chosen) throw new Error('TARGET_NOT_FOUND: no repeated rows found; pass the row selector, e.g. page.list(".result-card")');
  var first = rowsOf(chosen)[0];
  var scroller = (() => {
    for (var el = first && first.parentElement; el && el !== document.body; el = el.parentElement) {
      if (/(auto|scroll)/.test(getComputedStyle(el).overflowY) && el.scrollHeight > el.clientHeight + 4) return el;
    }
    return document.scrollingElement;
  })();
  var before = scroller.scrollTop;
  if (options.scrollTo != null) scroller.scrollTop = options.scrollTo;
  else if (options.scroll !== false) scroller.scrollTop = before + Math.max(200, scroller.clientHeight * 0.85);
  (scroller === document.scrollingElement ? window : scroller).dispatchEvent(new Event('scroll'));
  if (options.restore) return {selector: chosen};
  return new Promise((done) => setTimeout(() => {
    var items = rowsOf(chosen).map((row) => {
      var link = row.querySelector('a[rel="bookmark"], a[href*="/status/"], a[href*="/p/"], a[href*="/post/"], a[href*="/item/"]') || row.querySelector('a[href]');
      var href = link ? link.href : null;
      var key = href || row.getAttribute('data-id') || row.getAttribute('data-key') || row.getAttribute('data-index') || row.id || null;
      return {key, text: clean(row.innerText).slice(0, options.maxText || 500), ...(href ? {href} : {})};
    });
    done({selector: chosen, items, top: before, moved: Math.abs(scroller.scrollTop - before) >= 2});
  }, options.waitMs || 250));
}
// Sandbox-side: one small page read per screen, so long lists never hit the evaluate timeout.
async function __collectList(base, selector, options) {
  if (selector && typeof selector === 'object') { options = selector; selector = null; }
  options = options || {};
  var max = options.max ?? 1000, seen = new Map(), chosen = selector || null, start = null;
  var complete = false, partial = false, stable = 0, scrolls = 0;
  var step = (args) => base.inspect('(' + __listStep.toString() + ')(' + JSON.stringify(chosen) + ', ' + JSON.stringify(args) + ')');
  for (var i = 0; i < (options.maxScrolls ?? 300) && !(options.deadline && Date.now() > options.deadline); i++) {
    scrolls = i + 1;
    // The first read starts at the top; at the end, wait longer once, since lists that
    // load more on scroll need a moment to fetch.
    var read = await step({maxText: options.maxText, ...(i === 0 ? {scrollTo: 0} : {}), waitMs: stable ? 1500 : 250});
    chosen = read.selector;
    if (start === null) start = read.top;
    var added = 0;
    for (var item of read.items) {
      var id = item.key ?? item.text + '|' + (item.href || '');
      if (!seen.has(id)) { seen.set(id, item); added += 1; }
    }
    if (seen.size >= max) { partial = true; break; }
    // Only a run where the list did not move and no new key appeared counts as the end.
    if (!read.moved && added === 0) { if (++stable >= 2) { complete = true; break; } }
    else stable = 0;
  }
  await step({scrollTo: start, restore: true}).catch(() => {});
  var items = [...seen.values()].slice(0, max);
  if (items.length && items.every((item) => /^\\d+$/.test(item.key ?? ''))) items.sort((a, b) => a.key - b.key);
  if (!complete) partial = true;
  return {
    count: items.length,
    complete,
    partial,
    selector: chosen,
    scrolls,
    ...(!complete ? {note: 'list is not complete: stopped after ' + items.length + ' rows' + (seen.size >= max ? ' (max reached)' : options.deadline && Date.now() > options.deadline ? ' (time budget)' : '') + '; call page.list() or pass a larger max'} : {}),
    items,
  };
}
`;
