import {
  holdBrowserDebugger,
  onBrowserDebuggerAttached,
  withBrowserDebugger,
} from "./native-browser-session.js";
import { toHar, type NetworkEntry } from "./native-browser-network-format.js";
import { privateAddress } from "./native-browser-policy.js";
import { listEntries, recentOf } from "./native-browser-network-list.js";
import {
  attachChild,
  childScopes,
  NETWORK_BUFFERS,
  scopeKey,
  type ChildScope,
} from "./native-browser-network-scopes.js";
import { dryRunActive, setDryRun } from "./native-browser-dry-run.js";
import { onEngineInstall } from "./native-engine-install.js";
import {
  bodyPreview,
  describeWait,
  waitMatcher,
  type Waitable,
} from "./native-browser-network-wait.js";
import { isTrackerUrl, takeLearned } from "./native-browser-network-learn.js";
import { rememberSessionHeaders, sessionHeadersFor } from "./native-browser-session-headers.js";
import { hideSecrets } from "./native-browser-secrets.js";
import { recordGlobalEntry } from "./network-store.js";
// Network recording for learning a site's own APIs. While a tab records, its API traffic is
// kept with full headers (cookies included), the script that made each call, request and
// response bodies (captured as each request finishes, before navigation discards them),
// redirects, WebSocket frames and server-sent events. The debugger stays attached meanwhile.
const MAX_ENTRIES = 1500;
const DEFAULT_MAX_BODY = 1_000_000;
const MAX_TOTAL_BODY = 60_000_000;
const MAX_FRAMES = 200;
const API_TYPES = new Set(["XHR", "Fetch", "EventSource", "WebSocket", "Document"]);
// A passively recorded tab keeps the page itself and the site's own calls, not fonts and images.
const PASSIVE_TYPES = new Set(["XHR", "Fetch", "Document"]);
const PASSIVE_MAX_BODY = 256_000;
const TEXTUAL = /json|text|javascript|xml|html|graphql|x-www-form-urlencoded|csv|event-stream/i;
interface Recorder {
  entries: Map<string, NetworkEntry>;
  /** Extra-info headers that arrived before their request. */
  early: Map<string, Record<string, unknown>>;
  allTypes: boolean;
  bodies: boolean;
  maxBody: number;
  bodyBytes: number;
  /**
   * Started by the agent working in the tab (learn-start), not asked for: only the site's own
   * fetch/XHR calls, no trackers, smaller bodies, and the debugger is not held for it.
   */
  passive?: boolean;
  /** Requests already handed over by take. */
  taken?: Set<string>;
  /** Capture began before the tab's first request (openTab/page.navigate), not after a load. */
  fromStart?: boolean;
  /** page.network.waitFor callers still waiting for one request to finish. */
  waiters?: Set<Waiter>;
  /** Set while a child session event is handled, so its entry says where it came from. */
  scope?: ChildScope | undefined;
}
interface Waiter {
  matches(entry: Waitable): boolean;
  resolve(entry: NetworkEntry): void;
  timer: ReturnType<typeof setTimeout>;
}
const recorders = new Map<number, Recorder>();
/** Recordings that were stopped: still readable (list, har, save) until a new start or the tab closes. */
const stopped = new Map<number, Recorder>();
type Params = Record<string, unknown>;
// Runs inside the attach itself, so it talks to the debugger directly.
onBrowserDebuggerAttached(async (tabId) => {
  if (recorders.has(tabId))
    await chrome.debugger.sendCommand({ tabId }, "Network.enable", NETWORK_BUFFERS);
});
onEngineInstall(() => {
  chrome.debugger.onEvent.addListener((source, method, raw) => {
    const tabId = source.tabId;
    if (tabId === undefined) return;
    const params = (raw ?? {}) as Params;
    if (method === "Target.attachedToTarget") return attachChild(tabId, params);
    if (method === "Target.detachedFromTarget") {
      childScopes.delete(scopeKey(tabId, String(params.sessionId ?? "")));
      return;
    }
    const recorder = recorders.get(tabId);
    if (!recorder) return;
    const scope = source.sessionId ? childScopes.get(scopeKey(tabId, source.sessionId)) : undefined;
    // A child session is only interesting for its own traffic.
    if (source.sessionId && !scope) return;
    const handler = HANDLERS[method];
    if (!handler) return;
    recorder.scope = scope
      ? { ...scope, ...(source.sessionId ? { sessionId: source.sessionId } : {}) }
      : undefined;
    try {
      handler(recorder, params, tabId);
    } finally {
      recorder.scope = undefined;
    }
  });
});

const HANDLERS: Record<string, (recorder: Recorder, params: Params, tabId: number) => void> = {
  "Network.requestWillBeSent": requestWillBeSent,
  "Network.requestWillBeSentExtraInfo": (recorder, params) =>
    mergeHeaders(recorder, params, "requestHeaders"),
  "Network.responseReceived": responseReceived,
  "Network.responseReceivedExtraInfo": (recorder, params) =>
    mergeHeaders(recorder, params, "responseHeaders"),
  "Network.loadingFinished": loadingFinished,
  "Network.loadingFailed": (recorder, params, tabId) => {
    const entry = recorder.entries.get(String(params.requestId));
    if (!entry) return;
    entry.failed = String(params.errorText ?? "failed");
    entry.done = true;
    recordGlobalEntry(tabId, entry, entry.documentURL);
    notifyWaiters(recorder, entry);
  },
  "Network.webSocketCreated": (recorder, params) =>
    add(recorder, {
      id: String(params.requestId),
      url: String(params.url),
      method: "GET",
      type: "WebSocket",
      startedAt: Date.now(),
      requestHeaders: {},
      ...initiatorOf(params.initiator),
      frames: [],
      done: false,
    }),
  "Network.webSocketHandshakeResponseReceived": (recorder, params) => {
    const entry = recorder.entries.get(String(params.requestId));
    const response = params.response as Params | undefined;
    if (!entry || !response) return;
    entry.status = Number(response.status);
    entry.responseHeaders = headers(response.headers);
  },
  "Network.webSocketFrameSent": (recorder, params) => frame(recorder, params, "sent"),
  "Network.webSocketFrameReceived": (recorder, params) => frame(recorder, params, "received"),
  "Network.webSocketClosed": (recorder, params) => {
    const entry = recorder.entries.get(String(params.requestId));
    if (entry) entry.done = true;
  },
  "Network.eventSourceMessageReceived": (recorder, params) => {
    const entry = recorder.entries.get(String(params.requestId));
    if (!entry) return;
    entry.messages ??= [];
    if (entry.messages.length < MAX_FRAMES)
      entry.messages.push({
        at: Date.now(),
        event: String(params.eventName ?? "message"),
        data: String(params.data ?? "").slice(0, 20_000),
      });
  },
};

function requestWillBeSent(recorder: Recorder, params: Params): void {
  const id = String(params.requestId ?? "");
  const type = String(params.type ?? "Other");
  const request = params.request as Params;
  const existing = recorder.entries.get(id);
  if (existing && params.redirectResponse) {
    const redirect = params.redirectResponse as Params;
    existing.redirects ??= [];
    existing.redirects.push({
      url: existing.url,
      status: Number(redirect.status),
      headers: headers(redirect.headers),
    });
    existing.url = String(request.url);
    existing.method = String(request.method);
    return;
  }
  if (!recorder.allTypes && !API_TYPES.has(type)) return;
  if (recorder.passive && (!PASSIVE_TYPES.has(type) || isTrackerUrl(String(request.url)))) return;
  const entry: NetworkEntry = {
    id,
    url: String(request.url),
    method: String(request.method),
    type,
    startedAt: Math.round(Number(params.wallTime ?? Date.now() / 1000) * 1000),
    requestHeaders: headers(request.headers),
    ...initiatorOf(params.initiator),
    done: false,
  };
  if (typeof params.frameId === "string") entry.frameId = params.frameId;
  if (recorder.scope) {
    if (recorder.scope.sessionId) entry.sessionId = recorder.scope.sessionId;
    if (recorder.scope.frameUrl) entry.frameUrl = recorder.scope.frameUrl;
    if (recorder.scope.source) entry.source = recorder.scope.source;
  }
  if (typeof params.documentURL === "string") entry.documentURL = params.documentURL;
  if (typeof request.postData === "string") entry.requestBody = hideSecrets(request.postData);
  else if (request.hasPostData) entry.requestBodyPending = true;
  add(recorder, entry);
  rememberSessionHeaders(entry.url, entry.requestHeaders);
  const early = recorder.early.get(id);
  if (early) {
    recorder.early.delete(id);
    mergeHeaders(recorder, early, "requestHeaders");
  }
}

function responseReceived(recorder: Recorder, params: Params): void {
  const entry = recorder.entries.get(String(params.requestId));
  const response = params.response as Params | undefined;
  if (!entry || !response) return;
  entry.status = Number(response.status);
  entry.statusText = String(response.statusText ?? "");
  entry.mimeType = String(response.mimeType ?? "");
  entry.responseHeaders = { ...headers(response.headers), ...entry.responseHeaders };
  if (typeof response.protocol === "string") entry.protocol = response.protocol;
  if (typeof response.remoteIPAddress === "string")
    entry.remoteIPAddress = response.remoteIPAddress;
  const privateRemote = privateAddress(entry.remoteIPAddress ?? "");
  if (privateRemote)
    entry.privateNetwork =
      `PRIVATE_NETWORK: the request reached ${privateRemote} after the URL preflight; ` +
      "this is a DNS-rebinding result, not an allowed destination";
}

function loadingFinished(recorder: Recorder, params: Params, tabId: number): void {
  const entry = recorder.entries.get(String(params.requestId));
  if (!entry) return;
  entry.size = Number(params.encodedDataLength ?? 0);
  entry.durationMs = Math.max(0, Date.now() - entry.startedAt);
  entry.done = true;
  const captured = recorder.bodies ? captureBodies(tabId, recorder, entry) : Promise.resolve();
  void captured.finally(() => {
    recordGlobalEntry(tabId, entry, entry.documentURL);
    notifyWaiters(recorder, entry);
  });
}

/** A finished request wakes the page.network.waitFor calls that were waiting for it. */
function notifyWaiters(recorder: Recorder, entry: NetworkEntry): void {
  if (!recorder.waiters?.size) return;
  for (const waiter of [...recorder.waiters]) {
    if (!waiter.matches(entry)) continue;
    clearTimeout(waiter.timer);
    recorder.waiters.delete(waiter);
    waiter.resolve(entry);
  }
}

/** Fetches the response body (and an omitted request body) while the browser still has them. */
async function captureBodies(tabId: number, recorder: Recorder, entry: NetworkEntry) {
  const textual = TEXTUAL.test(entry.mimeType ?? "") || entry.type === "Fetch";
  if (entry.requestBodyPending) {
    const post = await command(
      tabId,
      "Network.getRequestPostData",
      { requestId: entry.id },
      entry.sessionId,
    );
    if (typeof post?.postData === "string") entry.requestBody = hideSecrets(post.postData);
    delete entry.requestBodyPending;
  }
  if (!textual || (entry.size ?? 0) > recorder.maxBody * 2) return;
  const result = await command(
    tabId,
    "Network.getResponseBody",
    { requestId: entry.id },
    entry.sessionId,
  );
  if (typeof result?.body !== "string") return;
  const text = result.base64Encoded ? "" : result.body;
  if (result.base64Encoded) entry.bodyBase64 = true;
  entry.bodyBytes = text.length;
  entry.body = text.length > recorder.maxBody ? text.slice(0, recorder.maxBody) : text;
  if (text.length > recorder.maxBody) entry.bodyTruncated = true;
  recorder.bodyBytes += entry.body.length;
  trimBodies(recorder);
}

function command(
  tabId: number,
  method: string,
  params: Params,
  sessionId?: string,
): Promise<{ body?: string; base64Encoded?: boolean; postData?: string } | undefined> {
  return chrome.debugger
    .sendCommand(sessionId ? { tabId, sessionId } : { tabId }, method, params)
    .then((value) => value as { body?: string; base64Encoded?: boolean; postData?: string })
    .catch(() => undefined);
}

/** Keeps memory bounded: the oldest bodies go first, their requests stay listed. */
function trimBodies(recorder: Recorder): void {
  for (const entry of recorder.entries.values()) {
    if (recorder.bodyBytes <= MAX_TOTAL_BODY) return;
    if (!entry.body) continue;
    recorder.bodyBytes -= entry.body.length;
    delete entry.body;
    entry.bodyDropped = true;
  }
}

function add(recorder: Recorder, entry: NetworkEntry): void {
  recorder.entries.set(entry.id, entry);
  for (const [key, old] of recorder.entries) {
    if (recorder.entries.size <= MAX_ENTRIES) break;
    recorder.bodyBytes -= old.body?.length ?? 0;
    recorder.entries.delete(key);
  }
}

function mergeHeaders(
  recorder: Recorder,
  params: Params,
  field: "requestHeaders" | "responseHeaders",
): void {
  const id = String(params.requestId ?? "");
  const entry = recorder.entries.get(id);
  if (!entry) {
    if (field === "requestHeaders" && recorder.early.size < 500) recorder.early.set(id, params);
    return;
  }
  entry[field] = { ...entry[field], ...headers(params.headers) };
  if (field === "requestHeaders") rememberSessionHeaders(entry.url, entry.requestHeaders);
}

function frame(recorder: Recorder, params: Params, direction: "sent" | "received"): void {
  const entry = recorder.entries.get(String(params.requestId));
  const response = params.response as Params | undefined;
  if (!entry?.frames || !response || entry.frames.length >= MAX_FRAMES) return;
  entry.frames.push({
    direction,
    at: Date.now(),
    opcode: Number(response.opcode),
    data: String(response.payloadData ?? "").slice(0, 20_000),
  });
}

function headers(value: unknown): Record<string, string> {
  const result: Record<string, string> = {};
  if (!value || typeof value !== "object") return result;
  for (const [name, item] of Object.entries(value as Params)) result[name] = String(item);
  return result;
}

function initiatorOf(value: unknown): Pick<NetworkEntry, "initiator"> {
  const initiator = value as Params | undefined;
  if (!initiator) return {};
  const frames: { url: string; functionName: string; line: number }[] = [];
  let stack = initiator.stack as Params | undefined;
  while (stack && frames.length < 12) {
    for (const call of (stack.callFrames as Params[] | undefined) ?? []) {
      if (frames.length >= 12) break;
      frames.push({
        url: String(call.url ?? ""),
        functionName: String(call.functionName ?? ""),
        line: Number(call.lineNumber ?? 0) + 1,
      });
    }
    stack = stack.parent as Params | undefined;
  }
  const result: NonNullable<NetworkEntry["initiator"]> = { type: String(initiator.type ?? "") };
  if (typeof initiator.url === "string") result.url = initiator.url;
  if (frames.length) result.stack = frames;
  return { initiator: result };
}

onEngineInstall(() => {
  chrome.tabs.onRemoved.addListener((tabId) => {
    const recorder = recorders.get(tabId) ?? stopped.get(tabId);
    if (recorder) cancelWaiters(recorder);
    recorders.delete(tabId);
    stopped.delete(tabId);
    holdBrowserDebugger(tabId, false);
  });
});

async function enableNetwork(tabId: number): Promise<void> {
  await withBrowserDebugger(tabId, async (debuggee) => {
    await chrome.debugger.sendCommand(debuggee, "Network.enable", NETWORK_BUFFERS);
    // Workers and out-of-process iframes attach as they appear, so their requests land in the
    // same store as the top frame's (a player's resolver often runs in a service worker).
    await chrome.debugger
      .sendCommand(debuggee, "Target.setAutoAttach", {
        autoAttach: true,
        waitForDebuggerOnStart: false,
        flatten: true,
      })
      .catch(() => undefined);
  });
}

export async function networkCall(
  tabId: number,
  action: string,
  options: Params,
): Promise<unknown> {
  if (action === "start") return start(tabId, options);
  if (action === "learn-start") return learnStart(tabId);
  // For site API calls made from the site's page (site-to-api's page transport) only.
  if (action === "session-headers") return sessionHeadersFor(String(options.url ?? ""));
  if (action === "state") return stateOf(tabId);
  if (action === "take") {
    const recorder = recorders.get(tabId) ?? stopped.get(tabId);
    return recorder ? takeLearned(recorder) : { log: { version: "1.2", entries: [] } };
  }
  if (action === "stop") {
    await setDryRun(tabId, false);
    holdBrowserDebugger(tabId, false);
    const active = recorders.get(tabId);
    if (active) {
      cancelWaiters(active);
      stopped.set(tabId, active);
    }
    return { stopped: recorders.delete(tabId) };
  }
  const recorder = recorders.get(tabId) ?? stopped.get(tabId);
  if (!recorder) throw new Error("Not recording: call page.network.start() first");
  if (action === "list") {
    const rows = listEntries(recorder.entries.values(), options);
    if (options.cursor !== true && options.since === undefined) return rows;
    const cursor = rows.reduce<number>(
      (last, entry) => Math.max(last, Number((entry as { startedAt?: number }).startedAt ?? 0)),
      0,
    );
    return { entries: rows, cursor };
  }
  if (action === "waitFor") return waitForRequest(tabId, recorder, options);
  if (action === "failures") {
    const match = typeof options.match === "string" ? options.match : "";
    return failuresOf([...recorder.entries.values()], match);
  }
  if (action === "get") return entryOf(recorder, options.id);
  if (action === "body") return bodyOf(tabId, recorder, options.id);
  if (action === "har") return toHar([...recorder.entries.values()], { raw: options.raw === true });
  if (action === "clear") {
    recorder.entries.clear();
    recorder.bodyBytes = 0;
    return { cleared: true };
  }
  throw new Error("UNSUPPORTED: page.network." + action);
}

/**
 * The user's own tab, recording passively while they browse it (they switched it on for this
 * tab). The debugger is attached directly, not claimed for a chat: the tab stays where it is,
 * and Chrome shows its debugger bar while this is on.
 */
export async function learnUserTab(tabId: number, on: boolean): Promise<void> {
  if (!on) {
    // Only a passive recording is ours to detach; an agent tab keeps its debugger.
    if (!recorders.get(tabId)?.passive) return;
    recorders.delete(tabId);
    await chrome.debugger.detach({ tabId }).catch(() => undefined);
    return;
  }
  if (!recorders.has(tabId))
    recorders.set(tabId, {
      entries: new Map(),
      early: new Map(),
      allTypes: false,
      bodies: true,
      maxBody: PASSIVE_MAX_BODY,
      bodyBytes: 0,
      passive: true,
    });
  await chrome.debugger.attach({ tabId }, "1.3").catch((error: unknown) => {
    if (!/already attached/i.test(String(error))) throw error;
  });
  await chrome.debugger.sendCommand({ tabId }, "Network.enable", NETWORK_BUFFERS);
}

/**
 * Records the site's own requests while the agent works in the tab, so they can be learned as
 * an API after each step. Never replaces a recording that was asked for.
 */
async function learnStart(tabId: number): Promise<unknown> {
  if (recorders.has(tabId)) return { recording: true };
  recorders.set(tabId, {
    entries: new Map(),
    early: new Map(),
    allTypes: false,
    bodies: true,
    maxBody: PASSIVE_MAX_BODY,
    bodyBytes: 0,
    passive: true,
  });
  await enableNetwork(tabId);
  return { recording: true, passive: true };
}

/**
 * Begins recording a tab before its first request, so page.network.list() shows what a page
 * loaded even though the agent never called start(). Used by openTab and page.navigate.
 */
export async function captureFromTabStart(tabId: number): Promise<void> {
  await learnStart(tabId).catch(() => undefined);
  const recorder = recorders.get(tabId);
  if (recorder) recorder.fromStart = true;
}

async function start(tabId: number, options: Params): Promise<unknown> {
  const recorder: Recorder = recorders.get(tabId) ??
    stopped.get(tabId) ?? {
      entries: new Map(),
      early: new Map(),
      allTypes: false,
      bodies: true,
      maxBody: DEFAULT_MAX_BODY,
      bodyBytes: 0,
    };
  // Asking for a recording turns a passive one into a full one, keeping what it has.
  delete recorder.passive;
  recorder.maxBody = Math.max(recorder.maxBody, DEFAULT_MAX_BODY);
  if (options.types !== undefined) recorder.allTypes = options.types === "all";
  if (options.bodies !== undefined) recorder.bodies = options.bodies !== false;
  if (typeof options.maxBodyBytes === "number" && options.maxBodyBytes > 0)
    recorder.maxBody = Math.min(options.maxBodyBytes, 10_000_000);
  stopped.delete(tabId);
  recorders.set(tabId, recorder);
  holdBrowserDebugger(tabId, true);
  await enableNetwork(tabId);
  if (options.dryRun !== undefined) await setDryRun(tabId, options.dryRun === true);
  return {
    recording: true,
    types: recorder.allTypes ? "all" : "api",
    bodies: recorder.bodies,
    dryRun: dryRunActive(tabId),
  };
}

/**
 * Why a list came back empty: the tab is recorded from its first request on, so an empty list
 * means the page loaded before this chat had the tab. Says so instead of leaving a bare [].
 */
function stateOf(tabId: number): Record<string, unknown> {
  const recording = recorders.get(tabId);
  if (!recording)
    return stopped.has(tabId)
      ? { recording: false, entries: 0, note: "network capture is stopped: page.network.start()" }
      : {
          recording: false,
          entries: 0,
          note: "nothing captured in this tab yet: capture starts when this chat opens or navigates a tab; reload the page to capture it",
        };
  const entries = [...recording.entries.values()];
  const first = entries.length ? Math.min(...entries.map((entry) => entry.startedAt)) : undefined;
  return {
    recording: true,
    passive: recording.passive === true,
    entries: entries.length,
    ...(first ? { since: new Date(first).toISOString() } : {}),
    ...(entries.length ? { recent: recentOf(entries) } : {}),
    ...(entries.length
      ? {}
      : {
          note: recording.fromStart
            ? "nothing recorded in this tab yet: the page has made no requests since the chat opened it (the page itself and its fetch/XHR calls are listed); page.network.start() records everything"
            : "capture began after the page loaded: reload to capture its requests, or page.network.start() before the flow",
        }),
  };
}

/** The last few requests, for "nothing matched, but this is what happened". */
const WAIT_TIMEOUT_MS = 15_000;
const WAIT_MAX_MS = 120_000;

/**
 * Resolves with the first request matching the pattern that finishes from now on (or one already
 * in flight). A timeout names the pattern and what was captured meanwhile.
 */
async function waitForRequest(
  tabId: number,
  recorder: Recorder,
  options: Params,
): Promise<unknown> {
  const matches = waitMatcher(options);
  const label = describeWait(options);
  const timeoutMs = Math.min(
    WAIT_MAX_MS,
    Math.max(500, Number(options.timeoutMs ?? WAIT_TIMEOUT_MS) || WAIT_TIMEOUT_MS),
  );
  const entry = await raceRequest(recorder, matches, timeoutMs, label);
  if (entry.body === undefined && !entry.bodyBase64 && entry.mimeType?.match(TEXTUAL))
    await captureBodies(tabId, recorder, entry).catch(() => undefined);
  return waitedEntry(entry);
}

function raceRequest(
  recorder: Recorder,
  matches: (entry: Waitable) => boolean,
  timeoutMs: number,
  label: string,
): Promise<NetworkEntry> {
  return new Promise<NetworkEntry>((resolve, reject) => {
    const waiter: Waiter = {
      matches,
      resolve,
      timer: setTimeout(() => {
        recorder.waiters?.delete(waiter);
        reject(
          new Error(
            "TIMEOUT: no request matching " +
              label +
              " completed within " +
              timeoutMs +
              " ms" +
              recentHint(recorder),
          ),
        );
      }, timeoutMs),
    };
    recorder.waiters ??= new Set();
    recorder.waiters.add(waiter);
  });
}

function cancelWaiters(recorder: Recorder): void {
  for (const waiter of [...(recorder.waiters ?? [])]) {
    clearTimeout(waiter.timer);
    recorder.waiters?.delete(waiter);
  }
}

/** A timeout is clearer with the last few requests the tab made. */
function recentHint(recorder: Recorder): string {
  const recent = [...recorder.entries.values()]
    .filter((entry) => entry.done)
    .slice(-3)
    .map(
      (entry) => entry.method + " " + pathOf(entry.url) + (entry.status ? " " + entry.status : ""),
    );
  if (!recent.length) return "; nothing was captured in this tab: page.network.list() says why";
  return "; captured meanwhile: " + recent.join(", ") + ". page.network.list() has the rest";
}

function waitedEntry(entry: NetworkEntry): Record<string, unknown> {
  return {
    id: entry.id,
    method: entry.method,
    url: entry.url,
    type: entry.type,
    ...(entry.status !== undefined ? { status: entry.status } : {}),
    ...(entry.statusText ? { statusText: entry.statusText } : {}),
    ...(entry.failed ? { failed: entry.failed } : {}),
    ...(entry.mimeType ? { mimeType: entry.mimeType } : {}),
    ...(entry.durationMs !== undefined ? { durationMs: entry.durationMs } : {}),
    ...(entry.size !== undefined ? { size: entry.size } : {}),
    headers: responseHeadersOf(entry.responseHeaders),
    body: bodyPreview(entry),
  };
}

/** Response headers, capped: enough to read a content type or a block header. */
function responseHeadersOf(headers: Record<string, string> | undefined): Record<string, string> {
  const all = Object.entries(headers ?? {});
  const kept = Object.fromEntries(
    all.slice(0, 40).map(([name, value]) => [name.toLowerCase(), String(value).slice(0, 500)]),
  );
  return all.length > 40 ? { ...kept, "x-headers-not-shown": String(all.length - 40) } : kept;
}

/**
 * Failed requests grouped by endpoint, for `page.network.failures()` and the repeated-refusal
 * note: statuses, request/response bytes, timing, the block headers that name the edge, a body
 * snippet, and the last success on that endpoint. Repeated size probes become one obvious number.
 */
export function failuresOf(
  entries: readonly NetworkEntry[],
  match = "",
): Array<Record<string, unknown>> {
  const groups = new Map<string, FailureGroup>();
  for (const entry of entries) {
    if (!entry.done || entry.status === undefined) continue;
    if (match && !entry.url.includes(match)) continue;
    const key = endpointOf(entry);
    const group = groups.get(key) ?? {
      method: entry.method,
      path: pathOf(entry.url),
      failures: [],
      success: undefined,
    };
    if (entry.status >= 400 || entry.status === 0) group.failures.push(entry);
    else if (!group.success || entry.startedAt > group.success.startedAt) group.success = entry;
    groups.set(key, group);
  }
  return [...groups.values()]
    .filter((group) => group.failures.length)
    .sort((left, right) => right.failures.length - left.failures.length)
    .slice(0, 20)
    .map((group) => {
      const last = group.failures[group.failures.length - 1];
      return {
        method: group.method,
        path: group.path,
        attempts: group.failures.length,
        statuses: [...new Set(group.failures.map((entry) => entry.status))],
        last: last ? failureOf(last) : null,
        lastSuccess: group.success ? sizeOf(group.success) : null,
      };
    });
}

interface FailureGroup {
  method: string;
  path: string;
  failures: NetworkEntry[];
  success: NetworkEntry | undefined;
}

function endpointOf(entry: NetworkEntry): string {
  return entry.method + " " + pathOf(entry.url);
}

export function recorderOf(tabId: number): { entries: Map<string, NetworkEntry> } | undefined {
  return recorders.get(tabId) ?? stopped.get(tabId);
}

function pathOf(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.origin + parsed.pathname;
  } catch {
    return url.split("?")[0] ?? url;
  }
}

function failureOf(entry: NetworkEntry): Record<string, unknown> {
  return {
    status: entry.status ?? 0,
    ...(entry.statusText ? { statusText: entry.statusText } : {}),
    requestBytes: requestBytesOf(entry),
    responseBytes: sizeOf(entry).responseBytes,
    durationMs: entry.durationMs ?? null,
    ...blockHeaders(entry.responseHeaders),
    ...(entry.failed ? { failed: entry.failed } : {}),
    ...(entry.body ? { body: entry.body.slice(0, 500) } : {}),
  };
}

function sizeOf(entry: NetworkEntry): {
  status: number;
  requestBytes: number;
  responseBytes: number;
} {
  return {
    status: entry.status ?? 0,
    requestBytes: requestBytesOf(entry),
    responseBytes: entry.bodyBytes ?? entry.size ?? entry.body?.length ?? 0,
  };
}

/** CDP returns binary post data base64-encoded; text bodies are plain. Estimate the real bytes. */
function requestBytesOf(entry: NetworkEntry): number {
  const body = entry.requestBody ?? "";
  if (!body) return 0;
  if (body.length > 64 && /^[A-Za-z0-9+/=\r\n]+$/.test(body)) {
    const clean = body.replace(/\s/g, "");
    const padding = clean.endsWith("==") ? 2 : clean.endsWith("=") ? 1 : 0;
    return Math.floor((clean.length * 3) / 4) - padding;
  }
  return body.length;
}

/** The headers that name a CDN/WAF or a rate limit, without dumping every header. */
function blockHeaders(headers: Record<string, string> | undefined): Record<string, unknown> {
  const wanted =
    /^(server|via|x-cache|retry-after|akamai-grn|cf-ray|x-akamai-|x-ratelimit-|x-amzn-|x-served-by)/i;
  const found: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers ?? {})) {
    if (wanted.test(name)) found[name.toLowerCase()] = String(value).slice(0, 200);
  }
  return Object.keys(found).length ? { headers: found } : {};
}

function entryOf(recorder: Recorder, id: unknown): NetworkEntry {
  const entry = recorder.entries.get(String(id ?? ""));
  if (!entry) throw new Error("Unknown request id: use an id from page.network.list()");
  return entry;
}

async function bodyOf(tabId: number, recorder: Recorder, id: unknown): Promise<unknown> {
  const entry = entryOf(recorder, id);
  if (!entry.done) throw new Error("That request is still loading; try again shortly");
  if (entry.body === undefined && !entry.bodyBase64) await captureBodies(tabId, recorder, entry);
  if (entry.bodyBase64) return { binary: true, bytes: entry.size ?? 0 };
  if (entry.body === undefined)
    return { unavailable: true, reason: entry.bodyDropped ? "dropped to save memory" : "no body" };
  if (!entry.bodyTruncated) {
    try {
      return JSON.parse(entry.body) as unknown;
    } catch {
      // Not JSON: return the text.
    }
  }
  return {
    text: entry.body,
    ...(entry.bodyTruncated ? { truncated: true, length: entry.bodyBytes } : {}),
  };
}
