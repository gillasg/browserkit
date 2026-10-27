import type { BrowserStep } from "@browserkit/protocol";

// A per-tab read-only claim used to refuse writes. It is gone: `readOnly` is now guidance for
// the agent, never a deterministic gate. The browser-wide clears below stay refused because
// they erase state for every site and every session, read-only or not.

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
