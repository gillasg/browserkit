import { closeChatTab } from "./native-browser-tab-cleanup.js";

/** browser.closeTab: validate the id here, then close any tab. */
export function closeTabCall(chatId: string, request: object): Promise<{ closed: number }> {
  const tabId = Number((request as { tabId?: unknown }).tabId);
  if (!Number.isSafeInteger(tabId) || tabId < 0)
    throw new Error("INVALID_TARGET: browser.closeTab needs a tab id");
  return closeChatTab(chatId, tabId);
}
