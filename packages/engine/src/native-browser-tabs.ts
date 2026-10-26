import {
  BrowserExecutorResultSchema,
  type BrowserExecutorRequest,
  type BrowserExecutorResult,
  type BrowserTargetKey,
} from "@browserkit/protocol";
import {
  currentFocusedWindowId,
  currentInventoryTabs,
  refreshInventoryTab,
} from "./native-inventory-client.js";
import { ensureAgentTabsRestored, mineTabIds } from "./native-browser-tab-cleanup.js";
import { safePage, sameTarget } from "./native-browser-common.js";
import { controlOf } from "./native-browser-control.js";
import { isSharedBrowserTab } from "./native-browser-session.js";
import { ensureSpacesRestored, labelOf } from "./native-browser-spaces.js";

// Listing tabs as Chrome has them now. `mine` marks this session's tabs; another session's tab is
// still listed (mine:false) so attaching it can open this session its own copy.
export async function listTabs(request: BrowserExecutorRequest): Promise<BrowserExecutorResult> {
  const step = request.step.op === "listTabs" ? request.step : undefined;
  const query = step?.query;
  await ensureAgentTabsRestored();
  await ensureSpacesRestored();
  await refreshActiveTabs();
  const mine = new Set(mineTabIds(request.chatId));
  const tabs = currentInventoryTabs()
    .filter((tab) => safePage(tab.url))
    .filter((tab) => !step?.mine || mine.has(tab.target.tabId))
    .filter((tab) => !step?.shared || isSharedBrowserTab(tab.target.tabId));
  const filtered = query
    ? tabs.filter((tab) => `${tab.title} ${tab.url}`.toLowerCase().includes(query.toLowerCase()))
    : tabs;
  return BrowserExecutorResultSchema.parse({
    kind: "tabs",
    tabs: filtered.slice(0, 256).map((tab) => ({
      ...tab,
      mine: mine.has(tab.target.tabId),
      control: controlOf(tab.target.tabId),
      ...(labelOf(request.chatId, tab.target.tabId)
        ? { label: labelOf(request.chatId, tab.target.tabId) }
        : {}),
    })),
    focusedWindowId: currentFocusedWindowId(),
  });
}

// Chrome only reports activation for a focused window, so a tab opened in a background or
// headless window can sit in the inventory as inactive. Ask each window which tab is active at
// list time, so browser.tabs() and browser.activeTab() both describe Chrome as it is now.
async function refreshActiveTabs(): Promise<void> {
  const windowIds = [...new Set(currentInventoryTabs().map((tab) => tab.windowId))];
  await Promise.all(
    windowIds.map(async (windowId) => {
      const [live] = await chrome.tabs.query({ active: true, windowId }).catch(() => []);
      if (live?.id !== undefined) await refreshInventoryTab(live.id);
    }),
  );
}

// A tab the user already has open, picked from browser.tabs(): the runtime host checked the
// target is listed; it is borrowed, not owned, so it is not grouped or bound to the session.
export function attachTab(target: BrowserTargetKey): BrowserExecutorResult {
  const tab = currentInventoryTabs().find((known) => sameTarget(known.target, target));
  if (!tab || !safePage(tab.url)) throw new Error("TARGET_LOST");
  return BrowserExecutorResultSchema.parse({ kind: "tab", tab });
}

/** Whether the tab still exists on an http(s) page. */
export async function isLivePage(tabId: number): Promise<boolean> {
  const tab = await chrome.tabs.get(tabId).catch(() => undefined);
  return Boolean(tab?.url && safePage(tab.url));
}

/** A readable host for a tab caption. */
export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www./, "");
  } catch {
    return "page";
  }
}
