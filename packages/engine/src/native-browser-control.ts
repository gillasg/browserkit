import { onEngineInstall } from "./native-engine-install.js";
import { onBrowserDebuggerAttached, browserSessionOwner } from "./native-browser-session.js";
import { dimAgentGlow, showAgentCaption, showAgentGlow } from "./native-browser-cursor.js";

// Who is driving a tab. CDP's Input events are trusted, just like a real click, so the engine
// records the moments it is dispatching input; a trusted event outside those moments came from
// the user. A page-side watcher in an isolated world reports events (its globals stay invisible
// to the page). A click or key from the user only pauses the agent quietly: its next step waits
// until the user has been still for a moment, then carries on in its flow. Esc is the deliberate
// take-over: the agent stops with USER_TOOK_CONTROL and waits to be given the tab back.

interface Control {
  at: number;
  reported: boolean;
}
const controlled = new Map<number, Control>();
const dispatchDepth = new Map<number, number>();
const windows = new Map<number, { start: number; end?: number }[]>();
const handoffs = new Set<number>();

export function beginDispatch(tabId: number): void {
  dispatchDepth.set(tabId, (dispatchDepth.get(tabId) ?? 0) + 1);
  const list = windows.get(tabId) ?? [];
  list.push({ start: Date.now() });
  windows.set(tabId, list.slice(-20));
}

export function endDispatch(tabId: number): void {
  const depth = (dispatchDepth.get(tabId) ?? 1) - 1;
  if (depth > 0) {
    dispatchDepth.set(tabId, depth);
    return;
  }
  dispatchDepth.delete(tabId);
  const last = windows.get(tabId)?.at(-1);
  if (last && last.end === undefined) last.end = Date.now();
}

let wrappedDispatch = false;
/** A fallback window around a whole step, used only when the dispatch API cannot be wrapped. */
export function stepInput(tabId: number, active: boolean): void {
  if (wrappedDispatch) return;
  if (active) beginDispatch(tabId);
  else endDispatch(tabId);
}

function agentInput(tabId: number, at: number): boolean {
  return (windows.get(tabId) ?? []).some(
    (window) => at >= window.start - 60 && at <= (window.end ?? Date.now()) + 250,
  );
}

export function handoffActive(tabId: number, active?: boolean): boolean {
  if (active === undefined) return handoffs.has(tabId);
  if (active) handoffs.add(tabId);
  else handoffs.delete(tabId);
  return active;
}

export function controlOf(tabId: number): "agent" | "user" {
  return controlled.has(tabId) ? "user" : "agent";
}

/** The error a refused step throws: the first one names the take-over, later ones the state. */
export function controlError(tabId: number): string {
  const entry = controlled.get(tabId);
  if (!entry) return "USER_HAS_CONTROL";
  if (!entry.reported) {
    entry.reported = true;
    return "USER_TOOK_CONTROL";
  }
  return "USER_HAS_CONTROL";
}

const QUIET_MS = 3000;
const MAX_PAUSE_MS = 60_000;
const lastUserInput = new Map<number, number>();

/** The user clicked or typed in an agent's tab: steps wait until they have been still a moment. */
export function noteUserInput(tabId: number, at: number, takeOver = false): void {
  if (!browserSessionOwner(tabId) || handoffActive(tabId) || agentInput(tabId, at)) return;
  if (!takeOver) {
    lastUserInput.set(tabId, at);
    return;
  }
  if (controlled.has(tabId)) return;
  controlled.set(tabId, { at, reported: false });
  void injectTop(tabId, controlBanner);
  dimAgentGlow(tabId, true);
  notify(tabId, "user");
}

export function giveBack(tabId: number): boolean {
  if (!controlled.delete(tabId)) return false;
  void injectTop(tabId, removeBanner);
  dimAgentGlow(tabId, false);
  notify(tabId, "agent");
  return true;
}

export async function waitForGiveBack(tabId: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + Math.max(100, Math.min(timeoutMs, 120_000));
  while (Date.now() < deadline) {
    if (!controlled.has(tabId)) return true;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  return !controlled.has(tabId);
}

/**
 * Before a step: while the user is acting in the tab, wait until they have been still for
 * QUIET_MS (at most a minute), then go on. Returns whether the user acted since the agent's
 * previous step, so the step can tell the agent to look at the page again.
 */
export async function waitForQuietUser(tabId: number): Promise<boolean> {
  const first = lastUserInput.get(tabId);
  if (first === undefined) return false;
  const deadline = Date.now() + MAX_PAUSE_MS;
  let captioned = false;
  for (;;) {
    const last = lastUserInput.get(tabId) ?? 0;
    const quietFor = Date.now() - last;
    if (quietFor >= QUIET_MS || Date.now() > deadline || controlled.has(tabId)) break;
    if (!captioned) {
      showAgentCaption({ tabId }, "Waiting for you to finish");
      captioned = true;
    }
    await new Promise((resolve) => setTimeout(resolve, Math.min(300, QUIET_MS - quietFor)));
  }
  lastUserInput.delete(tabId);
  return true;
}

export function forgetControl(tabId: number): void {
  lastUserInput.delete(tabId);
  controlled.delete(tabId);
  windows.delete(tabId);
  dispatchDepth.delete(tabId);
  handoffs.delete(tabId);
}

function notify(tabId: number, control: "agent" | "user"): void {
  // Hosts (Aeon) can show a line about it; the chatId routes it to that chat only.
  const chatId = browserSessionOwner(tabId);
  void chrome.runtime
    .sendMessage({ kind: "browserkit.control", tabId, control, ...(chatId ? { chatId } : {}) })
    .catch(() => undefined);
}

async function injectTop(tabId: number, func: () => void): Promise<void> {
  await chrome.scripting
    .executeScript({ target: { tabId }, world: "ISOLATED", func })
    .catch(() => undefined);
}

async function injectWatcher(tabId: number): Promise<void> {
  await chrome.scripting
    .executeScript({
      target: { tabId, allFrames: true },
      world: "ISOLATED",
      func: watchUserInput,
    })
    .catch(() => undefined);
}

// The watcher: reports trusted pointer, key and wheel events; its marker lives in the isolated
// world, so the page never sees a global.
function watchUserInput(): void {
  const state = globalThis as unknown as { __browserkitUserWatch?: boolean };
  if (state.__browserkitUserWatch) return;
  state.__browserkitUserWatch = true;
  const modifiers = new Set(["Shift", "Control", "Alt", "Meta", "CapsLock", "OS"]);
  const report = (event: Event): void => {
    if (!event.isTrusted) return;
    if (
      event
        .composedPath()
        .some(
          (node) =>
            node &&
            typeof (node as unknown as { hasAttribute?: unknown }).hasAttribute === "function" &&
            (node as unknown as { hasAttribute(name: string): boolean }).hasAttribute(
              "data-browserkit-overlay",
            ),
        )
    )
      return;
    if (event instanceof KeyboardEvent && (modifiers.has(event.key) || !document.hasFocus()))
      return;
    // Esc (with nothing of the page's own open to close) is the deliberate take-over.
    const takeOver = event instanceof KeyboardEvent && event.key === "Escape";
    void chrome.runtime
      .sendMessage({ kind: "browserkit.user-input", at: Date.now(), takeOver })
      .catch(() => undefined);
  };
  // Wheel is deliberately absent: scrolling to watch the agent is not taking the tab over.
  for (const type of ["pointerdown", "keydown"]) {
    window.addEventListener(type, report, { capture: true, passive: true });
  }
}

function controlBanner(): void {
  if (document.getElementById("browserkit-control")) return;
  const host = document.createElement("div");
  host.id = "browserkit-control";
  host.setAttribute("data-browserkit-overlay", "");
  host.style.cssText =
    "position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:2147483647;";
  const root = host.attachShadow({ mode: "closed" });
  root.innerHTML =
    "<style>div{display:flex;align-items:center;gap:12px;padding:10px 14px;border-radius:14px;background:#17181c;color:#f3f4f6;font:14px/1.4 system-ui,sans-serif;box-shadow:0 8px 30px rgba(0,0,0,.35),0 0 0 1px rgba(255,255,255,.08)}b{display:block;font-size:12px;color:#a5b4fc}button{border:0;border-radius:9px;padding:7px 12px;font:600 13px system-ui,sans-serif;cursor:pointer;background:#4f46e5;color:#fff}</style>" +
    "<div><b>You have control</b><span>The agent is paused.</span><button>Give back to agent</button></div>";
  root.querySelector("button")?.addEventListener("click", () => {
    void chrome.runtime.sendMessage({ kind: "browserkit.control.giveback" }).catch(() => undefined);
    host.remove();
  });
  (document.body ?? document.documentElement).append(host);
}

function removeBanner(): void {
  document.getElementById("browserkit-control")?.remove();
}

onEngineInstall(() => {
  chrome.runtime.onMessage.addListener((message, sender) => {
    if (!message || typeof message !== "object") return;
    // The extension's own pages (a chat) name the tab they give back; pages give back themselves.
    const own = sender.url?.startsWith(chrome.runtime.getURL("")) === true;
    const tabId = own && typeof message.tabId === "number" ? message.tabId : sender.tab?.id;
    if (tabId === undefined) return;
    if (message.kind === "browserkit.user-input")
      noteUserInput(tabId, Number(message.at) || Date.now(), message.takeOver === true);
    if (message.kind === "browserkit.control.giveback") giveBack(tabId);
  });
  onBrowserDebuggerAttached((tabId) => {
    void injectWatcher(tabId);
    void showAgentGlow(tabId, controlOf(tabId) === "user");
  });
  chrome.webNavigation?.onCommitted?.addListener((details) => {
    if (details.tabId < 0 || details.frameId !== 0 || !browserSessionOwner(details.tabId)) return;
    void injectWatcher(details.tabId);
    void showAgentGlow(details.tabId, controlOf(details.tabId) === "user");
  });
  chrome.tabs.onRemoved.addListener((tabId) => forgetControl(tabId));
  // Every Input.dispatch* opens a window in which a trusted event belongs to the agent. The
  // wrapper sees all dispatch sources, including page.mouse and hand-off typing.
  try {
    const debuggerApi = chrome.debugger;
    const original = debuggerApi.sendCommand.bind(debuggerApi);
    debuggerApi.sendCommand = ((
      debuggee: chrome.debugger.Debuggee,
      method: string,
      params?: { [key: string]: unknown },
      callback?: () => void,
    ) => {
      if (!method.startsWith("Input.dispatch")) return original(debuggee, method, params, callback);
      const tabId = debuggee.tabId;
      if (tabId !== undefined) beginDispatch(tabId);
      const done = (): void => {
        if (tabId !== undefined) endDispatch(tabId);
      };
      const result = (
        original as unknown as (
          debuggee: chrome.debugger.Debuggee,
          method: string,
          params?: { [key: string]: unknown },
          callback?: () => void,
        ) => unknown
      )(debuggee, method, params, callback);
      if (result && typeof (result as Promise<unknown>).then === "function")
        return (result as Promise<unknown>).finally(done);
      done();
      return result;
    }) as typeof debuggerApi.sendCommand;
    wrappedDispatch = true;
  } catch {
    // A frozen API object cannot be wrapped; quiet input is then reported as the user's.
  }
});
