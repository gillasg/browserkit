import { onEngineInstall } from "./native-engine-install.js";
import { subscribeViewer, startFlight } from "./native-browser-flight.js";
import { beginDispatch, endDispatch } from "./native-browser-control.js";
import { withBrowserDebugger } from "./native-browser-session.js";

// The bridge's /view page subscribes to the screencast that flight/recordTab already own. Input
// from the viewer is marked as agent input so it never reads as the user taking over the tab.
let socket: WebSocket | undefined;

export function installBrowserView(connection: WebSocket): void {
  socket = connection;
}

onEngineInstall(() => {
  chrome.runtime.onMessage.addListener((message) => {
    if (message?.kind === "browser.view.input") void input(message);
  });
});

export function handleBrowserViewMessage(message: Record<string, unknown>): boolean {
  if (message.kind === "browser.view.subscribe") {
    const tabId = Number(message.tabId);
    const chatId = String(message.chatId ?? "viewer");
    if (!Number.isSafeInteger(tabId)) return true;
    void startFlight(tabId, chatId);
    const unsubscribe = subscribeViewer(tabId, (data, at) => {
      if (socket?.readyState !== WebSocket.OPEN) return;
      socket.send(JSON.stringify({ kind: "browser.view.frame", tabId, data, at }));
    });
    // The bridge owns the subscription lifetime; a later subscribe replaces the old one.
    viewUnsubscribers.get(tabId)?.();
    viewUnsubscribers.set(tabId, unsubscribe);
    return true;
  }
  if (message.kind === "browser.view.unsubscribe") {
    const tabId = Number(message.tabId);
    viewUnsubscribers.get(tabId)?.();
    viewUnsubscribers.delete(tabId);
    return true;
  }
  if (message.kind === "browser.view.input") {
    void input(message);
    return true;
  }
  return false;
}

const viewUnsubscribers = new Map<number, () => void>();

async function input(message: Record<string, unknown>): Promise<void> {
  const tabId = Number(message.tabId);
  if (!Number.isSafeInteger(tabId)) return;
  const at = Date.now();
  await withBrowserDebugger(tabId, async (debuggee) => {
    beginDispatch(tabId);
    try {
      if (message.action === "click") {
        for (const type of ["mousePressed", "mouseReleased"] as const)
          await chrome.debugger.sendCommand(debuggee, "Input.dispatchMouseEvent", {
            type,
            x: Number(message.x ?? 0),
            y: Number(message.y ?? 0),
            button: "left",
            clickCount: 1,
          });
      } else if (message.action === "key") {
        const key = String(message.key ?? "");
        await chrome.debugger.sendCommand(debuggee, "Input.dispatchKeyEvent", {
          type: "keyDown",
          key,
          text: key.length === 1 ? key : undefined,
        });
        await chrome.debugger.sendCommand(debuggee, "Input.dispatchKeyEvent", {
          type: "keyUp",
          key,
        });
      }
      void at;
    } catch {
      // Viewer input is best effort; a refused dispatch must not detach the shared debugger.
    } finally {
      endDispatch(tabId);
    }
  }).catch(() => undefined);
}
