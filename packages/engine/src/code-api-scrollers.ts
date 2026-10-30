// page.scrollers(options?): the text of every panel that scrolls on its own inside the page
// (transcripts, chat logs, comment drawers, code viewers, side lists). Each is scrolled a screen at
// a time from its top until its end stops moving, collecting lines as they are drawn, so panels
// that load or draw lines only on scroll come back whole. Scroll positions are put back after.
// page.read() includes these, but only the ones whose text grew while scrolling: the rest is
// already in its Markdown.

export const browserScrollersApi = `
// Page-side, one screen of one scroller: find the scrollers (index -1), or move scroller
// {index} ({scrollTo} for a position, {restore} to put it back) and read the lines drawn now.
function __scrollerStep(options) {
  var visible = (el) => { var box = el.getBoundingClientRect(); return box.width >= 120 && box.height >= 80; };
  var found = [...document.querySelectorAll('body *')].filter((el) => {
    if (el.scrollHeight <= el.clientHeight + 40 || !visible(el)) return false;
    return /(auto|scroll)/.test(getComputedStyle(el).overflowY);
  });
  // Outermost first, and never one inside another already found.
  var scrollers = found.filter((el) => !found.some((other) => other !== el && other.contains(el))).slice(0, options.max || 4);
  var describe = (el) => {
    var heading = el.closest('[aria-label]')?.getAttribute('aria-label') || el.querySelector('h1,h2,h3,[role=heading]')?.textContent || '';
    var id = el.id ? '#' + CSS.escape(el.id) : '';
    var classes = [...el.classList].slice(0, 2).map((name) => '.' + CSS.escape(name)).join('');
    return {label: heading.replace(/\\s+/g, ' ').trim().slice(0, 80), selector: el.tagName.toLowerCase() + id + classes};
  };
  if (options.index === -1) return scrollers.map((el) => ({...describe(el), height: el.scrollHeight, view: el.clientHeight}));
  var el = scrollers[options.index];
  if (!el) return null;
  var before = el.scrollTop;
  if (options.scrollTo != null) el.scrollTop = options.scrollTo;
  else el.scrollTop = before + Math.max(150, el.clientHeight * 0.85);
  el.dispatchEvent(new Event('scroll'));
  if (options.restore) return {top: el.scrollTop};
  return new Promise((done) => setTimeout(() => done({
    top: before,
    moved: Math.abs(el.scrollTop - before) >= 2,
    lines: (el.innerText || '').split('\\n').map((line) => line.replace(/\\s+/g, ' ').trim()).filter(Boolean),
  }), options.waitMs || 200));
}
// Sandbox-side: one small read per screen, within a time budget, so a long panel never hits the
// evaluate deadline.
async function __readScrollers(base, options) {
  options = options || {};
  var deadline = options.deadline ?? Date.now() + (options.timeMs ?? 15000);
  var maxChars = options.maxChars ?? 60000;
  var step = (args) => base.inspect('(' + __scrollerStep.toString() + ')(' + JSON.stringify({max: options.max, ...args}) + ')');
  var found = await step({index: -1});
  var results = [];
  for (var index = 0; index < found.length; index++) {
    var lines = [], seen = new Set(), first = null, start = null, stable = 0, complete = false, chars = 0;
    for (var i = 0; i < (options.maxScrolls ?? 80) && Date.now() < deadline && chars < maxChars; i++) {
      var read = await step({index, ...(i === 0 ? {scrollTo: 0} : {}), waitMs: stable ? 900 : 200});
      if (!read) break;
      if (start === null) start = read.top;
      if (first === null) first = read.lines.length;
      var added = 0;
      for (var line of read.lines) if (!seen.has(line)) { seen.add(line); lines.push(line); added += 1; chars += line.length + 1; }
      if (!read.moved && added === 0) { if (++stable >= 2) { complete = true; break; } }
      else stable = 0;
    }
    await step({index, scrollTo: start ?? 0, restore: true}).catch(() => {});
    results.push({
      ...found[index],
      text: lines.join('\\n').slice(0, maxChars),
      lines: lines.length,
      grew: lines.length > (first ?? 0),
      complete,
      ...(!complete ? {note: chars >= maxChars ? 'cut at ' + maxChars + ' characters' : 'stopped before the end (time budget); call page.scrollers() for more'} : {}),
    });
  }
  return results;
}
`;
