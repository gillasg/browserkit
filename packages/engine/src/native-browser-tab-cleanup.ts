// Close tabs an agent opened once they are no longer needed. Only tabs the agent created are
// tracked; user tabs and tabs the user pins are never closed. When a run ends, its chat keeps
// only the tab it used last and tabs the user switched to; during a run a chat keeps at most
// MAX_CHAT_TABS; any left over close after DEFAULT_IDLE_MINUTES untouched. A tab is touched when
// an agent sends it a command or the user switches to it. Tabs held for a hand-off or recording,
// playing audio, or in front of the user stay open; page.keep() hands a tab to the user for good.
import { collapseAgentGroups, agentGroupsReady, isAgentGroupId } from "./native-browser-groups.js";
import { currentInventoryTabs } from "./native-inventory-client.js";
import { onEngineInstall } from "./native-engine-install.js";

type Tracked = {
  touched: number;
  chatId?: string;
  seen?: boolean;
  url?: string;
  popup?: boolean;
  used?: boolean;
};
type Stats = { opened: number; closed: number; popups: number };

const STORAGE_KEY = "aeon-agent-tab-cleanup";
const ALARM = "aeon-agent-tab-cleanup";
const DEFAULT_IDLE_MINUTES = 10;
const MAX_CHAT_TABS = 6;
// A tab used this recently is still part of the work (parallel reads, a page it will return to).
const BUSY_MS = 30_000;

const tracked = new Map<number, Tracked>();
const stats = new Map<string, Stats>();
const guarded = new Set<number>();
const grouped = new Set<number>();
const closing = new Set<number>();
let restored: Promise<void> | undefined;
let saveTimer: ReturnType<typeof setTimeout> | undefined;

export function trackAgentTab(
  tabId: number,
  chatId?: string,
  options: { url?: string; popup?: boolean } = {},
): void {
  tracked.set(tabId, {
    touched: Date.now(),
    ...(chatId ? { chatId } : {}),
    ...(options.url ? { url: options.url } : {}),
    ...(options.popup ? { popup: true } : {}),
  });
  if (chatId) {
    const entry = stats.get(chatId) ?? { opened: 0, closed: 0, popups: 0 };
    entry.opened += 1;
    if (options.popup) entry.popups += 1;
    stats.set(chatId, entry);
  }
  save();
  if (chatId) void capChatTabs(chatId);
}

export function touchAgentTab(tabId: number): void {
  const entry = tracked.get(tabId);
  if (!entry) return;
  entry.touched = Date.now();
  save();
}

/** The user switched to the tab: they may want it after the run, so the run's tidy-up keeps it. */
function seeAgentTab(tabId: number): void {
  const entry = tracked.get(tabId);
  if (!entry) return;
  entry.seen = true;
  entry.touched = Date.now();
  save();
}

export function forgetAgentTab(tabId: number): string | undefined {
  const entry = tracked.get(tabId);
  if (entry) {
    tracked.delete(tabId);
    save();
  }
  grouped.delete(tabId);
  return entry?.chatId;
}

/** Marks a tab as placed in an agent group, so a later move out of it can hand the tab to the user. */
export function markAgentTabGrouped(tabId: number): void {
  grouped.add(tabId);
}

/** Keep a tab open while a hand-off, recording or other user-visible work owns it. */
export function guardAgentTab(tabId: number, guard: boolean): void {
  if (guard) guarded.add(tabId);
  else guarded.delete(tabId);
}

export function isAgentTab(tabId: number): boolean {
  return tracked.has(tabId);
}

/** A list request must wait for session-storage state before it marks each tab's owner. */
export function ensureAgentTabsRestored(): Promise<void> {
  return restore();
}

/** Opened popups nobody touched, live only. */
export function unusedAgentTabs(chatId: string): { tabId: number; url: string }[] {
  return chatTabs(chatId)
    .filter(([, entry]) => entry.popup && !entry.used)
    .map(([tabId, entry]) => ({ tabId, url: entry.url ?? "" }));
}

/** Tabs this chat or session opened, for browser.tabs().mine. */
export function mineTabIds(chatId: string): number[] {
  return chatTabs(chatId).map(([tabId]) => tabId);
}

/**
 * Close one explicit tab. Any agent may close any tab: its own, the user's or another session's.
 * A tab in Split View is unsplit first, because Chrome refuses to remove a paired tab cleanly.
 */
export async function closeChatTab(chatId: string, tabId: number): Promise<{ closed: number }> {
  await restore();
  const tab = await chrome.tabs.get(tabId).catch(() => undefined);
  if (!tab) {
    forgetAgentTab(tabId);
    throw new Error(`TARGET_LOST: tab ${tabId} is already closed`);
  }
  await unsplitForClose(tab, tabId);
  closing.add(tabId);
  const removed = await chrome.tabs.remove(tabId).then(
    () => true,
    () => false,
  );
  closing.delete(tabId);
  if (!removed) throw new Error(`TAB_CLOSE_FAILED: Chrome refused to close tab ${tabId}`);
  tracked.delete(tabId);
  const count = stats.get(chatId) ?? { opened: 0, closed: 0, popups: 0 };
  count.closed += 1;
  stats.set(chatId, count);
  save();
  const stillOpen = await chrome.tabs.get(tabId).catch(() => undefined);
  if (stillOpen) throw new Error(`TAB_CLOSE_FAILED: Chrome did not close tab ${tabId}`);
  return { closed: tabId };
}

export async function unsplitForClose(
  tab: chrome.tabs.Tab,
  tabId: number,
  tabsApi: typeof chrome.tabs & { unsplit?: (id: number) => Promise<void> } = chrome.tabs,
): Promise<void> {
  const splitId = (tab as chrome.tabs.Tab & { splitViewId?: number }).splitViewId;
  if (splitId === undefined || splitId < 0) return;
  const tabs = tabsApi;
  if (!tabs.unsplit)
    throw new Error(`TAB_SPLIT: tab ${tabId} is in Split View; this Chrome cannot unsplit it`);
  try {
    await tabs.unsplit(splitId);
  } catch (error) {
    throw new Error(
      `TAB_SPLIT: could not unsplit tab ${tabId}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export async function cleanupAgentTabs(options: { minutes?: number } = {}): Promise<number[]> {
  await restore();
  const idle = (options.minutes ?? DEFAULT_IDLE_MINUTES) * 60_000;
  const now = Date.now();
  return closeTabs(
    [...tracked].filter(([, entry]) => now - entry.touched >= idle),
    { keepSeen: false },
  );
}

/** After a chat's run: close its tabs except the one it used last and ones the user looked at. */
export async function tidyChatTabs(chatId: string): Promise<number[]> {
  await restore();
  const closed = await closeTabs(chatTabs(chatId).slice(1), { keepSeen: true });
  await collapseAgentGroups(chatId);
  return closed;
}

/** A daemon restarted: no chat's run survives, so tidy every tab a chat left behind. */
export async function tidyAllChatTabs(): Promise<void> {
  await restore();
  const owners = new Set(
    [...tracked.values()].flatMap((entry) => (entry.chatId ? [entry.chatId] : [])),
  );
  for (const chatId of owners) await tidyChatTabs(chatId);
}

/** browser.reset(): close every tab this chat/session opened, except ones kept for the user. */
export async function resetChatTabs(
  chatId: string,
): Promise<{ closed: number[]; remaining: number }> {
  await restore();
  const closed = await closeTabs(chatTabs(chatId), { keepSeen: false, all: true });
  return { closed, remaining: chatTabs(chatId).length };
}

/**
 * Close the tabs a site opened by itself (popups, ad tabs) during this session's run. They are
 * parked while the run works, then let go; the agent's own tabs and kept tabs stay.
 */
export async function reapChatPopups(chatId: string, since = 0): Promise<number[]> {
  await restore();
  const popups = [...tracked].filter(
    ([, entry]) => entry.chatId === chatId && entry.popup === true && entry.touched >= since,
  );
  return closeTabs(popups, { keepSeen: false, all: true });
}

/** The one-line count every browser_code result ends with. */
export function agentTabSummary(chatId: string): {
  opened: number;
  closed: number;
  mine: number[];
  total: number;
  popups: number;
} {
  const entry = stats.get(chatId) ?? { opened: 0, closed: 0, popups: 0 };
  return {
    opened: entry.opened,
    closed: entry.closed,
    mine: chatTabs(chatId).map(([tabId]) => tabId),
    total: currentInventoryTabs().length,
    popups: entry.popups,
  };
}

/** During a run: past MAX_CHAT_TABS, close the chat's least recently used tabs. */
async function capChatTabs(chatId: string): Promise<number[]> {
  const now = Date.now();
  const extra = chatTabs(chatId)
    .slice(MAX_CHAT_TABS)
    .filter(([, entry]) => now - entry.touched >= BUSY_MS);
  return extra.length ? closeTabs(extra, { keepSeen: true }) : [];
}

/** A chat's tracked tabs, most recently used first. */
function chatTabs(chatId: string): [number, Tracked][] {
  return [...tracked]
    .filter(([, entry]) => entry.chatId === chatId)
    .sort((a, b) => b[1].touched - a[1].touched);
}

async function closeTabs(
  entries: [number, Tracked][],
  options: { keepSeen: boolean; all?: boolean },
): Promise<number[]> {
  const focused = await chrome.windows.getLastFocused().catch(() => undefined);
  const closed: number[] = [];
  for (const [tabId, entry] of entries) {
    const tab = await chrome.tabs.get(tabId).catch(() => undefined);
    if (!tab || tab.pinned) {
      tracked.delete(tabId);
      continue;
    }
    if (!closable(tab, entry, focused, options)) continue;
    closing.add(tabId);
    const removed = await chrome.tabs.remove(tabId).then(
      () => true,
      () => false,
    );
    closing.delete(tabId);
    tracked.delete(tabId);
    if (removed) {
      closed.push(tabId);
      const chatId = entry.chatId;
      if (chatId) {
        const count = stats.get(chatId) ?? { opened: 0, closed: 0, popups: 0 };
        count.closed += 1;
        stats.set(chatId, count);
      }
    }
  }
  save();
  return closed;
}

function closable(
  tab: chrome.tabs.Tab,
  entry: Tracked,
  focused: chrome.windows.Window | undefined,
  options: { keepSeen: boolean; all?: boolean },
): boolean {
  if (!options.all && tab.active && tab.windowId === focused?.id && focused?.focused) return false;
  if (tab.audible || guarded.has(tab.id ?? -1)) return false;
  return !(options.keepSeen && entry.seen);
}

function restore(): Promise<void> {
  restored ??= chrome.storage.local.get(STORAGE_KEY).then((stored) => {
    const raw = stored[STORAGE_KEY];
    const saved = (raw && typeof raw === "object" && "tabs" in raw ? raw.tabs : raw) as
      Record<string, Tracked> | undefined;
    for (const [tabId, entry] of Object.entries(saved ?? {})) {
      if (!tracked.has(Number(tabId))) tracked.set(Number(tabId), entry);
    }
    if (raw && typeof raw === "object" && "stats" in raw)
      for (const [chatId, entry] of Object.entries(raw.stats as Record<string, Stats>))
        if (!stats.has(chatId)) stats.set(chatId, entry);
  });
  return restored;
}

function save(): void {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    void chrome.storage.local
      .set({
        [STORAGE_KEY]: { tabs: Object.fromEntries(tracked), stats: Object.fromEntries(stats) },
      })
      .catch(() => undefined);
  }, 500);
}

onEngineInstall(() => {
  chrome.runtime.onStartup.addListener(() => {
    tracked.clear();
    stats.clear();
    void chrome.storage.local.remove(STORAGE_KEY);
  });
  chrome.tabs.onActivated.addListener(({ tabId }) => seeAgentTab(tabId));
  chrome.tabs.onRemoved.addListener((tabId) => {
    const entry = tracked.get(tabId);
    if (entry && !closing.has(tabId) && entry.chatId) {
      const count = stats.get(entry.chatId) ?? { opened: 0, closed: 0, popups: 0 };
      count.closed += 1;
      stats.set(entry.chatId, count);
    }
    closing.delete(tabId);
    forgetAgentTab(tabId);
  });
  chrome.tabs.onUpdated.addListener((tabId, change, tab) => {
    const entry = tracked.get(tabId);
    if (entry && tab.url) entry.url = tab.url;
    if (change.pinned) forgetAgentTab(tabId);
    if (change.groupId === undefined) return;
    if (change.groupId === chrome.tabGroups.TAB_GROUP_ID_NONE && grouped.has(tabId)) {
      forgetAgentTab(tabId);
      return;
    }
    if (
      change.groupId !== chrome.tabGroups.TAB_GROUP_ID_NONE &&
      !grouped.has(tabId) &&
      !isAgentGroupId(change.groupId) &&
      agentGroupsReady()
    )
      forgetAgentTab(tabId);
  });
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === ALARM) void cleanupAgentTabs();
  });
  void chrome.alarms.create(ALARM, { periodInMinutes: 1 });
});
