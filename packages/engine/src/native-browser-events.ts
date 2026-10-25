import type { BrowserExecutorRequest, BrowserTargetKey } from "@browserkit/protocol";
import { onEngineInstall } from "./native-engine-install.js";

interface EventItem {
  method: string;
  params: Record<string, unknown>;
  at: number;
  tabId: number;
}
interface Subscription {
  chatId: string;
  target: BrowserTargetKey;
  event: string;
  sessionId?: string;
  expires: number;
  queue: EventItem[];
  dropped: number;
  wake?: (() => void) | undefined;
  error?: string;
}
const subscriptions = new Map<string, Subscription>();
export function publishBrowserEvent(
  tabId: number,
  method: string,
  params: Record<string, unknown>,
  sessionId?: string,
): void {
  for (const [id, entry] of subscriptions) {
    if (entry.expires < Date.now()) {
      subscriptions.delete(id);
      entry.error = "Subscription expired";
      entry.wake?.();
      continue;
    }
    if (entry.target.tabId !== tabId || entry.event !== method || entry.sessionId !== sessionId)
      continue;
    const limits = eventLimits(method);
    const encoded = JSON.stringify(params);
    if (encoded.length > limits.bytes) {
      entry.dropped++;
      continue;
    }
    entry.queue.push({ method, params, at: Date.now(), tabId });
    if (entry.queue.length > limits.queue) {
      entry.queue.shift();
      entry.dropped++;
    }
    entry.wake?.();
  }
}
// Screencast frames are images: they get room to pass through, and are acknowledged here so Chrome
// keeps sending them however fast the consumer drains.
function eventLimits(method: string): { bytes: number; queue: number } {
  return method === "Page.screencastFrame"
    ? { bytes: 900_000, queue: 240 }
    : { bytes: 16000, queue: 16 };
}
function acknowledgeFrame(source: chrome.debugger.Debuggee, params: unknown): void {
  const sessionId = (params as { sessionId?: number } | undefined)?.sessionId;
  if (sessionId !== undefined)
    void chrome.debugger
      .sendCommand(source, "Page.screencastFrameAck", { sessionId })
      .catch(() => undefined);
}
onEngineInstall(() => {
  chrome.debugger.onEvent.addListener((source, method, params) => {
    if (method === "Page.screencastFrame") acknowledgeFrame(source, params);
    if (source.tabId !== undefined)
      publishBrowserEvent(
        source.tabId,
        method,
        (params ?? {}) as Record<string, unknown>,
        source.sessionId,
      );
  });
  chrome.tabs.onRemoved.addListener((tabId) => invalidateBrowserEvents(tabId, "Tab closed"));
  chrome.debugger.onDetach.addListener((source) => {
    if (source.tabId !== undefined)
      invalidateBrowserEvents(source.tabId, "Browser transport detached");
  });
});
export function invalidateBrowserEvents(tabId: number, reason: string): void {
  for (const entry of subscriptions.values())
    if (entry.target.tabId === tabId) {
      entry.error = reason;
      entry.wake?.();
    }
}
export function releaseBrowserEvents(chatId?: string): void {
  for (const [id, entry] of subscriptions)
    if (!chatId || entry.chatId === chatId) {
      entry.error = "Browser workflow released";
      entry.wake?.();
      subscriptions.delete(id);
    }
}
type EventRequest = BrowserExecutorRequest & {
  step: Extract<BrowserExecutorRequest["step"], { op: "event" }>;
};
export async function executeBrowserEvent(
  request: EventRequest,
  debuggee: chrome.debugger.Debuggee & { sessionId?: string },
): Promise<unknown> {
  const step = request.step;
  if (step.action === "subscribe") return subscribe(request, debuggee);
  const id = step.subscriptionId ?? "",
    entry = subscriptions.get(id);
  assertSubscription(entry, request);
  if (step.action === "dispose") {
    subscriptions.delete(id);
    entry.error = "Subscription disposed";
    entry.wake?.();
    if (shouldReleaseChooser(entry))
      await chrome.debugger
        .sendCommand(
          { ...debuggee, ...(entry.sessionId ? { sessionId: entry.sessionId } : {}) },
          "Page.setInterceptFileChooserDialog",
          { enabled: false },
        )
        .catch(() => undefined);
    return { disposed: true };
  }
  if (!entry.queue.length && !entry.error && step.timeoutMs)
    await waitForEvent(entry, step.timeoutMs);
  if (entry.error) throw new Error(entry.error);
  if (entry.expires < Date.now())
    throw new Error("Event subscription expired; register a new listener");
  entry.expires = Date.now() + 60000;
  return { events: drainEvents(entry), dropped: entry.dropped };
}
function shouldReleaseChooser(entry: Subscription): boolean {
  return (
    entry.event === "Page.fileChooserOpened" &&
    ![...subscriptions.values()].some(
      (other) =>
        other.event === entry.event &&
        other.target.tabId === entry.target.tabId &&
        other.sessionId === entry.sessionId,
    )
  );
}
function waitForEvent(entry: Subscription, timeout: number): Promise<void> {
  if (entry.wake) throw new Error("A subscription already has a waiting consumer");
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      entry.wake = undefined;
      resolve();
    };
    const timer = setTimeout(finish, timeout);
    entry.wake = finish;
  });
}

async function subscribe(
  request: EventRequest,
  debuggee: chrome.debugger.Debuggee & { sessionId?: string },
): Promise<unknown> {
  const step = request.step;
  for (const [id, entry] of subscriptions)
    if (entry.expires < Date.now()) {
      entry.error = "Subscription expired";
      entry.wake?.();
      subscriptions.delete(id);
    }

  if (
    !step.event ||
    !/^(Page|Network|Runtime|DOM|Tracing)\.[A-Za-z]+$|^(popup|download)$/.test(step.event)
  )
    throw new Error("UNSUPPORTED");
  if (step.event.startsWith("Runtime.") && debuggee.tabId !== undefined)
    await enableConsoleCapture(debuggee.tabId);
  if (subscriptions.size >= 128)
    throw new Error("Too many browser subscriptions; dispose unused listeners");
  const domain = step.event.split(".")[0];
  if (!["popup", "download", "Tracing"].includes(domain ?? ""))
    await chrome.debugger.sendCommand(debuggee, domain + ".enable");
  if (step.event === "Page.fileChooserOpened")
    await chrome.debugger.sendCommand(debuggee, "Page.setInterceptFileChooserDialog", {
      enabled: true,
    });
  const subscriptionId = crypto.randomUUID();
  subscriptions.set(subscriptionId, {
    chatId: request.chatId,
    target: step.target,
    event: step.event,
    ...(debuggee.sessionId ? { sessionId: debuggee.sessionId } : {}),
    expires: Date.now() + 60000,
    queue: [],
    dropped: 0,
  });
  return { subscriptionId, registered: true };
}

function assertSubscription(
  entry: Subscription | undefined,
  request: EventRequest,
): asserts entry is Subscription {
  if (
    !entry ||
    entry.chatId !== request.chatId ||
    JSON.stringify(entry.target) !== JSON.stringify(request.step.target)
  )
    throw new Error("INVALID_TARGET");
}
function drainEvents(entry: Subscription): EventItem[] {
  const result: EventItem[] = [];
  let size = 0;
  const cap = entry.event === "Page.screencastFrame" ? 700_000 : 100000;
  while (entry.queue.length && size < cap) {
    const item = entry.queue.shift();
    if (!item) break;
    size += JSON.stringify(item).length;
    result.push(item);
  }
  return result;
}

interface Diagnostics {
  console: { level: string; text: string }[];
  network: { url: string; status?: number; error?: string }[];
}
const buffers = new Map<number, Diagnostics>();
const requests = new Map<string, { url: string; status?: number; error?: string }>();
const enabled = new Set<number>();
export async function enableDiagnostics(tabId: number): Promise<void> {
  if (enabled.has(tabId)) return;
  enabled.add(tabId);
  buffers.set(tabId, { console: [], network: [] });
  await chrome.debugger.sendCommand({ tabId }, "Network.enable").catch(() => undefined);
}

// Runtime.enable is the signal anti-automation scripts look for (console serialization side
// effects), so console capture starts only once the agent asks for diagnostics or Runtime events.
const runtimeEnabled = new Set<number>();
export async function enableConsoleCapture(tabId: number): Promise<void> {
  if (runtimeEnabled.has(tabId)) return;
  runtimeEnabled.add(tabId);
  await chrome.debugger.sendCommand({ tabId }, "Runtime.enable").catch(() => undefined);
}
export function readDiagnostics(tabId: number, clear = false): Diagnostics {
  const buffer = buffers.get(tabId) ?? { console: [], network: [] };
  const result = structuredClone(buffer);
  if (clear) {
    buffer.console.length = 0;
    buffer.network.length = 0;
  }
  return result;
}
export function forgetDiagnostics(tabId: number): void {
  buffers.delete(tabId);
  runtimeEnabled.delete(tabId);
  enabled.delete(tabId);
  for (const key of requests.keys()) if (key.startsWith(tabId + ":")) requests.delete(key);
}
onEngineInstall(() => {
  chrome.debugger.onEvent.addListener((source, method, raw) => {
    if (source.tabId === undefined) return;
    const buffer = buffers.get(source.tabId);
    if (!buffer) return;
    const params = (raw ?? {}) as Record<string, unknown>;
    if (method === "Page.javascriptDialogOpening") {
      buffer.console.push({
        level: "info",
        text: `[dialog ${String(params.type)}] ${String(params.message).slice(0, 300)} (accepted)`,
      });
      if (buffer.console.length > 80) buffer.console.shift();
      return;
    }
    if (method === "Runtime.consoleAPICalled" || method === "Runtime.exceptionThrown")
      captureConsole(buffer, method, params);
    else captureNetwork(source.tabId, buffer, method, params);
  });
});
function captureConsole(
  buffer: Diagnostics,
  method: string,
  params: Record<string, unknown>,
): void {
  if (method === "Runtime.exceptionThrown") {
    const details = params.exceptionDetails as
      { text?: string; exception?: { description?: string } } | undefined;
    buffer.console.push({
      level: "error",
      text: String(details?.exception?.description ?? details?.text).slice(0, 1000),
    });
  } else {
    const args = params.args as { value?: unknown; description?: string }[] | undefined;
    buffer.console.push({
      level: String(params.type),
      text: (args ?? [])
        .map((arg) => String(arg.value ?? arg.description ?? ""))
        .join(" ")
        .slice(0, 1000),
    });
  }
  if (buffer.console.length > 80) buffer.console.shift();
}
function captureNetwork(
  tabId: number,
  buffer: Diagnostics,
  method: string,
  params: Record<string, unknown>,
): void {
  const key = tabId + ":" + String(params.requestId);
  if (method === "Network.requestWillBeSent") {
    const request = params.request as { url?: string } | undefined;
    const entry = { url: String(request?.url ?? "").slice(0, 2048) };
    requests.set(key, entry);
    buffer.network.push(entry);
    if (requests.size > 800) requests.delete(requests.keys().next().value ?? "");
    if (buffer.network.length > 80) buffer.network.shift();
  } else {
    const entry = requests.get(key);
    if (!entry) return;
    if (method === "Network.responseReceived") {
      const status = (params.response as { status?: number }).status;
      if (typeof status === "number") entry.status = status;
    }
    if (method === "Network.loadingFailed") entry.error = String(params.errorText).slice(0, 300);
    if (["Network.loadingFinished", "Network.loadingFailed"].includes(method)) requests.delete(key);
  }
}
