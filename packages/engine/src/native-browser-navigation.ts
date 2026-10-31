import { noteDeviceEmulation } from "./native-browser-session.js";
import type { BrowserExecutorRequest } from "@browserkit/protocol";
import { BrowserActionError } from "./native-browser-common.js";
import { refusedCdp } from "./native-browser-guards.js";
import { onEngineInstall } from "./native-engine-install.js";

interface Activity {
  pending: Map<string, number>;
  last: number;
}
export interface PageProbe {
  ready: string;
  idle: number;
  url: string;
  document: string;
  changes: number;
}
export interface PageSettle {
  why: "quiet" | "cap" | "error";
  ms: number;
  pending: number;
  /** A network request finished after this settle window started. */
  network?: boolean;
  probe?: PageProbe;
}
const activity = new Map<number, Activity>();
export function trackBrowserActivity(tabId: number): void {
  activity.set(tabId, { pending: new Map(), last: 0 });
}
export function forgetBrowserActivity(tabId: number): void {
  activity.delete(tabId);
}
onEngineInstall(() => {
  chrome.debugger.onEvent.addListener((source, method, raw) => {
    if (source.tabId === undefined) return;
    const state = activity.get(source.tabId);
    if (!state) return;
    const data = (raw ?? {}) as { requestId?: string; type?: string; defaultPrompt?: string };
    if (method === "Page.javascriptDialogOpening")
      void chrome.debugger
        .sendCommand(source, "Page.handleJavaScriptDialog", {
          accept: true,
          promptText: data.defaultPrompt ?? "",
        })
        .catch(() => undefined);
    captureNetworkActivity(
      state,
      (source.sessionId ?? "") + ":" + data.requestId,
      method,
      data.type,
    );
  });
});
function captureNetworkActivity(state: Activity, key: string, method: string, type?: string) {
  if (method === "Network.requestWillBeSent") {
    if (["WebSocket", "EventSource", "Media", "Ping", "Manifest"].includes(type ?? "")) return;
    state.pending.set(key, Date.now());
    if (state.pending.size > 1000) state.pending.delete(state.pending.keys().next().value ?? "");
    state.last = Date.now();
  } else if (
    ["Network.loadingFinished", "Network.loadingFailed"].includes(method) &&
    state.pending.delete(key)
  )
    state.last = Date.now();
}
export function primeBrowserSettle(
  debuggee: chrome.debugger.Debuggee,
): Promise<PageProbe | undefined> {
  return probe(debuggee).catch(() => undefined);
}
function networkState(tabId: number, since = 0) {
  const net = activity.get(tabId);
  return {
    pending: [...(net?.pending.values() ?? [])].filter((at) => Date.now() - at < 1500).length,
    quiet: Date.now() - (net?.last ?? 0) >= 80,
    active: (net?.last ?? 0) >= since,
  };
}
export async function settleBrowserPage(
  debuggee: chrome.debugger.Debuggee,
  capMs = 800,
  since = Date.now(),
  minQuietMs = 80,
): Promise<PageSettle> {
  const start = Date.now();
  let limit = capMs,
    pending = 0,
    state: PageProbe | undefined;
  while (Date.now() - start < limit) {
    try {
      state = await probe(debuggee);
      if (state?.ready === "loading") limit = Math.max(capMs, 3000);
      const net = networkState(debuggee.tabId ?? -1, since);
      pending = net.pending;
      if (isQuiet(state, net, since, minQuietMs))
        return {
          why: "quiet",
          ms: Date.now() - start,
          pending,
          network: net.active,
          probe: state,
        };
    } catch (error) {
      if (!/context|navigat|frame/i.test(String(error)))
        return { why: "error", ms: Date.now() - start, pending };
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return {
    why: "cap",
    ms: Date.now() - start,
    pending,
    network: networkState(debuggee.tabId ?? -1, since).active,
    ...(state ? { probe: state } : {}),
  };
}
function isQuiet(
  state: PageProbe | undefined,
  net: { pending: number; quiet: boolean },
  since: number,
  minQuietMs: number,
): state is PageProbe {
  return (
    !!state &&
    state.ready !== "loading" &&
    Math.min(state.idle, Date.now() - since) >= minQuietMs &&
    !net.pending &&
    net.quiet
  );
}
export function pageOutcome(
  before: PageProbe | undefined,
  after: PageProbe | undefined,
): "navigated" | "changed" | "unchanged" | "unknown" {
  if (!before || !after) return "unknown";
  if (before.document !== after.document || before.url !== after.url) return "navigated";
  return before.changes !== after.changes ? "changed" : "unchanged";
}
async function probe(debuggee: chrome.debugger.Debuggee): Promise<PageProbe | undefined> {
  const result = (await chrome.debugger.sendCommand(debuggee, "Runtime.evaluate", {
    expression: `(${domQuietProbe.toString()})()`,
    returnByValue: true,
  })) as { result?: { value?: PageProbe }; exceptionDetails?: unknown };
  if (result.exceptionDetails) throw new Error("Execution context changed");
  return result.result?.value;
}
function domQuietProbe() {
  const host = window as unknown as {
    __aeonQuiet?: { last: number; changes: number; document: string; observer: MutationObserver };
  };
  if (!host.__aeonQuiet) {
    const state = {
      last: performance.now(),
      changes: 0,
      document: Math.random().toString(36),
      observer: undefined as unknown as MutationObserver,
    };
    const styles = new WeakMap<Node, number>();
    state.observer = new MutationObserver((records) => {
      const now = performance.now();
      for (const record of records) {
        if (ownOverlay(record)) continue;
        if (overlayNode(record)) continue;
        if (unchangedAttribute(record)) continue;
        if (record.attributeName === "style") {
          const previous = styles.get(record.target) ?? -Infinity;
          styles.set(record.target, now);
          if (now - previous < 200) continue;
        }
        state.last = now;
        state.changes++;
      }
    });
    state.observer.observe(document, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeOldValue: true,
      characterData: true,
    });
    const changed = () => {
      state.last = performance.now();
      state.changes++;
    };
    document.addEventListener("input", changed, true);
    document.addEventListener("change", changed, true);
    host.__aeonQuiet = state;
  }
  return {
    ready: document.readyState,
    idle: performance.now() - host.__aeonQuiet.last,
    url: location.href,
    document: host.__aeonQuiet.document,
    changes: host.__aeonQuiet.changes,
  };
  function ownOverlay(record: MutationRecord) {
    return !!(record.target as Element).closest?.("[data-aeon-overlay]");
  }
  function overlayNode(record: MutationRecord) {
    for (const node of [...record.addedNodes, ...record.removedNodes]) {
      if (
        node instanceof Element &&
        (node.matches("[data-aeon-overlay]") || node.closest("[data-aeon-overlay]"))
      )
        return true;
    }
    return false;
  }
  function unchangedAttribute(record: MutationRecord) {
    return (
      !!record.attributeName &&
      record.oldValue === (record.target as Element).getAttribute(record.attributeName)
    );
  }
}

export async function waitPageInteractive(tabId: number, timeoutMs = 2000): Promise<boolean> {
  return (await settleBrowserPage({ tabId }, timeoutMs)).why === "quiet";
}

export async function viewportFingerprint(debuggee: chrome.debugger.Debuggee): Promise<string> {
  const result = (await chrome.debugger.sendCommand(debuggee, "Runtime.evaluate", {
    expression: `(${layoutProbe.toString()})()`,
    returnByValue: true,
  })) as { result?: { value?: string }; exceptionDetails?: unknown };
  if (result.exceptionDetails || typeof result.result?.value !== "string" || !result.result.value)
    throw new Error("STALE_REF");
  return result.result.value;
}
function layoutProbe(): string {
  const elements = [...document.querySelectorAll("*")];
  const boxes: unknown[] = [];
  for (const el of elements) {
    const box = el.getBoundingClientRect();
    if (
      box.width <= 0 ||
      box.height <= 0 ||
      box.bottom < 0 ||
      box.top > innerHeight ||
      box.right < 0 ||
      box.left > innerWidth ||
      getComputedStyle(el).visibility === "hidden"
    )
      continue;
    boxes.push([
      el.tagName,
      el.id,
      el.getAttribute("aria-label"),
      el.getAttribute("href"),
      (el.textContent ?? "").trim().slice(0, 80),
      ...[box.x, box.y, box.width, box.height].map(Math.round),
    ]);
    if (boxes.length >= 2000) return "";
  }
  return JSON.stringify([scrollX, scrollY, innerWidth, innerHeight, visualViewport?.scale, boxes]);
}

const INTERIM_PAGE = /^(chrome-extension|chrome|edge|about|chrome-search|chrome-untrusted):/i;

// Resolves once the tab has committed to the requested page and reached DOMContentLoaded.
export async function navigateReady(
  tabId: number,
  url: string,
  timeoutMs = 8000,
  referer?: string,
): Promise<{ url: string; timedOut: boolean }> {
  const navigation = await new Promise<{ url: string; timedOut: boolean }>((resolve, reject) => {
    let committed = false;
    const top = (event: { tabId: number; frameId: number }) =>
      event.tabId === tabId && event.frameId === 0;
    const clean = () => {
      clearTimeout(timer);
      chrome.webNavigation.onCommitted.removeListener(commit);
      chrome.webNavigation.onDOMContentLoaded.removeListener(ready);
      chrome.webNavigation.onErrorOccurred.removeListener(error);
      chrome.webNavigation.onHistoryStateUpdated.removeListener(sameDocument);
      chrome.webNavigation.onReferenceFragmentUpdated.removeListener(sameDocument);
    };
    const finish = (nextUrl: string, timedOut = false) => {
      clean();
      resolve({ url: nextUrl, timedOut });
    };
    // A new-tab, extension or blank page committed on the way is not the requested page.
    const interim = (eventUrl: string) => INTERIM_PAGE.test(eventUrl) && !INTERIM_PAGE.test(url);
    const commit = (event: chrome.webNavigation.WebNavigationTransitionCallbackDetails) => {
      if (top(event) && !interim(event.url)) committed = true;
    };
    const ready = (event: chrome.webNavigation.WebNavigationFramedCallbackDetails) => {
      if (top(event) && committed && !interim(event.url)) finish(event.url);
    };
    const sameDocument = (event: chrome.webNavigation.WebNavigationTransitionCallbackDetails) => {
      if (top(event) && !interim(event.url)) finish(event.url);
    };
    const error = (event: chrome.webNavigation.WebNavigationFramedErrorCallbackDetails) => {
      if (top(event) && !event.error.includes("ERR_ABORTED")) {
        clean();
        reject(new BrowserActionError("CHROME_ERROR", "navigation failed: " + event.error));
      }
    };
    const timer = setTimeout(
      () => {
        clean();
        void chrome.tabs
          .get(tabId)
          .then((tab) => resolve({ url: tab.url ?? url, timedOut: true }), reject);
      },
      Math.max(100, timeoutMs - 2000),
    );
    chrome.webNavigation.onCommitted.addListener(commit);
    chrome.webNavigation.onDOMContentLoaded.addListener(ready);
    chrome.webNavigation.onErrorOccurred.addListener(error);
    chrome.webNavigation.onHistoryStateUpdated.addListener(sameDocument);
    chrome.webNavigation.onReferenceFragmentUpdated.addListener(sameDocument);
    const navigate = referer
      ? chrome.debugger.sendCommand({ tabId }, "Page.navigate", { url, referrer: referer })
      : chrome.tabs.update(tabId, { url });
    void navigate.catch((cause) => {
      clean();
      reject(cause);
    });
  });
  const interactive = await waitPageInteractive(tabId);
  return { ...navigation, timedOut: navigation.timedOut || !interactive };
}

// Only commands that can change what the page shows wait for it to settle. Getters, captures,
// emulation, screencasts and pointer moves return at once, so fine-grained input stays fast.
const SETTLING_CDP =
  /^(Input\.(dispatchKeyEvent|insertText|dispatchTouchEvent)|Page\.(navigate|reload|navigateToHistoryEntry)|Runtime\.(evaluate|callFunctionOn)|DOM\.(set|remove|focus))/;
function cdpChangesPage(method: string, params: unknown): boolean {
  if (method === "Input.dispatchMouseEvent")
    return (params as { type?: string } | undefined)?.type === "mouseReleased";
  return SETTLING_CDP.test(method);
}
type Request = BrowserExecutorRequest & {
  step: Extract<BrowserExecutorRequest["step"], { op: "evaluate" | "cdp" | "waitFor" }>;
};
export async function executePageCode(
  debuggee: chrome.debugger.Debuggee,
  request: Request,
  revalidate: () => Promise<void>,
): Promise<unknown> {
  const step = request.step;
  if (step.op === "waitFor") {
    const start = Date.now();
    while (Date.now() - start < step.timeoutMs) {
      await revalidate();
      const value = await evaluatePage(
        debuggee,
        step.expression,
        Math.max(1, step.timeoutMs - (Date.now() - start)),
      );
      if (value) return { found: true, ms: Date.now() - start };
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    throw new BrowserActionError(
      "TIMEOUT",
      "Page condition did not become true. Inspect the current state before proceeding.",
    );
  }
  const readOnly = step.op === "cdp" && !cdpChangesPage(step.method, step.params);
  if (!readOnly) await primeBrowserSettle(debuggee);
  let value: unknown;
  if (step.op === "evaluate") {
    const before = await pageFingerprint(debuggee);
    value = await evaluatePage(debuggee, step.expression, 8000);
    const settle = await settleBrowserPage(debuggee, 800, Date.now(), 0);
    // A read that left the page as it was needs no fresh observation afterwards.
    const changed = before === undefined || before !== (await pageFingerprint(debuggee));
    return { value, settle, changed };
  } else {
    // This command operates on the claimed page session, never on a browser-wide or another target session.
    if (["Target", "Browser"].includes(step.method.split(".")[0] ?? ""))
      throw new BrowserActionError(
        "UNSUPPORTED",
        "Use browser.openTab/attachTab for target management; page.cdp addresses the selected page only.",
      );
    const refused = refusedCdp(step.method, step.params as Record<string, unknown>);
    if (refused) throw new BrowserActionError("UNSUPPORTED", refused);
    value = await chrome.debugger.sendCommand(debuggee, step.method, step.params);
    if (debuggee.tabId !== undefined) noteDeviceEmulation(debuggee.tabId, step.method, step.params);
  }
  return {
    value,
    ...(!readOnly ? { settle: await settleBrowserPage(debuggee, 800, Date.now(), 0) } : {}),
  };
}
// URL, element count and text length: cheap, and enough to tell a read from a change.
async function pageFingerprint(debuggee: chrome.debugger.Debuggee): Promise<string | undefined> {
  const result = (await chrome.debugger
    .sendCommand(debuggee, "Runtime.evaluate", {
      expression:
        "location.href+'|'+document.getElementsByTagName('*').length+'|'+(document.body?document.body.textContent.length:0)",
      returnByValue: true,
    })
    .catch(() => undefined)) as { result?: { value?: unknown } } | undefined;
  const value = result?.result?.value;
  return typeof value === "string" ? value : undefined;
}
export function hintEvaluateError(description: string): string {
  const text = String(description ?? "");
  if (/^ReferenceError/.test(text) && /\b(window|document|location|self|localStorage)\b/.test(text))
    return `${text}\nHint: this cell runs in the sandbox; use page.evaluate(...) or page.inspect(...) to run code in the page.`;
  if (
    /^TypeError/.test(text) &&
    /Cannot read properties of undefined \(reading 'querySelector'\)/.test(text)
  )
    return `${text}\nHint: this looks like page code running in the sandbox; use page.evaluate(...) or page.inspect(...).`;
  return text;
}

async function evaluatePage(
  debuggee: chrome.debugger.Debuggee,
  expression: string,
  timeout: number,
) {
  let result: {
    result?: { value?: unknown };
    exceptionDetails?: { text?: string; exception?: { description?: string } };
  };
  try {
    result = (await chrome.debugger.sendCommand(debuggee, "Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
      timeout,
    })) as typeof result;
  } catch (error) {
    if (!isEvaluationTimeout(error instanceof Error ? error.message : String(error))) throw error;
    throw await evaluationTimeout(debuggee, timeout, String(error));
  }
  if (result.exceptionDetails) {
    const detail =
      result.exceptionDetails.exception?.description ??
      result.exceptionDetails.text ??
      "Page evaluation failed";
    if (isEvaluationTimeout(detail)) throw await evaluationTimeout(debuggee, timeout, detail);
    throw new BrowserActionError("CHROME_ERROR", hintEvaluateError(detail).slice(0, 1800));
  }
  return result.result?.value;
}

function isEvaluationTimeout(text: string): boolean {
  return /timed out|timeout|execution (?:was )?terminated|script execution|internal error/i.test(
    text,
  );
}

/**
 * A timeout is already enforced by Runtime.evaluate. Terminate explicitly too, then probe with a
 * trivial evaluation so a late terminate cannot cancel the next call; the probe also tells the
 * caller whether the runaway script actually stopped.
 */
async function evaluationTimeout(
  debuggee: chrome.debugger.Debuggee,
  timeout: number,
  detail: string,
): Promise<BrowserActionError> {
  let terminated = false;
  try {
    await chrome.debugger.sendCommand(debuggee, "Runtime.terminateExecution", {});
    terminated = true;
  } catch {
    /* The execution may already be gone. */
  }
  let stopped = false;
  for (let attempt = 0; attempt < 2 && !stopped; attempt++) {
    if (attempt) await new Promise((resolve) => setTimeout(resolve, 80));
    stopped = await chrome.debugger
      .sendCommand(debuggee, "Runtime.evaluate", {
        expression: "1+1",
        returnByValue: true,
        timeout: 1000,
      })
      .then(
        (probe) => (probe as { result?: { value?: unknown } }).result?.value === 2,
        () => false,
      );
  }
  const flags = `{"executionStopped":${stopped && terminated},"mayHaveLateEffects":true}`;
  return new BrowserActionError(
    "TIMEOUT",
    `${detail.slice(0, 1200)}\nPage evaluation exceeded ${timeout}ms. ${flags}`,
  );
}
