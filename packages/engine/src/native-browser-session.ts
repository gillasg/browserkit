import { removeAgentCursor, showAgentGlow } from "./native-browser-cursor.js";
import {
  enableDiagnostics,
  forgetDiagnostics,
  releaseBrowserEvents,
} from "./native-browser-events.js";
import { trackBrowserActivity, forgetBrowserActivity } from "./native-browser-navigation.js";
import { engineConfig } from "./engine-config.js";
import { currentInventoryTabs } from "./native-inventory-client.js";
import { tidyAllChatTabs, tidyChatTabs, touchAgentTab } from "./native-browser-tab-cleanup.js";
import type { BrowserExecutorRequest } from "@browserkit/protocol";
import { onEngineInstall } from "./native-engine-install.js";

interface Attachment {
  chatId: string;
  attached: Promise<void>;
  timer?: number;
}
const attachments = new Map<number, Attachment>();
const owners = new Map<number, string>();
const cancelled = new Map<number, string | undefined>();
const closing = new Map<number, Promise<void>>();
/** Tabs that must stay attached while idle, e.g. while their network traffic is being recorded. */
const held = new Set<number>();
const attachListeners = new Set<(tabId: number) => Promise<void> | void>();

/** Keeps (or stops keeping) a tab's debugger attached through idle periods. */
export function holdBrowserDebugger(tabId: number, hold: boolean): void {
  if (hold) held.add(tabId);
  else held.delete(tabId);
}

/** Runs after every debugger attach, so features can re-enable the CDP domains they need. */
export function onBrowserDebuggerAttached(listener: (tabId: number) => Promise<void> | void): void {
  attachListeners.add(listener);
}

function idleDetach(tabId: number): void {
  const entry = attachments.get(tabId);
  if (held.has(tabId) && entry) {
    entry.timer = globalThis.setTimeout(() => idleDetach(tabId), 90_000);
    return;
  }
  void detach(tabId);
}

onEngineInstall(() => {
  chrome.debugger.onDetach.addListener((source, reason) => {
    if (source.tabId === undefined) return;
    forget(source.tabId);
    if (reason === "canceled_by_user") cancelled.set(source.tabId, owners.get(source.tabId));
  });
  chrome.tabs.onRemoved.addListener((tabId) => {
    held.delete(tabId);
    emulated.delete(tabId);
    forget(tabId);
    owners.delete(tabId);
    cancelled.delete(tabId);
  });
});

/** Tabs held by a chat's session, or by any session. */
export function browserSessionTabs(chatId?: string): number[] {
  return [...owners].filter(([, owner]) => !chatId || owner === chatId).map(([tabId]) => tabId);
}
export function browserSessionOwner(tabId: number): string | undefined {
  return owners.get(tabId);
}

export function bindBrowserSession(tabId: number, chatId: string): void {
  owners.set(tabId, chatId);
  persistBrowserOwners(owners);
}

/** Attaches for a caller that sends its own debugger commands (CDP clients); errors stay its own. */
export async function ensureBrowserAttachment(tabId: number, chatId: string): Promise<void> {
  bindBrowserSession(tabId, chatId);
  let entry = attachments.get(tabId);
  if (!entry) {
    entry = { chatId, attached: attach(tabId) };
    attachments.set(tabId, entry);
  }
  await entry.attached;
  touchAgentTab(tabId);
}

const NOT_READY =
  /different extension|Cannot access a chrome-extension|Cannot access a chrome: ?URL/i;

// A tab that is still on a new-tab or extension page cannot be debugged yet; wait briefly and retry.
export async function withBrowserDebugger<T>(
  tabId: number,
  action: (debuggee: chrome.debugger.Debuggee) => Promise<T>,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await runWithBrowserDebugger(tabId, action);
    } catch (error) {
      if (attempt >= 4 || !NOT_READY.test(String(error instanceof Error ? error.message : error)))
        throw error;
      await new Promise((resolve) => setTimeout(resolve, 300 * (attempt + 1)));
    }
  }
}

async function runWithBrowserDebugger<T>(
  tabId: number,
  action: (debuggee: chrome.debugger.Debuggee) => Promise<T>,
): Promise<T> {
  await closing.get(tabId);
  if (cancelled.has(tabId)) throw new Error("OPERATION_FAILED");
  const chatId = owners.get(tabId);
  if (!chatId) throw new Error("CLAIM_CONFLICT");
  let entry = attachments.get(tabId);
  if (!entry) {
    entry = { chatId, attached: attach(tabId) };
    attachments.set(tabId, entry);
  }
  try {
    await entry.attached;
    touchAgentTab(tabId);
    await ensureBrowserViewport(tabId);
    if (attachments.get(tabId) !== entry) throw new Error("OPERATION_FAILED");
    if (entry.timer !== undefined) clearTimeout(entry.timer);
    entry.timer = globalThis.setTimeout(() => idleDetach(tabId), 90_000);
    void chrome.action.setBadgeText({ tabId, text: "AI" });
    void chrome.action.setBadgeBackgroundColor({ tabId, color: "#4299ff" });
    void chrome.action.setTitle({ tabId, title: engineConfig.controllingTitle(chatId) });
    return await action({ tabId });
  } catch (error) {
    if (
      attachments.get(tabId) !== entry ||
      !(error instanceof Error) ||
      ![
        "STALE_REF",
        "AMBIGUOUS_TARGET",
        "TARGET_NOT_FOUND",
        "TARGET_HIDDEN",
        "TARGET_DISABLED",
        "TARGET_BLOCKED",
        "NOT_EDITABLE",
        "INPUT_FAILED",
        "INVALID_TARGET",
        "TIMEOUT",
      ].includes(error.message)
    )
      await detach(tabId);
    throw error;
  }
}

export async function releaseBrowserSessions(chatId?: string, reset = false): Promise<void> {
  releaseBrowserEvents(chatId);
  if (reset || !chatId)
    for (const [tabId, owner] of cancelled)
      if (!chatId || owner === chatId) cancelled.delete(tabId);
  const tabs = [...owners].filter(([, owner]) => !chatId || owner === chatId);
  for (const [tabId] of tabs) {
    void removeAgentCursor(tabId);
    owners.delete(tabId);
    if (reset || !chatId) cancelled.delete(tabId);
    await detach(tabId);
  }
  persistBrowserOwners(owners);
}

function forget(tabId: number): void {
  const entry = attachments.get(tabId);
  if (entry?.timer !== undefined) clearTimeout(entry.timer);
  attachments.delete(tabId);
  forgetDiagnostics(tabId);
  forgetBrowserActivity(tabId);
  void chrome.action.setBadgeText({ tabId, text: "" }).catch(() => undefined);
  void chrome.action.setTitle({ tabId, title: engineConfig.idleTitle }).catch(() => undefined);
}

async function attach(tabId: number): Promise<void> {
  try {
    await chrome.debugger.attach({ tabId }, "1.3");
  } catch (error) {
    if (!/already attached/i.test(String(error))) throw error;
    // sendCommand succeeds only for our extension's attachment; do not take over DevTools.
    await chrome.debugger.sendCommand({ tabId }, "Page.getFrameTree");
  }
  trackBrowserActivity(tabId);
  await chrome.debugger.sendCommand({ tabId }, "Page.enable");
  void showAgentGlow(tabId);
  await Promise.all([
    chrome.debugger.sendCommand({ tabId }, "DOM.enable"),
    chrome.debugger.sendCommand({ tabId }, "Accessibility.enable"),
  ]);
  await chrome.debugger
    .sendCommand({ tabId }, "Emulation.setFocusEmulationEnabled", { enabled: true })
    .catch(() => undefined);
  await enableDiagnostics(tabId);
  for (const listener of attachListeners)
    await Promise.resolve(listener(tabId)).catch(() => undefined);
}

function detach(tabId: number): Promise<void> {
  const prior = closing.get(tabId);
  if (prior) return prior;
  const entry = attachments.get(tabId);
  forget(tabId);
  if (!entry) return Promise.resolve();
  const work = entry.attached
    .then(
      async () => {
        await restoreBrowserViewport(tabId);
        void removeAgentCursor(tabId);
        await chrome.debugger
          .sendCommand({ tabId }, "Emulation.setFocusEmulationEnabled", { enabled: false })
          .catch(() => undefined);
        await chrome.debugger.detach({ tabId }).catch(() => undefined);
      },
      () => undefined,
    )
    .finally(() => {
      if (closing.get(tabId) === work) closing.delete(tabId);
    });
  closing.set(tabId, work);
  return work;
}
export async function reconnectBrowserSession(tabId: number): Promise<void> {
  await detach(tabId);
}
export async function restoreBrowserSessionOwners(): Promise<void> {
  await restoreBrowserOwners(owners);
}

const key = "aeon-browser-owners";
let writes: Promise<unknown> = Promise.resolve();
export function persistBrowserOwners(owners: Map<number, string>): void {
  if (!chrome.storage?.session) return;
  const tabs = currentInventoryTabs();
  const records = [...owners].flatMap(([tabId, chatId]) => {
    const tab = tabs.find((item) => item.target.tabId === tabId);
    return tab ? [{ chatId, target: tab.target }] : [];
  });
  writes = writes
    .catch(() => undefined)
    .then(() => chrome.storage.session.set({ [key]: records }))
    .catch(() => undefined);
}
export async function restoreBrowserOwners(owners: Map<number, string>): Promise<void> {
  if (!chrome.storage?.session) return;
  const stored = (await chrome.storage.session.get(key))[key] as
    { chatId: string; target: unknown }[] | undefined;
  const tabs = currentInventoryTabs();
  for (const record of stored ?? []) {
    const tab = tabs.find((item) => JSON.stringify(item.target) === JSON.stringify(record.target));
    if (tab && !owners.has(tab.target.tabId)) {
      owners.set(tab.target.tabId, record.chatId);
    }
  }
}

const overridden = new Set<number>();
/** Device sizes the agent chose (page.emulate); they win over the background-tab viewport. */
const emulated = new Map<number, unknown>();

export function noteDeviceEmulation(tabId: number, method: string, params: unknown): void {
  if (method === "Emulation.setDeviceMetricsOverride") emulated.set(tabId, params);
  else if (method === "Emulation.clearDeviceMetricsOverride") emulated.delete(tabId);
}
onEngineInstall(() => {
  chrome.tabs.onActivated?.addListener(({ tabId }) => void restoreBrowserViewport(tabId));
});
export async function ensureBrowserViewport(tabId: number): Promise<void> {
  if (emulated.has(tabId)) return;
  if (overridden.has(tabId)) return;
  const tab = await chrome.tabs.get?.(tabId).catch(() => undefined);
  if (!tab) return;
  if (tab.active || ((tab as chrome.tabs.Tab & { splitViewId?: number }).splitViewId ?? -1) >= 0) {
    await restoreBrowserViewport(tabId);
    return;
  }
  await chrome.debugger.sendCommand({ tabId }, "Emulation.setDeviceMetricsOverride", {
    width: 1280,
    height: 800,
    deviceScaleFactor: 1,
    mobile: false,
  });
  overridden.add(tabId);
}
export async function restoreBrowserViewport(tabId: number): Promise<void> {
  if (emulated.has(tabId)) return;
  overridden.delete(tabId);
  await chrome.debugger
    .sendCommand({ tabId }, "Emulation.clearDeviceMetricsOverride")
    .catch(() => undefined);
}

const chatEpochs = new Map<string, number>();
const requestEpochs = new Map<string, number>();

export function releaseBrowserExecutor(): void {
  for (const [chatId, epoch] of chatEpochs) chatEpochs.set(chatId, epoch + 1);
  void releaseBrowserSessions();
}
export function handleBrowserRelease(candidate: unknown): boolean {
  if (
    typeof candidate === "object" &&
    candidate !== null &&
    "kind" in candidate &&
    candidate.kind === "browser.tidy"
  ) {
    void tidyAllChatTabs();
    return true;
  }
  if (
    typeof candidate !== "object" ||
    candidate === null ||
    !("kind" in candidate) ||
    candidate.kind !== "browser.release" ||
    !("chatId" in candidate) ||
    typeof candidate.chatId !== "string"
  )
    return false;
  chatEpochs.set(candidate.chatId, (chatEpochs.get(candidate.chatId) ?? 0) + 1);
  void releaseBrowserSessions(candidate.chatId, "reset" in candidate && candidate.reset === true);
  // The end of a run: close the tabs it no longer needs.
  if ("tidy" in candidate && candidate.tidy === true) void tidyChatTabs(candidate.chatId);
  return true;
}
export function registerBrowserRequest(request: BrowserExecutorRequest): void {
  const epoch = chatEpochs.get(request.chatId) ?? 0;
  chatEpochs.set(request.chatId, epoch);
  requestEpochs.set(request.requestId, epoch);
}
export function assertRequestActive(request: BrowserExecutorRequest): void {
  if (requestEpochs.get(request.requestId) !== chatEpochs.get(request.chatId))
    throw new Error("OPERATION_FAILED");
}
export function completeBrowserRequest(request: BrowserExecutorRequest): void {
  requestEpochs.delete(request.requestId);
}
