import { onEngineInstall } from "./native-engine-install.js";
import { currentFocusedWindowId } from "./native-inventory-client.js";
import { releaseBrowserSessions } from "./native-browser-session.js";
import { forgetAgentTab, mineTabIds } from "./native-browser-tab-cleanup.js";
import { controlOf, handoffActive } from "./native-browser-control.js";

// A session's tabs live either in the user's window (an interactive chat) or in one window of
// their own (sweeps, jobs, outside clients), created behind the user's window and kept normal so
// Chrome still paints it. A session also keeps stable labels (p1, p2…) so a tab can be named
// after its id changed, and can finish by keeping a few tabs and closing the rest.

export type SpaceKind = "window" | "tabs";
interface LabelRecord {
  label: string;
  tabId: number;
  url: string;
}
interface SpaceRecord {
  chatId: string;
  space: SpaceKind;
  windowId?: number;
  labels: LabelRecord[];
  createdAt: number;
}
const STORAGE_KEY = "browserkit-spaces";
const spaces = new Map<string, SpaceRecord>();
let restored: Promise<void> | undefined;

export function ensureSpacesRestored(): Promise<void> {
  restored ??=
    chrome.storage?.session
      ?.get(STORAGE_KEY)
      .then((stored) => {
        for (const record of (stored[STORAGE_KEY] as SpaceRecord[] | undefined) ?? [])
          spaces.set(record.chatId, record);
      })
      .catch(() => undefined) ?? Promise.resolve();
  return restored;
}

function save(): void {
  if (!chrome.storage?.session) return;
  void chrome.storage.session.set({ [STORAGE_KEY]: [...spaces.values()] }).catch(() => undefined);
}

export function spaceOf(chatId: string): SpaceKind | undefined {
  return spaces.get(chatId)?.space;
}

export function noteSpace(chatId: string, space: SpaceKind, windowId?: number): void {
  const record = spaces.get(chatId) ?? { chatId, space, labels: [], createdAt: Date.now() };
  record.space = space;
  if (space === "tabs") delete record.windowId;
  else if (windowId !== undefined) record.windowId = windowId;
  spaces.set(chatId, record);
  save();
}

/** One window per session, reused; created behind the user's window and never minimized. */
export async function spaceWindow(chatId: string): Promise<number> {
  await ensureSpacesRestored();
  const record = spaces.get(chatId);
  const existing = record?.windowId;
  if (existing !== undefined) {
    const window = await chrome.windows.get(existing).catch(() => undefined);
    if (window) return existing;
  }
  const userWindow = currentFocusedWindowId();
  const created = await chrome.windows.create({
    url: "about:blank",
    focused: false,
    type: "normal",
    state: "normal",
    width: 1280,
    height: 900,
  });
  if (!created?.id) throw new Error("TARGET_LOST");
  noteSpace(chatId, "window", created.id);
  if (userWindow !== undefined)
    await chrome.windows.update(userWindow, { focused: true }).catch(() => undefined);
  return created.id;
}

/** A stable label for a tab in this session; the same URL keeps its label after a restart. */
export function noteLabel(chatId: string, tabId: number, url: string): string {
  const record = spaces.get(chatId);
  if (!record) return "";
  const byId = record.labels.find((entry) => entry.tabId === tabId);
  if (byId) {
    byId.url = url;
    save();
    return byId.label;
  }
  const byUrl = record.labels.find((entry) => entry.url === url);
  if (byUrl) {
    byUrl.tabId = tabId;
    save();
    return byUrl.label;
  }
  const used = new Set(record.labels.map((entry) => Number(entry.label.slice(1))));
  let next = 1;
  while (used.has(next)) next += 1;
  const label = `p${next}`;
  record.labels.push({ label, tabId, url });
  save();
  return label;
}

export function labelOf(chatId: string, tabId: number): string | undefined {
  return spaces.get(chatId)?.labels.find((entry) => entry.tabId === tabId)?.label;
}

/** A label as a tab id, re-bound by URL when Chrome restarted and ids changed. */
export async function resolveLabel(
  chatId: string,
  label: string,
): Promise<{ tabId: number; url?: string } | undefined> {
  await ensureSpacesRestored();
  const record = spaces.get(chatId);
  const entry = record?.labels.find((item) => item.label === label);
  if (!record || !entry) return undefined;
  const live = await chrome.tabs.get(entry.tabId).catch(() => undefined);
  if (live && (!entry.url || live.url === entry.url))
    return { tabId: entry.tabId, ...(live.url ? { url: live.url } : {}) };
  const candidates = await Promise.all(
    mineTabIds(chatId).map((tabId) => chrome.tabs.get(tabId).catch(() => undefined)),
  );
  const found = candidates.find((tab) => tab?.id !== undefined && tab.url === entry.url);
  if (!found?.id) return undefined;
  entry.tabId = found.id;
  save();
  return { tabId: found.id, ...(found.url ? { url: found.url } : {}) };
}

export interface SpaceSummary {
  chatId: string;
  space: SpaceKind;
  windowId?: number;
  tabs: number;
  labels: string[];
  status: "running" | "waiting" | "user" | "idle";
}

export async function listSpaces(): Promise<SpaceSummary[]> {
  await ensureSpacesRestored();
  return [...spaces.values()].map((record) => {
    const tabs = mineTabIds(record.chatId);
    const status = tabs.some((tabId) => controlOf(tabId) === "user")
      ? ("user" as const)
      : tabs.some((tabId) => handoffActive(tabId))
        ? ("waiting" as const)
        : tabs.length
          ? ("running" as const)
          : ("idle" as const);
    return {
      chatId: record.chatId,
      space: record.space,
      ...(record.windowId !== undefined ? { windowId: record.windowId } : {}),
      tabs: tabs.length,
      labels: record.labels.map((entry) => entry.label),
      status,
    };
  });
}

/** Ends a session: keep the named tabs (moved to the user's window), close the rest. */
export async function finishSpace(
  chatId: string,
  keep: string[] = [],
): Promise<{ kept: number; closed: number }> {
  await ensureSpacesRestored();
  const record = spaces.get(chatId);
  const keepIds = new Set<number>();
  for (const name of keep) {
    const resolved = await resolveLabel(chatId, name);
    const tabId = resolved?.tabId ?? (/^\d+$/.test(name) ? Number(name) : undefined);
    if (tabId !== undefined) keepIds.add(tabId);
  }
  const all = new Set(mineTabIds(chatId));
  if (record?.windowId !== undefined) {
    const window = await chrome.tabs.query({ windowId: record.windowId }).catch(() => []);
    for (const tab of window) if (tab.id !== undefined) all.add(tab.id);
  }
  const target = currentFocusedWindowId();
  let kept = 0;
  let closed = 0;
  for (const tabId of all) {
    if (keepIds.has(tabId)) {
      if (target !== undefined && (await chrome.tabs.get(tabId).catch(() => undefined))) {
        await chrome.tabs.move(tabId, { windowId: target, index: -1 }).catch(() => undefined);
        kept += 1;
      }
      forgetAgentTab(tabId);
      continue;
    }
    const gone = await chrome.tabs.remove(tabId).then(
      () => true,
      () => false,
    );
    if (gone) closed += 1;
    forgetAgentTab(tabId);
  }
  await releaseBrowserSessions(chatId, true);
  spaces.delete(chatId);
  save();
  return { kept, closed };
}

/** Hands the whole space to the user: the agent stops, every tab stays where it is. */
export async function claimSpace(chatId: string): Promise<{ tabs: number }> {
  await ensureSpacesRestored();
  const tabs = mineTabIds(chatId);
  for (const tabId of tabs) forgetAgentTab(tabId);
  await releaseBrowserSessions(chatId, true);
  spaces.delete(chatId);
  save();
  return { tabs: tabs.length };
}

onEngineInstall(() => {
  chrome.tabs.onRemoved.addListener((tabId) => {
    let changed = false;
    for (const record of spaces.values()) {
      const before = record.labels.length;
      record.labels = record.labels.filter((entry) => entry.tabId !== tabId);
      if (record.labels.length !== before) changed = true;
    }
    if (changed) save();
  });
  void ensureSpacesRestored();
});
