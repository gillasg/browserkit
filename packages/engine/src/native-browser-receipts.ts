import { onEngineInstall } from "./native-engine-install.js";

// Per-tab receipts for one action: popups it opened, a dialog it raised, a download it started,
// and whether the page navigated. Subscribers are intentionally not the source: they are per
// chat and would also report work started outside the action being measured.
export interface ActionReceipt {
  popups: { tabId: number; url: string }[];
  dialog?: { type: string; message: string; accepted: boolean };
  navigated: boolean;
  download?: { url: string; filename: string; token?: string };
}

const receipts = new Map<number, ActionReceipt>();

export function beginReceipt(tabId: number): void {
  receipts.set(tabId, { popups: [], navigated: false });
}

export function noteReceiptPopup(openerId: number, tabId: number, url = ""): void {
  const receipt = receipts.get(openerId);
  if (!receipt) return;
  receipt.popups.push({ tabId, url });
}

export function takeReceipt(tabId: number): ActionReceipt {
  const receipt = receipts.get(tabId) ?? { popups: [], navigated: false };
  receipts.delete(tabId);
  return receipt;
}

onEngineInstall(() => {
  chrome.debugger.onEvent.addListener((source, method, params) => {
    if (source.tabId === undefined) return;
    const receipt = receipts.get(source.tabId);
    if (!receipt) return;
    if (method === "Page.javascriptDialogOpening") {
      const value = params as { type?: string; message?: string };
      receipt.dialog = {
        type: String(value.type ?? "alert"),
        message: String(value.message ?? "").slice(0, 300),
        accepted: true,
      };
    } else if (method === "Page.downloadWillBegin") {
      const value = params as { url?: string; suggestedFilename?: string; guid?: string };
      receipt.download = {
        url: String(value.url ?? "").slice(0, 2000),
        filename: String(value.suggestedFilename ?? "").slice(0, 300),
        ...(value.guid ? { token: value.guid } : {}),
      };
    }
  });
});
