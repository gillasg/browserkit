// Waiting for things to happen, and recording media, for browser_code and listening checks:
// page.waitForChange (an element's text or a condition), page.waitForResponse (a matching API
// response), page.waitForMessage (a WebSocket or server-sent event message), and page.recordMedia
// (a playing video or audio element, saved to the workspace). Evaluated in the sandbox realm.
export const browserEventsApi = `
var __sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function __changeProbe(arg) {
  var nodes = [...document.querySelectorAll(arg.selector)];
  return {value: nodes.length + ':' + nodes.map((node) => (node.innerText || node.textContent || '').trim()).join('\\n').slice(0, 20000)};
}

function __mediaRecorder(arg) {
  var state = window.__browserkitMediaRecording;
  if (arg.action === 'start') {
    var element = document.querySelector(arg.selector);
    if (!element) return {error: 'No element matches ' + arg.selector};
    var stream = element.captureStream ? element.captureStream() : element.mozCaptureStream && element.mozCaptureStream();
    if (!stream) return {error: 'This element cannot be recorded'};
    var type = stream.getVideoTracks().length ? 'video/webm' : 'audio/webm';
    var recorder = new MediaRecorder(stream, {mimeType: type});
    state = window.__browserkitMediaRecording = {recorder, chunks: [], type};
    recorder.ondataavailable = (event) => event.data.size && state.chunks.push(event.data);
    recorder.start(1000);
    if (element.paused && element.play) element.play().catch(() => {});
    return {started: true, type};
  }
  if (!state) return {error: 'Not recording'};
  return new Promise((resolve) => {
    state.recorder.onstop = async () => {
      var blob = new Blob(state.chunks, {type: state.type});
      var bytes = new Uint8Array(await blob.arrayBuffer()), binary = '';
      for (var i = 0; i < bytes.length; i += 32768) binary += String.fromCharCode(...bytes.subarray(i, i + 32768));
      window.__browserkitMediaRecording = undefined;
      resolve({type: state.type, bytes: bytes.length, base64: btoa(binary)});
    };
    state.recorder.stop();
  });
}

function __extendPageEvents(target, base) {
  // A condition runs as its own expression (no eval, so page security policies do not block it).
  var probe = async (arg) => arg.condition ? {value: await base.inspect('(' + arg.condition + ')()')} : base.inspect('(' + __changeProbe.toString() + ')(' + JSON.stringify(arg) + ')');
  // Records only when nothing records yet, so an existing recording keeps its options (dry run, types).
  var recording = async () => { try { await __call({network: 'list', target, match: ''}); } catch { await __call({network: 'start', target}); } };
  var deadlineOf = (options) => Date.now() + Math.min(options.timeoutMs ?? 50000, 55000);
  return Object.assign(base, {
    // Every matching DevTools event (e.g. 'Network.webSocketFrameReceived') goes to handler(params, at)
    // until stop(); enable the domain's feature with page.cdp first if it needs one.
    onCdp: (event, handler, options = {}) => __cdpStream(target, event, handler, options),
    // Saves the tab's frames (JPEG) and frames.json to the workspace: {seconds} records and returns,
    // otherwise it returns {stop} to call later. Needs a visible window: openTab(url, {window: {...}}).
    recordTab: (options = {}) => __recordTab(target, options),
    // Resolves when the text of the matching elements changes (or a condition function returns a
    // truthy value); null on timeout. For listening routines: one event per check.
    waitForChange: async (selectorOrFn, options = {}) => {
      var arg = typeof selectorOrFn === 'function' ? {condition: selectorOrFn.toString()} : {selector: selectorOrFn};
      var first = await probe(arg), deadline = deadlineOf(options);
      if (first.error) throw Error(first.error);
      if (arg.condition && first.value) return {value: first.value};
      while (Date.now() < deadline) {
        await __sleep(options.intervalMs ?? 500);
        var now = await probe(arg);
        if (arg.condition ? now.value : now.value !== first.value)
          return arg.condition ? {value: now.value} : {before: first.value.slice(first.value.indexOf(':') + 1), after: now.value.slice(now.value.indexOf(':') + 1)};
      }
      return null;
    },
    // Resolves with the first new response whose URL contains match (and passes options.filter).
    waitForResponse: async (match = '', options = {}) => {
      await recording();
      var listed = await __call({network: 'list', target, match});
      var seen = new Set(listed.map((entry) => entry.id)), deadline = deadlineOf(options);
      while (Date.now() < deadline) {
        await __sleep(300);
        for (var entry of await __call({network: 'list', target, match})) {
          if (seen.has(entry.id) || !entry.status) continue;
          seen.add(entry.id);
          var body = await __call({network: 'body', target, id: entry.id}).catch(() => undefined);
          var found = {id: entry.id, url: entry.url, method: entry.method, status: entry.status, body};
          if (!options.filter || options.filter(found)) return found;
        }
      }
      return null;
    },
    // Resolves with new messages received on the page's WebSockets or event streams (matching text).
    waitForMessage: async (match = '', options = {}) => {
      await recording();
      var counts = new Map(), deadline = deadlineOf(options);
      var streams = async () => (await __call({network: 'list', target})).filter((entry) => entry.type === 'WebSocket' || entry.type === 'EventSource');
      for (var stream of await streams()) {
        var full = await __call({network: 'get', target, id: stream.id});
        counts.set(stream.id, (full.frames || full.messages || []).length);
      }
      while (Date.now() < deadline) {
        await __sleep(300);
        for (var stream of await streams()) {
          var full = await __call({network: 'get', target, id: stream.id});
          var items = full.frames || full.messages || [], from = counts.get(stream.id) ?? 0;
          counts.set(stream.id, items.length);
          var fresh = items.slice(from).filter((item) => item.direction !== 'sent' && String(item.data).includes(match));
          if (fresh.length) return {url: full.url, messages: fresh.map((item) => item.data)};
        }
      }
      return null;
    },
    // Records a playing video or audio element (its sound included) for some seconds into the
    // workspace as WebM. Protected (DRM) media cannot be recorded.
    recordMedia: async (selector = 'video, audio', options = {}) => {
      var mediaCall = (arg) => __isolatedEval(target, '(' + __mediaRecorder.toString() + ')(' + JSON.stringify(arg) + ')');
      var started = await mediaCall({action: 'start', selector});
      if (started.error) throw Error(started.error);
      await __sleep(Math.min(options.seconds ?? 20, 50) * 1000);
      var result = await mediaCall({action: 'stop'});
      if (result.error) throw Error(result.error);
      var name = options.name || 'recording-' + Date.now() + (result.type.startsWith('video') ? '.webm' : '.weba');
      await __call({workspace: 'artifact', name, value: result.base64, base64: true});
      return {saved: name, type: result.type, bytes: result.bytes};
    },
  });
}
`;
