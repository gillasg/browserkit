// Record a human demonstration on the current page and turn it into browser_code that can be
// saved as a site skill. The page-side listeners write steps to a global array; the sandbox
// drains that array on a short loop so steps survive full navigations. Passwords are redacted
// before they leave the page. Evaluated in the sandbox realm.
export const browserDemonstrationApi = `
function __demoInstall(options) {
  try {
    if (window.__aeonDemoCleanup) window.__aeonDemoCleanup();
    var state = { id: options.id, steps: [] };
    window.__aeonDemo = state;
    function cssPath(element) {
      var id = element.getAttribute('id');
      if (id) return '#' + CSS.escape(id);
      var attributes = ['data-testid', 'data-test', 'name', 'aria-label'];
      for (var i = 0; i < attributes.length; i++) {
        var value = element.getAttribute(attributes[i]);
        if (!value) continue;
        var candidate = '[' + attributes[i] + '="' + CSS.escape(value) + '"]';
        if (document.querySelectorAll(candidate).length === 1) return candidate;
      }
      var parent = element.parentElement;
      var tag = element.tagName.toLowerCase();
      if (!parent) return tag;
      var siblings = Array.prototype.filter.call(parent.children, function (child) { return child.tagName === element.tagName; });
      return cssPath(parent) + ' > ' + tag + ':nth-of-type(' + (siblings.indexOf(element) + 1) + ')';
    }
    function nameFor(element) {
      var label = element.getAttribute('aria-label');
      if (label && label.trim()) return label.trim();
      var labelledBy = element.getAttribute('aria-labelledby');
      if (labelledBy) {
        var text = labelledBy.split(/\\s+/).map(function (id) { var node = document.getElementById(id); return node ? node.textContent || '' : ''; }).join(' ').replace(/\\s+/g, ' ').trim();
        if (text) return text;
      }
      var value = (element.textContent || '').replace(/\\s+/g, ' ').trim();
      return value ? value.slice(0, 120) : undefined;
    }
    function roleFor(element) {
      var explicit = element.getAttribute('role');
      if (explicit) return explicit;
      if (element instanceof HTMLButtonElement) return 'button';
      if (element instanceof HTMLAnchorElement) return 'link';
      if (element instanceof HTMLInputElement) {
        if (element.type === 'checkbox') return 'checkbox';
        if (element.type === 'radio') return 'radio';
        return 'textbox';
      }
      if (element instanceof HTMLSelectElement) return 'combobox';
      if (element instanceof HTMLTextAreaElement || (element instanceof HTMLElement && element.isContentEditable)) return 'textbox';
      return undefined;
    }
    function send(step) {
      if (state.steps.length >= 500) state.steps.splice(0, state.steps.length - 500);
      state.steps.push(step);
    }
    function onClick(event) {
      var target = (event.composedPath ? event.composedPath() : [event.target]).filter(function (item) { return item instanceof Element; })[0];
      var actionable = target && target.closest("button, a[href], summary, [role='button'], [role='link'], [role='tab'], [role='menuitem']");
      if (!actionable) return;
      var role = roleFor(actionable);
      var name = nameFor(actionable);
      send({ kind: 'click', selector: cssPath(actionable), role: role, name: name });
    }
    function onInput(event) {
      var element = event.target;
      if (element instanceof HTMLInputElement) {
        if (['checkbox', 'radio', 'file', 'button', 'submit', 'reset'].indexOf(element.type) >= 0) return;
        var redacted = element.type === 'password';
        send({ kind: 'fill', selector: cssPath(element), value: redacted ? '' : element.value, redacted: redacted });
      } else if (element instanceof HTMLTextAreaElement) {
        send({ kind: 'fill', selector: cssPath(element), value: element.value });
      } else if (element instanceof HTMLElement && element.isContentEditable) {
        send({ kind: 'fill', selector: cssPath(element), value: element.innerText });
      }
    }
    function onChange(event) {
      var element = event.target;
      if (element instanceof HTMLInputElement && (element.type === 'checkbox' || element.type === 'radio')) {
        send({ kind: 'check', selector: cssPath(element), checked: element.checked });
      } else if (element instanceof HTMLSelectElement) {
        send({ kind: 'select', selector: cssPath(element), value: element.value });
      } else {
        onInput(event);
      }
    }
    var lastUrl = location.href;
    function onNavigate() {
      if (location.href === lastUrl) return;
      lastUrl = location.href;
      send({ kind: 'navigation', url: lastUrl });
    }
    document.addEventListener('click', onClick, true);
    document.addEventListener('input', onInput, true);
    document.addEventListener('change', onChange, true);
    window.addEventListener('popstate', onNavigate);
    window.addEventListener('hashchange', onNavigate);
    window.__aeonDemoCleanup = function () {
      document.removeEventListener('click', onClick, true);
      document.removeEventListener('input', onInput, true);
      document.removeEventListener('change', onChange, true);
      window.removeEventListener('popstate', onNavigate);
      window.removeEventListener('hashchange', onNavigate);
      if (window.__aeonDemo === state) delete window.__aeonDemo;
      delete window.__aeonDemoCleanup;
    };
  } catch (error) {}
}
function __demoDrain() {
  var state = window.__aeonDemo;
  return state ? state.steps.splice(0, state.steps.length) : null;
}
function __demoUninstall(options) {
  if (window.__aeonDemo && window.__aeonDemo.id === options.id && window.__aeonDemoCleanup) window.__aeonDemoCleanup();
}
function __demoFormat(steps, startedUrl) {
  var host = '';
  try { host = new URL(startedUrl).hostname; } catch (error) {}
  var base = host ? host.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) : 'site';
  var functionName = 'run' + base.split('-').filter(Boolean).map(function (part) { return part.charAt(0).toUpperCase() + part.slice(1); }).join('') + 'Demo';
  if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(functionName)) functionName = 'runRecordedDemo';
  var lines = ['async function ' + functionName + '() {', '  await page.goto(' + JSON.stringify(startedUrl) + ');'];
  for (var i = 0; i < steps.length; i++) {
    var step = steps[i];
    if (step.kind === 'navigation') lines.push('  // Navigated to ' + step.url);
    else if (step.kind === 'click') {
      var note = step.role && step.name ? ' // ' + step.role + ' ' + JSON.stringify(step.name) : '';
      lines.push('  await page.locator(' + JSON.stringify(step.selector) + ').click()' + note);
    } else if (step.kind === 'fill') {
      lines.push(step.redacted
        ? '  // Fill ' + JSON.stringify(step.selector) + ' (redacted).'
        : '  await page.locator(' + JSON.stringify(step.selector) + ').fill(' + JSON.stringify(step.value) + ')');
    } else if (step.kind === 'check') {
      lines.push('  await page.locator(' + JSON.stringify(step.selector) + ').' + (step.checked ? 'check' : 'uncheck') + '()');
    } else if (step.kind === 'select') {
      lines.push('  await page.locator(' + JSON.stringify(step.selector) + ').selectOption(' + JSON.stringify(step.value) + ')');
    }
  }
  lines.push('  return { url: String(page.url), title: await page.title() };');
  lines.push('}');
  return { code: lines.join('\\n'), functionName: functionName };
}
function __demoSkill(result) {
  var host = '';
  try { host = new URL(result.startedUrl).hostname; } catch (error) {}
  var base = host ? host.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) : 'site';
  return {
    name: ('demo-' + base + '-' + Date.now().toString(36)).slice(0, 64),
    domains: host ? [host] : [],
    description: 'Recorded demonstration on ' + (host || result.startedUrl),
    examples: 'await ' + result.functionName + '()',
    code: result.code,
  };
}
async function __recordDemonstration(target, options) {
  options = options || {};
  var id = 'demo-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  var page = browser.page(target);
  var startedUrl = String(page.url || '');
  var steps = [];
  var running = true;
  function append(step) {
    if (!step || typeof step !== 'object') return;
    var previous = steps[steps.length - 1];
    if (step.kind === 'fill' && previous && previous.kind === 'fill' && previous.selector === step.selector) {
      steps[steps.length - 1] = step;
      return;
    }
    if (step.kind === 'navigation' && previous && previous.kind === 'navigation' && previous.url === step.url) return;
    steps.push(step);
  }
  var install = '(' + __demoInstall.toString() + ')(' + JSON.stringify({ id: id }) + ')';
  var drain = '(' + __demoDrain.toString() + ')()';
  var uninstall = '(' + __demoUninstall.toString() + ')(' + JSON.stringify({ id: id }) + ')';
  await __isolatedEval(target, install).catch(function () {});
  var lastUrl = startedUrl;
  var loop = (async function () {
    while (running) {
      await __sleep(120);
      try {
        var drained = await __isolatedEval(target, drain);
        if (drained === null) {
          // A new document starts without the recorder; install it again.
          await __isolatedEval(target, install);
        } else if (Array.isArray(drained)) {
          for (var i = 0; i < drained.length; i++) append(drained[i]);
        }
        var url = await __isolatedEval(target, 'location.href');
        if (typeof url === 'string' && url && url !== lastUrl) {
          append({ kind: 'navigation', url: url });
          lastUrl = url;
        }
      } catch (error) {}
    }
  })();
  var stop = async function () {
    if (!running) throw new Error('DEMONSTRATION_STOPPED: the recorder has already stopped');
    running = false;
    await loop.catch(function () {});
    await __isolatedEval(target, uninstall).catch(function () {});
    try {
      var drained = await __isolatedEval(target, drain);
      if (Array.isArray(drained)) for (var i = 0; i < drained.length; i++) append(drained[i]);
    } catch (error) {}
    var formatted = __demoFormat(steps, startedUrl);
    var result = { startedUrl: startedUrl, endedUrl: lastUrl, steps: steps, code: formatted.code, functionName: formatted.functionName };
    if (options.skill !== false) result.skill = __demoSkill(result);
    return result;
  };
  return Object.freeze({
    id: id,
    startedUrl: startedUrl,
    steps: function () { return steps.slice(); },
    stop: stop,
  });
}
`;
