// Forms and page furniture in browser code: page.controls (every field's full state),
// page.batch (several steps in one call, each target matched exactly once, ending in a check),
// page.overlays.dismiss (cookie banners and pop-ups, rejecting first), page.enterSite (age,
// terms, region and "click to enter" gates, clicking the affirmative control),
// page.media.inspect (what is playing) and page.challenges (bot checks, captchas, blocks and
// sign-in walls, also noted in bu.state). Page-side functions are self-contained: they run
// through page.inspect or a frame's evaluate, so they cannot call anything outside themselves.
import { affirmativeIndex, classifyGate } from "./gates.js";

export const browserControlsApi = `
// Gate classification is the same pure function the unit tests cover; it is injected here so the
// page side and the tests cannot drift.
var __classifyGate = ${classifyGate};
var __pickAffirmative = ${affirmativeIndex};
// Page-side. mode 'list': controls with their state. mode 'find': the one element a batch target
// names, tagged with data-aeon-t so the engine acts on it. mode 'select': picks options in a
// native select. Open shadow roots are searched; iframes are the caller's job.
function __pageControls(arg) {
  var clean = (s) => String(s == null ? '' : s).replace(/\\s+/g, ' ').trim();
  var cut = (s, n) => { s = clean(s); return s.length > n ? s.slice(0, n - 1) + '\\u2026' : s; };
  var SELECTOR = 'input,select,textarea,button,a[href],[role],[contenteditable]';
  var FIELDS = ['checkbox','radio','switch','combobox','listbox','slider','spinbutton','textbox','searchbox','file','color'];
  var ACTIONS = ['button','link','tab','menuitem','menuitemcheckbox','menuitemradio','option','treeitem'];
  var deep = (selector) => {
    var roots = [document], out = [];
    while (roots.length) {
      var root = roots.shift();
      out.push(...root.querySelectorAll(selector));
      for (var el of root.querySelectorAll('*')) if (el.shadowRoot) roots.push(el.shadowRoot);
    }
    return out;
  };
  var shown = (el) => {
    var r = el.getBoundingClientRect();
    if (!r.width || !r.height) return false;
    var s = getComputedStyle(el);
    return s.visibility !== 'hidden' && s.display !== 'none';
  };
  // Styled checkboxes hide the real input and show its label.
  var visible = (el) => shown(el) || Boolean(el.labels && [...el.labels].some(shown));
  var roleOf = (el) => {
    var explicit = (el.getAttribute('role') || '').split(' ')[0];
    if (explicit) return explicit;
    var tag = el.tagName.toLowerCase(), type = (el.getAttribute('type') || 'text').toLowerCase();
    if (tag === 'select') return el.multiple || el.size > 1 ? 'listbox' : 'combobox';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'button') return 'button';
    if (tag === 'a') return el.hasAttribute('href') ? 'link' : '';
    if (tag === 'input') {
      if (['button','submit','reset','image'].includes(type)) return 'button';
      if (type === 'hidden') return '';
      if (['checkbox','radio','file','color'].includes(type)) return type;
      return {range: 'slider', number: 'spinbutton', search: 'searchbox'}[type] || 'textbox';
    }
    if (el.isContentEditable && !(el.parentElement && el.parentElement.isContentEditable)) return 'textbox';
    return '';
  };
  var byId = (el, id) => { var root = el.getRootNode(); return (root.getElementById && root.getElementById(id)) || document.getElementById(id); };
  var ownText = (el) => el.innerText || el.textContent || '';
  var labelOf = (el) => {
    var ids = el.getAttribute('aria-labelledby');
    var named = ids ? clean(ids.split(' ').map((id) => { var n = byId(el, id); return n ? ownText(n) : ''; }).join(' ')) : '';
    if (named) return cut(named, 120);
    if (el.getAttribute('aria-label')) return cut(el.getAttribute('aria-label'), 120);
    var labels = el.labels ? clean([...el.labels].map(ownText).join(' ')) : '';
    if (labels) return cut(labels, 120);
    var role = roleOf(el);
    if (el.tagName !== 'INPUT' && (ACTIONS.includes(role) || ['checkbox','radio','switch'].includes(role)) && clean(ownText(el))) return cut(ownText(el), 120);
    if (el.tagName === 'INPUT' && ['submit','button','reset'].includes(el.type) && el.value) return cut(el.value, 120);
    if (el.getAttribute('placeholder')) return cut(el.getAttribute('placeholder'), 120);
    if (el.getAttribute('title')) return cut(el.getAttribute('title'), 120);
    var icon = el.querySelector && el.querySelector('img[alt],[aria-label],[title]');
    if (icon) return cut(icon.getAttribute('alt') || icon.getAttribute('aria-label') || icon.getAttribute('title'), 120);
    // A label written next to the field without being tied to it.
    var before = el.previousElementSibling && clean(ownText(el.previousElementSibling));
    if (before && before.length < 80) return before;
    return cut(el.getAttribute('name') || '', 80);
  };
  var groupOf = (el) => {
    var set = el.closest('fieldset'), legend = set && set.querySelector('legend');
    if (legend) return cut(ownText(legend), 80);
    var group = el.parentElement && el.parentElement.closest('[role=radiogroup],[role=group]');
    return group ? cut(group.getAttribute('aria-label') || '', 80) : '';
  };
  var optionText = (o) => cut(o.label || o.text, 60);
  var selectState = (el, out) => {
    var options = [...el.options];
    out.value = cut([...el.selectedOptions].map(optionText).join(', '), 200);
    out.options = options.slice(0, 40).map((o) => (o.selected ? '* ' : '') + optionText(o) +
      (o.value && clean(o.value) !== clean(o.label || o.text) ? ' [' + cut(o.value, 40) + ']' : '') + (o.disabled ? ' (disabled)' : ''));
    if (options.length > 40) out.options.push('+' + (options.length - 40) + ' more');
  };
  var valueState = (el, out) => {
    var tag = el.tagName.toLowerCase(), type = tag === 'input' ? el.type : '';
    if (tag === 'select') return selectState(el, out);
    if (type === 'checkbox' || type === 'radio') {
      out.checked = el.indeterminate ? 'mixed' : el.checked;
      if (el.value && el.value !== 'on') out.value = cut(el.value, 60);
    } else if (type === 'password') out.value = el.value ? '[' + el.value.length + ' characters, hidden]' : '';
    else if (type === 'file') out.value = [...(el.files || [])].map((f) => f.name).join(', ');
    else if (tag === 'input' || tag === 'textarea') out.value = cut(el.value, 300);
    else if (el.isContentEditable) out.value = cut(el.innerText, 300);
    if (type && !['text','checkbox','radio','submit','button'].includes(type) && roleOf(el) !== type) out.type = type;
  };
  var ariaState = (el, out) => {
    var aria = (name) => el.getAttribute('aria-' + name);
    var flag = (name) => aria(name) == null ? undefined : aria(name) === 'mixed' ? 'mixed' : aria(name) === 'true';
    for (var name of ['checked','selected','pressed','expanded']) if (out[name] === undefined && flag(name) !== undefined) out[name] = flag(name);
    var role = roleOf(el);
    if (role === 'combobox' && el.tagName !== 'SELECT') {
      if (out.value === undefined) out.value = cut(el.value != null ? el.value : ownText(el), 200);
      var list = aria('controls') && byId(el, aria('controls'));
      var items = list ? [...list.querySelectorAll('[role=option]')] : [];
      if (items.length) out.options = items.slice(0, 40).map((o) => (o.getAttribute('aria-selected') === 'true' ? '* ' : '') + cut(ownText(o), 60));
    }
    if (role === 'slider' || role === 'spinbutton' || /^(date|datetime-local|time|month|week)$/.test(el.type || '')) {
      if (out.value === undefined) out.value = aria('valuetext') || aria('valuenow') || '';
      var min = el.min || aria('valuemin'), max = el.max || aria('valuemax');
      if (min) out.min = min;
      if (max) out.max = max;
      if (el.step) out.step = el.step;
    }
    if (el.required || aria('required') === 'true') out.required = true;
    if (el.disabled || aria('disabled') === 'true' || el.closest('[inert]')) out.disabled = true;
    if (el.readOnly || aria('readonly') === 'true') out.readonly = true;
    if (aria('invalid') === 'true') out.invalid = true;
    else if (el.validity && !el.validity.valid && el.validationMessage && (el.value || el.checked)) out.invalid = cut(el.validationMessage, 120);
  };
  var describe = (el) => {
    var out = {role: roleOf(el), label: labelOf(el)};
    if (el.getAttribute('name')) out.name = el.getAttribute('name');
    valueState(el, out);
    ariaState(el, out);
    var placeholder = el.getAttribute('placeholder');
    if (placeholder && out.label !== cut(placeholder, 120)) out.placeholder = cut(placeholder, 80);
    var group = groupOf(el);
    if (group && group !== out.label) out.group = group;
    if (out.role === 'link' && el.href) out.href = String(el.href).slice(0, 200);
    if (!visible(el)) out.hidden = true;
    return out;
  };
  var isField = (role) => FIELDS.includes(role);
  var list = () => {
    var wanted = clean(arg.query).toLowerCase(), rows = [];
    for (var el of deep(SELECTOR)) {
      var role = roleOf(el);
      if (!role || !(isField(role) || (arg.actions && ACTIONS.includes(role)))) continue;
      if (!visible(el) && !arg.hidden) continue;
      var row = describe(el);
      var haystack = [row.label, row.name, row.placeholder, row.group, row.value].join(' ').toLowerCase();
      if (wanted && !haystack.includes(wanted)) continue;
      rows.push(row);
      if (rows.length >= (arg.limit || 150)) break;
    }
    return rows;
  };
  var matches = (have, want, exact) => {
    have = clean(have).toLowerCase(); want = clean(want).toLowerCase();
    return exact ? have === want : have.includes(want);
  };
  // Exact text wins over a partial match ("Add" over "Add to list") unless {exact} says which.
  var narrow = (els, get, want, exact) => {
    var same = els.filter((el) => matches(get(el), want, true));
    return same.length || exact ? same : els.filter((el) => matches(get(el), want, false));
  };
  var deepest = (els) => els.filter((el) => !els.some((other) => other !== el && el.contains(other)));
  var candidates = (t) => {
    if (t.css) return deep(t.css);
    if (t.text != null) {
      var want = clean(t.text).toLowerCase();
      var texty = deep('*').filter((el) => !['HTML','HEAD','BODY','SCRIPT','STYLE','NOSCRIPT','TEMPLATE'].includes(el.tagName) &&
        clean(el.textContent).toLowerCase().includes(want) && shown(el));
      return deepest(narrow(texty, ownText, t.text, t.exact));
    }
    var els = deep(SELECTOR).filter((el) => roleOf(el));
    if (t.role) els = els.filter((el) => roleOf(el) === t.role);
    var label = t.label != null ? t.label : t.name;
    if (label != null) els = narrow(els, labelOf, label, t.exact);
    if (t.placeholder != null) els = narrow(els, (el) => el.getAttribute('placeholder') || '', t.placeholder, t.exact);
    return els;
  };
  var tagged = (attr) => deep('[' + attr + '="' + arg.token + '"]')[0];
  var find = () => {
    for (var old of deep('[data-aeon-t],[data-aeon-s]')) { old.removeAttribute('data-aeon-t'); old.removeAttribute('data-aeon-s'); }
    var t = arg.find, els = candidates(t), seen = els.filter(visible);
    if (seen.length) els = seen;
    if (t.nth != null) els = els.slice(t.nth, t.nth === -1 ? undefined : t.nth + 1);
    if (els.length !== 1) return {count: els.length, matches: els.slice(0, 6).map((el) => roleOf(el) + ' ' + JSON.stringify(labelOf(el) || cut(ownText(el), 60)))};
    var el = els[0];
    // A hidden styled checkbox is clicked through its label; its state is still read from it.
    var act = !shown(el) && el.labels && [...el.labels].find(shown) || el;
    act.setAttribute('data-aeon-t', arg.token);
    el.setAttribute('data-aeon-s', arg.token);
    return {count: 1, control: {...describe(el), text: cut(ownText(el), 2000)}};
  };
  var select = () => {
    var el = tagged('data-aeon-s');
    if (!el) throw new Error('STALE_REF: the control is gone');
    if (el.tagName !== 'SELECT') return {custom: true};
    var options = [...el.options], picked = [];
    for (var want of [].concat(arg.values)) {
      var option = options.find((o) => matches(o.label || o.text, want, true) || o.value === String(want)) ||
        options.find((o) => matches(o.label || o.text, want, false));
      if (!option) throw new Error('NO_OPTION: ' + JSON.stringify(want) + ' is not one of ' + options.slice(0, 20).map(optionText).join(' | '));
      picked.push(option);
    }
    if (!el.multiple) el.value = picked[0].value;
    else for (var o of options) o.selected = picked.includes(o);
    el.dispatchEvent(new Event('input', {bubbles: true}));
    el.dispatchEvent(new Event('change', {bubbles: true}));
    return {selected: picked.map(optionText)};
  };
  if (arg.mode === 'find') return find();
  if (arg.mode === 'select') return select();
  if (arg.mode === 'cleanup') { for (var el of deep('[data-aeon-t],[data-aeon-s]')) { el.removeAttribute('data-aeon-t'); el.removeAttribute('data-aeon-s'); } return true; }
  return list();
}
// Frames worth reading: real pages, not ad or tracking frames, at most eight.
var __QUIET_FRAMES = /doubleclick|googlesyndication|googletagmanager|adservice|amazon-adsystem|criteo|facebook\\.com\\/tr|about:blank/i;
async function __otherFrames(target, pattern) {
  var frames = await browser.page(target).frames().catch(() => []);
  return frames.slice(1).filter((f) => /^https?:/.test(f.url) && !__QUIET_FRAMES.test(f.url) && (!pattern || pattern.test(f.url))).slice(0, 8);
}
async function __controlsList(target, options = {}) {
  if (typeof options === 'string') options = {query: options};
  var arg = {mode: 'list', query: options.query || '', actions: !!options.actions, hidden: !!options.hidden, limit: __clamp(options.limit ?? 150, 1, 400)};
  var rows = await browser.page(target).inspect(__pageControls, arg);
  if (options.frames === false) return rows;
  for (var frame of await __otherFrames(target)) {
    var inFrame = await frame.evaluate(__pageControls, arg).catch(() => []);
    for (var row of inFrame || []) rows.push({...row, frame: String(frame.url).slice(0, 120)});
  }
  return rows;
}

var __tagSeq = 0;
var __BATCH_ACTIONS = ['click','fill','type','select','check','uncheck','press','read','readUrl','wait'];
var __BATCH_WRITES = ['click','fill','type','select','check','uncheck','press'];
var __TARGET_KEYS = ['label','role','name','text','placeholder','css'];
// Every step is checked before the first one runs, so a typo in step 6 cannot leave half a form.
function __batchStep(op, index) {
  var where = 'page.batch step ' + (index + 1);
  if (!op || typeof op !== 'object') throw Error(where + ' is not an object');
  var action = String(op.action || '');
  if (!__BATCH_ACTIONS.includes(action)) throw Error(where + ': action must be one of ' + __BATCH_ACTIONS.join(', '));
  var target = typeof op.target === 'string' ? {css: op.target} : op.target;
  var needsTarget = !['readUrl', 'wait'].includes(action);
  if (needsTarget && (!target || typeof target !== 'object' || !__TARGET_KEYS.some((key) => target[key] != null)))
    throw Error(where + ' (' + action + ') needs a target: {label}, {role, name}, {text}, {placeholder} or {css}, plus {frame: urlPart} inside an iframe and {nth} for one of several');
  if ((action === 'fill' || action === 'type') && typeof op.value !== 'string' && typeof op.value !== 'number') throw Error(where + ': fill needs a string value');
  if (action === 'select' && op.value == null) throw Error(where + ': select needs a value (option text or value, or a list)');
  if (action === 'press' && !op.value && !op.key) throw Error(where + ': press needs a key');
  if (action === 'readUrl' && op.expect == null) throw Error(where + ': readUrl needs expect (part of the URL)');
  return {...op, id: String(op.id || index + 1), action, target};
}
function __expected(text, expect) {
  if (expect instanceof RegExp) return expect.test(String(text));
  var norm = (s) => String(s == null ? '' : s).replace(/\\s+/g, ' ').trim().toLowerCase();
  return norm(text).includes(norm(expect));
}
// Finds the one element a step names, waiting for it to appear (a wizard's next page, a result).
async function __batchFind(target, op, wait = true) {
  var frame = op.target.frame ? await __batchFrame(target, op.target.frame) : null;
  var token = 'b' + (++__tagSeq), deadline = Date.now() + Math.min(30000, op.timeout ?? 8000), found;
  var arg = {mode: 'find', token, find: op.target};
  do {
    found = frame ? await frame.evaluate(__pageControls, arg) : await browser.page(target).inspect(__pageControls, arg);
    if (found.count === 1 || found.count > 1 || !wait) break;
    await __sleep(200);
  } while (Date.now() < deadline);
  if (found.count !== 1)
    throw Error((found.count ? 'AMBIGUOUS: ' + found.count + ' elements match ' : 'TARGET_NOT_FOUND: nothing matches ') + JSON.stringify(op.target) +
      (found.matches && found.matches.length ? ' (' + found.matches.join('; ') + '); add {exact: true}, {nth} or a role' : ''));
  return {frame, token, selector: '[data-aeon-t="' + token + '"]', control: found.control};
}
async function __batchFrame(target, part) {
  var frames = (await __otherFrames(target)).filter((f) => String(f.url).includes(String(part)));
  if (frames.length !== 1) throw Error('FRAME: ' + frames.length + ' frames have ' + JSON.stringify(part) + ' in their URL; await page.frames() lists them');
  return frames[0];
}
async function __batchAct(target, found, kind, value) {
  if (found.frame) return kind === 'fill' ? found.frame.fill(found.selector, String(value)) : found.frame.click(found.selector);
  var locator = browser.page(target).locator(found.selector);
  return kind === 'fill' ? locator.fill(String(value)) : locator.click();
}
async function __batchRead(target, op) {
  var deadline = Date.now() + Math.min(30000, op.timeout ?? 10000), last;
  do {
    try {
      last = (await __batchFind(target, op, false)).control;
      if (op.expect == null || __expected(last.text + ' ' + (last.value ?? ''), op.expect)) return {read: last.value ?? last.text};
    } catch (error) { if (!/TARGET_NOT_FOUND/.test(String(error.message))) throw error; }
    await __sleep(250);
  } while (Date.now() < deadline);
  throw Error('EXPECTATION_FAILED: ' + JSON.stringify(op.target) + (last ? ' shows ' + JSON.stringify(String(last.value ?? last.text).slice(0, 200)) : ' never appeared') + ', not ' + JSON.stringify(String(op.expect)));
}
async function __batchUrl(target, op) {
  var deadline = Date.now() + Math.min(30000, op.timeout ?? 10000), url;
  do {
    url = await browser.page(target).inspect(() => location.href);
    if (__expected(url, op.expect)) return {url};
    await __sleep(250);
  } while (Date.now() < deadline);
  throw Error('EXPECTATION_FAILED: the URL is ' + url + ', without ' + JSON.stringify(String(op.expect)));
}
async function __batchSelect(target, op, found) {
  var scope = found.frame ? (fn, arg) => found.frame.evaluate(fn, arg) : (fn, arg) => browser.page(target).inspect(fn, arg);
  var result = await scope(__pageControls, {mode: 'select', token: found.token, values: op.value});
  if (!result.custom) {
    // Set in the page directly, so mark the tab changed for the observation that ends the cell.
    __dirty.set(__key(target), target);
    return result;
  }
  // A custom dropdown: open it, then click the option.
  await __batchAct(target, found, 'click');
  var picked = [];
  for (var value of [].concat(op.value)) {
    var option = await __batchFind(target, {target: {role: 'option', name: String(value), frame: op.target.frame}, timeout: 4000})
      .catch(() => __batchFind(target, {target: {text: String(value), frame: op.target.frame}, timeout: 2000}));
    await __batchAct(target, option, 'click');
    picked.push(option.control.label || option.control.text);
  }
  return {selected: picked};
}
async function __batchCheck(target, op, found) {
  var want = op.action === 'check';
  if (found.control.checked === want) return {checked: want, unchanged: true};
  await __batchAct(target, found, 'click');
  var after;
  for (var tries = 0; tries < 5; tries++) {
    after = (await __batchFind(target, op)).control;
    if (after.checked === want) break;
    await __sleep(200);
  }
  if (after.checked !== want) throw Error('the control is still ' + (after.checked ? 'checked' : 'unchecked') + ' after clicking it');
  return {checked: want};
}
async function __batchRun(target, op) {
  if (op.action === 'readUrl') return __batchUrl(target, op);
  if (op.action === 'read') return __batchRead(target, op);
  if (op.action === 'wait' && !op.target) { await __sleep(Math.min(10000, op.ms ?? 500)); return {}; }
  var found = await __batchFind(target, op);
  if (op.action === 'wait') return {found: found.control.label || found.control.text};
  if (op.action === 'select') return __batchSelect(target, op, found);
  if (op.action === 'check' || op.action === 'uncheck') return __batchCheck(target, op, found);
  if (op.action === 'press') {
    if (found.frame) { await found.frame.click(found.selector); await browser.page(target).keyboard(String(op.key || op.value)); }
    else await browser.page(target).locator(found.selector).press(String(op.key || op.value));
    return {pressed: String(op.key || op.value)};
  }
  if (op.action === 'click') { await __batchAct(target, found, 'click'); return {clicked: found.control.label || found.control.text}; }
  await __batchAct(target, found, 'fill', op.value);
  return {filled: found.control.label || found.control.placeholder || found.control.name};
}
async function __batch(target, ops, options = {}) {
  if (!Array.isArray(ops) || !ops.length) throw Error('page.batch takes a list of steps: [{action, target, value}]');
  if (ops.length > 40) throw Error('page.batch takes at most 40 steps; split it');
  ops = ops.map(__batchStep);
  var last = ops[ops.length - 1], changes = ops.some((op) => __BATCH_WRITES.includes(op.action));
  if (changes && !options.observe && !(['read', 'readUrl'].includes(last.action) && last.expect != null))
    throw Error('A page.batch that changes the page ends with a check of the result: {action: "read", target, expect: "text you should now see"} or {action: "readUrl", expect: "/done"}; or pass {observe: true} to get what changed instead');
  var started = Date.now(), steps = [];
  try {
    for (var op of ops) {
      var at = Date.now();
      try { steps.push({id: op.id, action: op.action, ...(await __batchRun(target, op)), ms: Date.now() - at}); }
      catch (error) {
        throw Error('page.batch step ' + op.id + ' (' + op.action + ') failed: ' + String(error && error.message || error) +
          '. Done before it: ' + (steps.map((step) => step.id).join(', ') || 'nothing') + ' (those changes stay). Look at the page before retrying.');
      }
      if (options.pace) await __sleep(Math.min(1000, options.pace));
    }
  } finally {
    await browser.page(target).inspect(__pageControls, {mode: 'cleanup'}).catch(() => {});
  }
  var result = {ok: true, ms: Date.now() - started, steps};
  if (options.observe) result.changed = await bu.state({target, final: true});
  return result;
}

// Page-side: a cookie notice or a promotion covering the page, and the button that closes it
// (reject or close first), tagged for a real click. Dialogs that read as neither are left alone.
function __pageOverlay(arg) {
  var clean = (s) => String(s == null ? '' : s).replace(/\\s+/g, ' ').trim();
  var shown = (el) => { var r = el.getBoundingClientRect(); if (!r.width || !r.height) return false; var s = getComputedStyle(el); return s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) > 0.05; };
  var deep = (selector, start) => {
    var roots = [start || document], out = [];
    while (roots.length) {
      var root = roots.shift();
      if (root.matches && root.matches(selector)) out.push(root);
      out.push(...root.querySelectorAll(selector));
      for (var el of root.querySelectorAll('*')) if (el.shadowRoot) roots.push(el.shadowRoot);
    }
    return out;
  };
  var labelOf = (el) => clean(el.getAttribute('aria-label') || el.innerText || el.value || el.getAttribute('title') || '').slice(0, 60);
  var tag = (el, kind) => {
    for (var old of deep('[data-aeon-t]')) old.removeAttribute('data-aeon-t');
    el.setAttribute('data-aeon-t', arg.token);
    return {kind, label: labelOf(el) || el.id || el.className};
  };
  var REJECT = ['#onetrust-reject-all-handler', '.ot-pc-refuse-all-handler', '#CybotCookiebotDialogBodyButtonDecline', '#CybotCookiebotDialogBodyLevelButtonLevelOptinDeclineAll',
    '#didomi-notice-disagree-button', '[data-testid="uc-deny-all-button"]', '.qc-cmp2-summary-buttons button[mode="secondary"]', '.osano-cm-denyAll', '.cky-btn-reject',
    '#cookiescript_reject', '.cmplz-deny', '.fc-cta-do-not-consent', 'button[data-cookiebanner="accept_only_essential_button"]', '#W0wltc', '.sp_choice_type_REJECT_ALL', '#truste-consent-required'];
  var ACCEPT = ['#onetrust-accept-btn-handler', '#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll', '#didomi-notice-agree-button', '[data-testid="uc-accept-all-button"]',
    '.qc-cmp2-summary-buttons button[mode="primary"]', '.osano-cm-accept-all', '.cky-btn-accept', '.cmplz-accept', '.fc-cta-consent', '#L2AGLb', '#truste-consent-button', '.sp_choice_type_11'];
  for (var selector of arg.accept ? ACCEPT.concat(REJECT) : REJECT) {
    var known = deep(selector).find(shown);
    if (known) return tag(known, 'cookie');
  }
  var COOKIE = /cookie|consent|gdpr|privacy (settings|choices|preferences)|we and our partners|personal data|tracking technologies/i;
  var PROMO = /newsletter|subscribe|sign up (for|to get|and get)|join (our|the) (list|club|community)|% off|discount|coupon|special offer|limited time|download (our|the) app|get the app|open in (the )?app|(turn on|enable|allow) notifications|free shipping|don.t miss/i;
  var REJECTS = /^(reject|decline|deny|refuse|disagree)\\b|reject all|decline all|(necessary|essential|required) (cookies )?only|only (necessary|essential|required)|continue without (accepting|agreeing)|use necessary/i;
  var NEUTRAL = /^(ok|okay|got it|i understand|understood|dismiss|close|\\u00d7|\\u2715|x)$/i;
  var CLOSE = /^(\\u00d7|\\u2715|x|close|no,? thanks.*|not now|maybe later|later|skip|dismiss|cancel|continue to (the )?(site|website)|stay on (the )?(website|site|web))$/i;
  var ACCEPTS = /accept|agree|allow( all)?|got it|^ok(ay)?$|i understand|continue/i;
  var area = innerWidth * innerHeight;
  var layers = deep('*').filter((el) => {
    if (el.matches('html,head,body,header,nav,[role=banner],[role=navigation]') || !shown(el)) return false;
    var modal = el.matches('[role=dialog],[role=alertdialog],[aria-modal=true],dialog[open]');
    var r = el.getBoundingClientRect(), position = getComputedStyle(el).position;
    return modal || ((position === 'fixed' || position === 'sticky') && r.width * r.height > area * 0.04);
  });
  layers = layers.filter((el) => !layers.some((other) => other !== el && other.contains(el)));
  for (var layer of layers) {
    var text = clean(layer.innerText).slice(0, 1500);
    var kind = COOKIE.test(text) ? 'cookie' : PROMO.test(text) ? 'promo' : '';
    // Never close a dialog the agent is typing into.
    if (!kind || (kind === 'promo' && layer.contains(document.activeElement) && document.activeElement.matches('input,textarea'))) continue;
    var buttons = deep('button,[role=button],a,input[type=button],input[type=submit]', layer).filter(shown);
    var named = (pattern) => buttons.find((b) => pattern.test(labelOf(b)) || pattern.test(clean(b.getAttribute('title') || '')));
    var closer = buttons.find((b) => /close|dismiss/i.test(b.getAttribute('aria-label') || b.getAttribute('title') || ''));
    if (kind === 'cookie') {
      var pick = arg.accept ? named(ACCEPTS) || named(NEUTRAL) || closer : named(REJECTS) || named(NEUTRAL) || closer;
      if (pick) return tag(pick, 'cookie');
      return {kind, blocked: 'the cookie notice only offers to accept; page.overlays.dismiss({accept: true}) accepts it', text: text.slice(0, 120)};
    }
    var close = closer || named(CLOSE);
    if (close) return tag(close, 'promo');
    return {kind, blocked: 'no close button; try page.keyboard.press("Escape")', text: text.slice(0, 120)};
  }
  return null;
}
var __CONSENT_FRAMES = /consent|cmp|sourcepoint|privacy-mgmt|cookie|trustarc|didomi|usercentrics/i;
async function __overlayRound(target, accept) {
  var token = 'o' + (++__tagSeq), page = browser.page(target);
  var hit = await page.inspect(__pageOverlay, {token, accept});
  if (hit) return hit.blocked ? hit : {...hit, act: () => page.locator('[data-aeon-t="' + token + '"]').click()};
  // Consent tools that live in their own iframe.
  for (var frame of await __otherFrames(target, __CONSENT_FRAMES)) {
    var inFrame = await frame.evaluate(__pageOverlay, {token, accept}).catch(() => null);
    if (inFrame && !inFrame.blocked) return {...inFrame, act: () => frame.click('[data-aeon-t="' + token + '"]')};
  }
  return null;
}
async function __dismissOverlays(target, options = {}) {
  var dismissed = [], left, previous = '';
  for (var round = 0; round < 4; round++) {
    var hit = await __overlayRound(target, !!options.accept);
    if (!hit) break;
    if (hit.blocked) { left = {kind: hit.kind, why: hit.blocked, text: hit.text}; break; }
    var key = hit.kind + ':' + hit.label;
    if (key === previous) { left = {kind: hit.kind, why: 'clicking ' + JSON.stringify(hit.label) + ' did not close it'}; break; }
    previous = key;
    await hit.act();
    dismissed.push({kind: hit.kind, clicked: hit.label});
    await __sleep(400);
  }
  return {dismissed, ...(left ? {left} : {})};
}

// Page-side: a gate layer (age, terms, region, enter) and its affirmative control, tagged like
// the cookie overlay so the engine can click it in the frame it was found in.
function __pageGate(arg) {
  var clean = (value) => String(value ?? '').replace(/\\s+/g, ' ').trim();
  var shown = (el) => { var r = el.getBoundingClientRect(); var style = getComputedStyle(el); return r.width > 40 && r.height > 40 && style.visibility !== 'hidden' && style.display !== 'none'; };
  var tag = (el, kind) => {
    for (var old of document.querySelectorAll('[data-aeon-t]')) old.removeAttribute('data-aeon-t');
    el.setAttribute('data-aeon-t', arg.token);
    return {gate: kind, label: clean(el.innerText || el.value || el.getAttribute('aria-label') || '').slice(0, 80)};
  };
  var area = innerWidth * innerHeight;
  var roots = [document];
  var layers = [];
  while (roots.length) {
    var root = roots.shift();
    layers.push(...root.querySelectorAll('*'));
    for (var node of root.querySelectorAll('*')) if (node.shadowRoot) roots.push(node.shadowRoot);
  }
  layers = layers.filter((el) => {
    if (el.matches('html,head,body,header,nav,[role=banner],[role=navigation]') || !shown(el)) return false;
    var modal = el.matches('[role=dialog],[role=alertdialog],[aria-modal=true],dialog[open]');
    var r = el.getBoundingClientRect(), position = getComputedStyle(el).position;
    return modal || ((position === 'fixed' || position === 'sticky') && r.width * r.height > area * 0.04);
  });
  layers = layers.filter((el) => !layers.some((other) => other !== el && other.contains(el)));
  for (var layer of layers) {
    var text = clean(layer.innerText).slice(0, 1500);
    var kind = __classifyGate(text);
    if (kind === 'none') continue;
    var buttons = [...layer.querySelectorAll('button,[role=button],a,input[type=button],input[type=submit]')].filter(shown);
    var labels = buttons.map((button) => clean(button.innerText || button.value || button.getAttribute('aria-label') || button.getAttribute('title') || ''));
    var index = __pickAffirmative(labels);
    if (index < 0) return {gate: kind, blocked: 'no affirmative control (labels: ' + labels.slice(0, 6).join(' | ') + ')', text: text.slice(0, 140)};
    return tag(buttons[index], kind);
  }
  return null;
}
var __GATE_FRAMES = /age|gate|consent|cmp|privacy|region|country|enter|intro|splash|welcome/i;
async function __gateRound(target) {
  var token = 'g' + (++__tagSeq), page = browser.page(target);
  var hit = await page.inspect(__pageGate, {token});
  if (hit) return hit.blocked ? hit : {...hit, act: () => page.locator('[data-aeon-t="' + token + '"]').click()};
  for (var frame of await __otherFrames(target, __GATE_FRAMES)) {
    var inFrame = await frame.evaluate(__pageGate, {token}).catch(() => null);
    if (inFrame) return inFrame.blocked ? inFrame : {...inFrame, act: () => frame.click('[data-aeon-t="' + token + '"]')};
  }
  return null;
}
// Detects the gate, clicks the affirmative control (never sign-in, paid or leave), and says what
// it clicked. What was clicked is recorded in the site's pack, so the next session starts knowing.
async function __enterSite(target, options = {}) {
  var handled = [], left;
  for (var round = 0; round < 3; round++) {
    var hit = await __gateRound(target);
    if (!hit) break;
    if (hit.blocked) { left = {gate: hit.gate, why: hit.blocked, text: hit.text}; break; }
    await hit.act();
    handled.push({gate: hit.gate, clicked: hit.label});
    await __sleep(400);
  }
  var last = handled[handled.length - 1];
  var result = {gate: last ? last.gate : 'none', clicked: last ? last.clicked : null, handled, ...(left ? {left} : {})};
  if (last) {
    try { await __call({learn: {url: await browser.page(target).url(), gate: last.gate, clicked: last.clicked}}); } catch {}
  }
  return result;
}

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
  captcha: 'One real click on its checkbox sometimes passes; otherwise bu.handoff() for the user. Do not try to solve it.',
  blocked: 'The site refused this request; repeating it will not help. Use another route (its API, another source) or tell the user.',
  'rate-limit': 'Slow down: wait before the next request and stop parallel requests to this site.',
  login: 'The user is signed out here: await bu.signIn() signs in with their password manager (it returns {signedIn, reason}); if it cannot (reason NO_PASSWORD_MANAGER, NO_SAVED_LOGIN, NEEDS_CODE, CAPTCHA, DECLINED), bu.handoff("Please sign in") and continue after.',
};
var __challengeSeen = new Set();
async function __challenges(target) {
  var found = await browser.page(target).inspect(__pageChallenge).catch(() => []);
  return (found || []).map((c) => ({...c, advice: __CHALLENGE_ADVICE[c.kind]}));
}
// A line for bu.state, once per page and kind.
async function __challengeNote(target, url) {
  var found = await __challenges(target), lines = [];
  for (var c of found) {
    var key = __key(target) + '|' + String(url).split('#')[0] + '|' + c.kind + '|' + c.provider;
    if (__challengeSeen.has(key)) continue;
    __challengeSeen.add(key);
    lines.push('challenge: ' + c.kind + ' (' + c.provider + ', ' + c.evidence + '). ' + c.advice);
  }
  if (__challengeSeen.size > 200) __challengeSeen.clear();
  return lines.join('\\n');
}
// Human-verification assistance: text-only outcomes, no pixels or tokens in logs. The agent can
// look at a numbered grid crop and answer with indexes; the engine never calls a model.
function __pageChallengeInfo() {
  var shown = (el) => { var r = el.getBoundingClientRect(); return r.width > 4 && r.height > 4 && getComputedStyle(el).visibility !== "hidden"; };
  var frame = (re) => [...document.querySelectorAll("iframe")].filter(shown).find((el) => re.test(el.src || "") && !/size=invisible/.test(el.src || ""));
  var rect = (el) => { var r = el.getBoundingClientRect(); return {x:r.left,y:r.top,width:r.width,height:r.height}; };
  var tokens = {};
  for (var name of ["g-recaptcha-response","h-captcha-response","cf-turnstile-response"]) tokens[name] = Boolean(document.querySelector('textarea[name="'+name+'"],input[name="'+name+'"]')?.value);
  var checkbox = document.querySelector('[role=checkbox],input[type=checkbox]');
  var boxes = [...document.querySelectorAll("iframe")].filter(shown).map((el) => ({src:el.src || "", ...rect(el)}));
  var tiles = [...document.querySelectorAll('[class*=tile],[role=checkbox],img')].filter(shown)
    .map((el) => ({kind:el.tagName.toLowerCase() + ":" + (el.className || ""), ...rect(el)}))
    .filter((b) => b.width > 20 && b.height > 20);
  var handle = document.querySelector('[role=slider],.geetest_slider_button,.slider-handle');
  var text = (document.body && document.body.innerText || "").slice(0, 400);
  return {tokens, checkbox: checkbox ? rect(checkbox) : null, frames: boxes, tiles: tiles.slice(0, 20),
    slider: Boolean(handle) || /slide|drag.*slider|puzzle|handle/i.test(text), grid: Boolean(frame(/bframe|frame=challenge/)) || /click.*(square|tile|image)|select all/i.test(text), text:text.slice(0,120)};
}
function __pageGridOverlay(arg) {
  document.querySelectorAll('[data-browserkit-grid]').forEach((el) => el.remove());
  var host = document.createElement('div'); host.setAttribute('data-browserkit-grid', ''); host.style.cssText = 'position:fixed;inset:0;z-index:2147483646;pointer-events:none';
  for (var tile of arg.tiles) { var b = document.createElement('b'); b.textContent = String(tile.index); b.style.cssText = 'position:fixed;left:' + (tile.x + tile.width / 2 - 6) + 'px;top:' + (tile.y + tile.height / 2 - 8) + 'px;padding:1px 3px;background:#4f46e5;color:#fff;font:700 12px system-ui;border-radius:3px'; host.append(b); }
  document.documentElement.append(host);
}
function __pageGridOverlayClear() { document.querySelectorAll('[data-browserkit-grid]').forEach((el) => el.remove()); }
var __challengeAttempts = new Map();
async function __solveChallenge(target, options = {}) {
  if (!__challengeAssist) throw Error("CHALLENGE_ASSIST_NOT_ALLOWED");
  var info = await browser.page(target).inspect(__pageChallengeInfo);
  var stage = options.stage || (info.grid ? "grid" : info.slider ? "slider" : "checkbox");
  if (stage !== "checkbox" && stage !== "slider" && stage !== "grid") throw Error("CHALLENGE_STAGE_UNKNOWN");
  var key = __key(target) + "|" + stage, attempts = (__challengeAttempts.get(key) || 0) + 1;
  __challengeAttempts.set(key, attempts);
  if (attempts > 3) { await bu.handoff("Please finish the verification"); return {stage, action: "handoff", cleared: false, attempts}; }
  if (stage === "checkbox") {
    var box = info.checkbox || info.frames.find((f) => /turnstile|captcha (anchor|api2)|hcaptcha/i.test(f.src));
    if (!box) { await bu.handoff("Please finish the verification"); return {stage, action: "no checkbox", cleared: false, attempts}; }
    await browser.page(target).clickAt(box.x + box.width * 0.25, box.y + box.height / 2);
    var cleared = false;
    for (var i = 0; i < 12; i++) {
      await new Promise((r) => setTimeout(r, i < 4 ? 500 : 400));
      var now = await browser.page(target).inspect(__pageChallengeInfo);
      if (Object.values(now.tokens).some(Boolean) || (!now.frames.some((f) => /turnstile|captcha (anchor|api2)|hcaptcha/i.test(f.src)) && !now.checkbox)) { cleared = true; break; }
    }
    if (!cleared && attempts >= 2) await bu.handoff("Please finish the verification");
    return {stage, action: "checkbox clicked", cleared, attempts};
  }
  if (stage === "slider") {
    await bu.handoff("Please finish the verification");
    return {stage, action: "slider needs a person", cleared: false, attempts};
  }
  if (!options.tiles) {
    var tiles = info.tiles.map((tile, index) => ({index: index + 1, bounds: tile}));
    if (!tiles.length) { var box0 = info.frames[0]; if (box0) for (var row = 0; row < 3; row++) for (var col = 0; col < 3; col++) tiles.push({index: row * 3 + col + 1, bounds: {x: box0.x + col * box0.width / 3, y: box0.y + row * box0.height / 3, width: box0.width / 3, height: box0.height / 3}}); }
    var clip = tiles.length ? {x: Math.max(0, Math.min(...tiles.map((t) => t.bounds.x)) - 12), y: Math.max(0, Math.min(...tiles.map((t) => t.bounds.y)) - 12), width: Math.max(...tiles.map((t) => t.bounds.x + t.bounds.width)) - Math.min(...tiles.map((t) => t.bounds.x)) + 24, height: Math.max(...tiles.map((t) => t.bounds.y + t.bounds.height)) - Math.min(...tiles.map((t) => t.bounds.y)) + 24} : undefined;
    try {
      await browser.page(target).inspect(__pageGridOverlay, {tiles});
      var shot = await browser.page(target).cdp("Page.captureScreenshot", {format: "png", ...(clip ? {clip: {...clip, scale: 1}} : {})});
      var binary = atob(shot.data), bytes = new Uint8Array(binary.length);
      for (var n = 0; n < binary.length; n++) bytes[n] = binary.charCodeAt(n);
      await artifact("screens/challenge-grid.png", bytes);
    } finally { await browser.page(target).inspect(__pageGridOverlayClear).catch(() => {}); }
    return {stage, needsVision: true, saved: "screens/challenge-grid.png", tiles};
  }
  var allTiles = info.tiles.map((tile, index) => ({index: index + 1, bounds: tile}));
  var picked = (options.tiles || []).map((index) => allTiles.find((tile) => tile.index === index)).filter(Boolean);
  for (var index = 0; index < picked.length; index++) {
    await browser.page(target).clickAt(picked[index].bounds.x + picked[index].bounds.width / 2, picked[index].bounds.y + picked[index].bounds.height / 2);
    await new Promise((r) => setTimeout(r, 70 + Math.floor(Math.random() * 140)));
  }
  var verify = await browser.page(target).inspect(() => [...document.querySelectorAll("button,[role=button]")].find((el) => /verify|submit|next/i.test(el.innerText || el.value || ""))?.getBoundingClientRect());
  if (verify) await browser.page(target).clickAt(verify.x + verify.width / 2, verify.y + verify.height / 2);
  await new Promise((r) => setTimeout(r, 1200));
  var final = await browser.page(target).inspect(__pageChallengeInfo);
  var cleared2 = Object.values(final.tokens).some(Boolean) || (!final.grid && !final.frames.some((f) => /bframe|frame=challenge/i.test(f.src)));
  return {stage, action: "grid tiles " + (options.tiles || []).join(","), cleared: cleared2, attempts, tileCount: picked.length};
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
    challenges: Object.assign(async () => __challenges(target), {solve: (options = {}) => __solveChallenge(target, options)}),
  });
}
`;
