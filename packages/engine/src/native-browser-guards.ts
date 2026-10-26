import type { BrowserStep } from "@browserkit/protocol";
import { onEngineInstall } from "./native-engine-install.js";

// A per-tab read-only claim. It is a guard, not a sandbox: page.evaluate can still mutate through
// the page's own APIs, but ordinary write steps and browser-wide CDP clears are refused.
const readOnly = new Map<number, boolean>();
onEngineInstall(() => {
  chrome.tabs.onRemoved.addListener((tabId) => readOnly.delete(tabId));
});

export function setReadOnly(tabId: number, value: boolean): void {
  if (value) readOnly.set(tabId, true);
  else readOnly.delete(tabId);
}

export function isReadOnly(tabId: number): boolean {
  return readOnly.has(tabId);
}

export function clearReadOnly(tabId: number): void {
  readOnly.delete(tabId);
}

/** Commands that erase browser-wide state are never part of a page session, read-only or not. */
export function refusedCdp(
  method: string,
  params: Record<string, unknown> = {},
): string | undefined {
  if (method === "Network.clearBrowserCookies" || method === "Network.clearBrowserCache")
    return `${method} is browser-wide; use browser.cookies or page.cookies instead`;
  if (method === "Storage.clearCookies")
    return "Storage.clearCookies is browser-wide; use browser.cookies or page.cookies instead";
  if (method === "Storage.clearDataForOrigin" && !String(params.origin ?? "").trim())
    return "Storage.clearDataForOrigin needs an explicit origin";
  if (method === "Storage.clearDataForStorageKey" && !String(params.storageKey ?? "").trim())
    return "Storage.clearDataForStorageKey needs an explicit storage key";
  return undefined;
}

export function stepChangesPage(step: BrowserStep): boolean {
  switch (step.op) {
    case "click":
    case "fill":
    case "press":
    case "keys":
    case "pointer":
    case "upload":
    case "navigate":
      return true;
    case "frames":
      return step.action === "click" || step.action === "fill" || step.action === "cdp";
    case "downloads":
      return step.action === "start";
    case "cdp":
      return cdpChangesPage(step.method);
    default:
      return false;
  }
}

/** CDP methods that write. Reads such as DOM.getBoxModel and Page.captureScreenshot are allowed. */
export function cdpChangesPage(method: string): boolean {
  return (
    /^(?:Input\.|Page\.(?:navigate|reload|close|captureScreenshot)|Network\.(?:set|clear)|Storage\.|Runtime\.(?:evaluate|callFunctionOn)|Emulation\.(?:set|clear)|Fetch\.|DOM\.(?:set|focus|scroll)|Target\.|Browser\.)/.test(
      method,
    ) && !/^Page\.captureScreenshot$/.test(method)
  );
}
