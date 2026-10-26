import type { BrowserIdentity } from "./native-worker-identity.js";
import { onEngineInstall } from "./native-engine-install.js";
import {
  bindBrowserSession,
  ensureBrowserAttachment,
  holdBrowserDebugger,
} from "./native-browser-session.js";
import { refreshInventoryTab } from "./native-inventory-client.js";
import { claimAgentTab, groupAgentTab } from "./native-browser-groups.js";
import { markAgentTabGrouped, trackAgentTab } from "./native-browser-tab-cleanup.js";
import { noteLabel, noteSpace, spaceWindow } from "./native-browser-spaces.js";

// A local CDP client (Playwright, Puppeteer) drives agent tabs through the debugger sessions the
// engine already owns. The bridge speaks CDP; this module forwards one command at a time to
// chrome.debugger and streams debugger events back. Only tabs a CDP client opened are enabled.

const enabled = new Map<number, string>();
let socket: WebSocket | undefined;
let identity: BrowserIdentity | undefined;

/** The executor socket is the same one browser.code cells use; remember it for CDP forwarding. */
export function noteCdpSocket(next: WebSocket, nextIdentity: BrowserIdentity): void {
  socket = next;
  identity = nextIdentity;
}

export function handleCdpMessage(candidate: unknown): boolean {
  if (!candidate || typeof candidate !== "object" || !("kind" in candidate)) return false;
  const message = candidate as Record<string, unknown>;
  if (message.kind === "cdp.bind") {
    const tabId = Number(message.tabId);
    const chatId = String(message.chatId ?? "");
    if (!Number.isSafeInteger(tabId) || !chatId) return true;
    bindBrowserSession(tabId, chatId);
    holdBrowserDebugger(tabId, true);
    enabled.set(tabId, chatId);
    void ensureBrowserAttachment(tabId, chatId).catch(() => undefined);
    return true;
  }
  if (message.kind === "cdp.newTab") {
    void newTab(String(message.id ?? ""), String(message.chatId ?? ""), String(message.url ?? ""));
    return true;
  }
  if (message.kind === "cdp.closeTab") {
    void closeTab(String(message.id ?? ""), Number(message.tabId), String(message.chatId ?? ""));
    return true;
  }
  if (message.kind === "cdp.release") {
    const tabId = Number(message.tabId);
    enabled.delete(tabId);
    holdBrowserDebugger(tabId, false);
    return true;
  }
  if (message.kind !== "cdp.command") return false;
  const id = String(message.id ?? "");
  const tabId = Number(message.tabId);
  const method = String(message.method ?? "");
  const params = (message.params ?? {}) as Record<string, unknown>;
  const sessionId = message.sessionId === undefined ? undefined : String(message.sessionId);
  void runCommand(id, tabId, method, params, sessionId);
  return true;
}

async function runCommand(
  id: string,
  tabId: number,
  method: string,
  params: Record<string, unknown>,
  sessionId?: string,
): Promise<void> {
  try {
    const chatId = enabled.get(tabId) ?? identity?.clientInstanceId;
    if (!Number.isSafeInteger(tabId) || !chatId || !method) throw new Error("INVALID_CDP_COMMAND");
    bindBrowserSession(tabId, chatId);
    await ensureBrowserAttachment(tabId, chatId);
    const result = await chrome.debugger.sendCommand(
      sessionId ? { tabId, sessionId } : { tabId },
      method,
      params,
    );
    send({ kind: "cdp.result", id, result });
  } catch (error) {
    send({
      kind: "cdp.result",
      id,
      error: String(error instanceof Error ? error.message : error).slice(0, 4000),
    });
  }
}

async function newTab(id: string, chatId: string, url: string): Promise<void> {
  try {
    if (!chatId) throw new Error("INVALID_CDP_COMMAND");
    const { windowId } = await spaceWindow(chatId);
    const target =
      !url || /^about:blank$/i.test(url)
        ? "data:text/html,%3C!doctype html%3E%3Ctitle%3E%3C/title%3E"
        : url;
    const tab = await chrome.tabs.create({ windowId, url: target, active: true });
    // Let the initial document commit before a CDP client attaches; a blank frame tree makes
    // Playwright wait for a first navigation.
    await new Promise((done) => setTimeout(done, 300));
    if (tab.id === undefined) throw new Error("TARGET_LOST");
    trackAgentTab(tab.id, chatId, { url: target });
    bindBrowserSession(tab.id, chatId);
    markAgentTabGrouped(tab.id);
    claimAgentTab(tab.id);
    await groupAgentTab(tab.id, tab.windowId, chatId, "CDP");
    noteSpace(chatId, "window", windowId);
    const known = await refreshInventoryTab(tab.id);
    if (!known) throw new Error("TARGET_LOST");
    noteLabel(chatId, tab.id, known.url);
    enableTab(tab.id, chatId);
    send({ kind: "cdp.tab", id, tab: known });
  } catch (error) {
    send({ kind: "cdp.tab", id, error: String(error instanceof Error ? error.message : error) });
  }
}

async function closeTab(id: string, tabId: number, chatId: string): Promise<void> {
  try {
    const owner = enabled.get(tabId);
    if (owner !== chatId) throw new Error("TAB_NOT_YOURS: that tab belongs to another session");
    enabled.delete(tabId);
    holdBrowserDebugger(tabId, false);
    await chrome.tabs.remove(tabId).catch(() => undefined);
    send({ kind: "cdp.tab", id, closed: true });
  } catch (error) {
    send({ kind: "cdp.tab", id, error: String(error instanceof Error ? error.message : error) });
  }
}

function enableTab(tabId: number, chatId: string): void {
  holdBrowserDebugger(tabId, true);
  enabled.set(tabId, chatId);
  void ensureBrowserAttachment(tabId, chatId).catch(() => undefined);
}

function send(message: Record<string, unknown>): void {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}

onEngineInstall(() => {
  chrome.debugger.onEvent.addListener((source, method, params) => {
    if (source.tabId === undefined || !enabled.has(source.tabId) || !socket) return;
    send({
      kind: "cdp.event",
      tabId: source.tabId,
      method,
      params,
      ...(source.sessionId ? { sessionId: source.sessionId } : {}),
    });
  });
  chrome.debugger.onDetach.addListener((source, reason) => {
    if (source.tabId === undefined || !enabled.has(source.tabId)) return;
    send({ kind: "cdp.detached", tabId: source.tabId, reason });
  });
  chrome.tabs.onRemoved.addListener((tabId) => {
    enabled.delete(tabId);
  });
});
