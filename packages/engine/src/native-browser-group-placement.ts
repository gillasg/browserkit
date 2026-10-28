import { handoffActive } from "./native-browser-control.js";
import { agentGroupIds } from "./native-browser-groups.js";
import { onEngineInstall } from "./native-engine-install.js";

// Agent tab groups stay out of the way: at the start of the tab strip (right after pinned tabs)
// and collapsed unless the user is on one of their tabs. Chrome expands a group by itself when
// one of its tabs becomes active (the user picks it, a hand-off focuses it). A group stays open
// while a hand-off waits on one of its tabs or one of its tabs sits in a split view.

/** Moves a window's agent groups to the start of the strip and folds away those not in use. */
export async function settleAgentGroups(windowId: number): Promise<void> {
  const ids = new Set(agentGroupIds());
  if (!ids.size || typeof chrome.tabGroups?.move !== "function") return;
  const tabs = await chrome.tabs.query({ windowId }).catch(() => [] as chrome.tabs.Tab[]);
  await keepFirst(tabs, ids);
  const active = tabs.find((tab) => tab.active);
  for (const groupId of new Set(tabs.map((tab) => tab.groupId)))
    if (ids.has(groupId) && groupId !== active?.groupId && !inUse(tabs, groupId))
      await chrome.tabGroups.update(groupId, { collapsed: true }).catch(() => undefined);
}

async function keepFirst(tabs: chrome.tabs.Tab[], ids: Set<number>): Promise<void> {
  const pinned = tabs.filter((tab) => tab.pinned).length;
  const agentTabs = tabs.filter((tab) => ids.has(tab.groupId)).length;
  if (tabs.slice(pinned, pinned + agentTabs).every((tab) => ids.has(tab.groupId))) return;
  const order: number[] = [];
  for (const tab of tabs)
    if (ids.has(tab.groupId) && !order.includes(tab.groupId)) order.push(tab.groupId);
  let index = pinned;
  for (const groupId of order) {
    await chrome.tabGroups.move(groupId, { index }).catch(() => undefined);
    index += tabs.filter((tab) => tab.groupId === groupId).length;
  }
}

function inUse(tabs: chrome.tabs.Tab[], groupId: number): boolean {
  return tabs.some((tab) => {
    if (tab.groupId !== groupId || tab.id === undefined) return false;
    const split = (tab as { splitViewId?: number }).splitViewId;
    return handoffActive(tab.id) || (split !== undefined && split >= 0);
  });
}

// A new or moved tab may land before the agent groups; settle once things are quiet.
const timers = new Map<number, ReturnType<typeof setTimeout>>();
function scheduleSettle(windowId: number): void {
  clearTimeout(timers.get(windowId));
  timers.set(
    windowId,
    setTimeout(() => {
      timers.delete(windowId);
      void settleAgentGroups(windowId);
    }, 150),
  );
}

onEngineInstall(() => {
  chrome.tabs.onActivated.addListener(({ windowId }) => scheduleSettle(windowId));
  chrome.tabs.onCreated.addListener((tab) => {
    if (tab.windowId !== undefined) scheduleSettle(tab.windowId);
  });
  chrome.tabs.onAttached.addListener((_tabId, info) => scheduleSettle(info.newWindowId));
});
