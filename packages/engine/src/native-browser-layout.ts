import { engineConfig } from "./engine-config.js";
import { isAgentGroupId } from "./native-browser-groups.js";

type SplitTab = chrome.tabs.Tab & { splitViewId?: number };
type SplitTabs = typeof chrome.tabs & {
  createSplit?: (ids: [number, number]) => Promise<number>;
  unsplit?: (id: number) => Promise<void>;
};
const pending = new Map<string, Promise<void>>();
const pairs = new Map<string, { targetId: number; splitId: number }>();
const PRESENT_OPS = new Set(["click", "fill", "press", "navigate", "openTab"]);

/** Acting in a tab updates Split View; reading, evaluating or listing never does. */
export function presentsBrowserTask(op: string): boolean {
  return PRESENT_OPS.has(op);
}
/**
 * Present browser work beside its regular chat. Side-panel-only chats keep their panel. In
 * thumbnail view the chat page shows live thumbnails instead, and a clicked thumbnail forces it.
 */
export async function presentBrowserTask(
  chatId: string,
  tabId: number,
  force = false,
): Promise<void> {
  const tabs = chrome.tabs as SplitTabs;
  // Working in front: whichever tab the agent works in becomes the visible one.
  if (await engineConfig.agentInFront().catch(() => false))
    await chrome.tabs.update(tabId, { active: true }).catch(() => undefined);
  if (!tabs.createSplit || !tabs.unsplit) return;
  if (!force && (await engineConfig.agentView(chatId).catch(() => "split")) === "thumbnails") return;
  const prior = pending.get(chatId) ?? Promise.resolve();
  const work = prior
    .then(() => pairChat(tabs, chatId, tabId, force))
    .catch((error) => {
      // A layout failure must not turn a completed browser action into a failed action.
      console.warn("Could not open browser Split View:", String(error));
    });
  pending.set(chatId, work);
  await work;
  if (pending.get(chatId) === work) pending.delete(chatId);
}
async function pairChat(
  tabs: SplitTabs,
  chatId: string,
  tabId: number,
  force: boolean,
): Promise<void> {
  const target = (await tabs.get(tabId)) as SplitTab;
  const prior = pairs.get(chatId);
  if (prior && prior.targetId === target.id && prior.splitId === target.splitViewId) return;
  const candidates = ((await tabs.query({})) as SplitTab[]).filter((tab) => isChat(tab, chatId));
  const chat = selectChat(candidates, target.windowId);
  if (!chat?.id || !target.id || chat.id === target.id) return;
  if (hasSplit(chat) && chat.splitViewId === target.splitViewId) return;
  // Pairing must not pull the user away from another tab. Bring the pair forward only when they
  // were already looking at this chat or its tab, when they must act (hand-off), or when the
  // agent works in front.
  const [previous] = (await tabs.query({ active: true, windowId: chat.windowId })) as SplitTab[];
  const front =
    force || chat.active || target.active || (await engineConfig.agentInFront().catch(() => false));
  await alignTabs(tabs, chat, target);
  const splitId = await tabs.createSplit?.([chat.id, target.id]);
  if (splitId !== undefined) pairs.set(chatId, { targetId: target.id, splitId });
  if (front) await tabs.update(chat.id, { active: true });
  else if (previous?.id !== undefined && previous.id !== chat.id && previous.id !== target.id)
    await tabs.update(previous.id, { active: true }).catch(() => undefined);
}
async function alignTabs(tabs: SplitTabs, chat: SplitTab, target: SplitTab): Promise<void> {
  if (chat.id === undefined || target.id === undefined) return;
  await clearSplits(tabs, [chat.splitViewId, target.splitViewId]);
  if (target.windowId !== chat.windowId)
    await tabs.move(target.id, { windowId: chat.windowId, index: -1 });
  if (target.pinned !== chat.pinned) await tabs.update(target.id, { pinned: chat.pinned });
  const current = await tabs.get(target.id);
  // Split View pairs the chat with the agent's tab; it does not need either tab in a group, and
  // the chat never joins the agent's group (a tab opened from the chat would inherit it). If an
  // older run left the chat in an agent group, take it out.
  if (isAgentGroupId(chat.groupId)) await tabs.ungroup(chat.id).catch(() => undefined);
  if (isAgentGroupId(current.groupId)) await tabs.ungroup(target.id).catch(() => undefined);
  // Chrome pairs tabs in one group. A chat that has its own group keeps it and the agent tab
  // joins that group; a chat with no group never joins the agent's — the agent tab is taken out
  // instead, so a tab opened from the chat cannot inherit an agent group.
  const chatNow = await tabs.get(chat.id);
  const targetNow = await tabs.get(target.id);
  if (chatNow.groupId >= 0 && targetNow.groupId !== chatNow.groupId)
    await tabs.group({ tabIds: [target.id], groupId: chatNow.groupId }).catch(() => undefined);
  else if (chatNow.groupId < 0 && targetNow.groupId >= 0)
    await tabs.ungroup(target.id).catch(() => undefined);
  await makeAdjacent(tabs, chat.id, target.id);
}
async function makeAdjacent(tabs: SplitTabs, chatId: number, targetId: number): Promise<void> {
  const chat = await tabs.get(chatId),
    target = await tabs.get(targetId);
  if (target.index === chat.index + 1) return;
  await tabs.move(targetId, {
    windowId: chat.windowId,
    index: chat.index + (target.index > chat.index ? 1 : 0),
  });
}
async function clearSplits(tabs: SplitTabs, ids: (number | undefined)[]): Promise<void> {
  for (const id of new Set(ids)) if (id !== undefined && id >= 0) await tabs.unsplit?.(id);
}
function selectChat(candidates: SplitTab[], windowId: number): SplitTab | undefined {
  return (
    candidates.find((tab) => tab.active && tab.windowId === windowId) ??
    candidates.find((tab) => tab.windowId === windowId) ??
    candidates.find((tab) => tab.active)
  );
}
function hasSplit(tab: SplitTab): boolean {
  return tab.splitViewId !== undefined && tab.splitViewId >= 0;
}
function isChat(tab: SplitTab, chatId: string): boolean {
  if (!tab.url?.startsWith(chrome.runtime.getURL("chat.html"))) return false;
  return new URL(tab.url).searchParams.get("chatId") === chatId;
}
