// Another extension's frame in a page (a password manager's inline menu: 1Password, LastPass,
// Bitwarden) makes Chrome refuse debugger commands on the tab or drop the debugger. Removing those
// frames and attaching again recovers; when a frame keeps coming back, the step fails with
// PROTECTED_UI so the agent asks the user instead of retrying. Pages the user browses are never
// touched: only tabs a step is running on.

export const FOREIGN_FRAME = /Cannot access a chrome-extension:\/\/ URL|Debugger is not attached/i;

/** Removes other extensions' frames and password-manager overlays from the tab; returns how many. */
export async function evictForeignFrames(tabId: number): Promise<number> {
  const results = await chrome.scripting
    .executeScript({
      target: { tabId, allFrames: false },
      func: evict,
      args: [chrome.runtime.id],
    })
    .catch(() => []);
  return Number(results[0]?.result ?? 0);
}

/** Whether the tab shows a web page (an extension or browser page is not ready, not protected). */
export async function webPage(tabId: number): Promise<boolean> {
  const tab = await chrome.tabs.get(tabId).catch(() => undefined);
  return /^https?:/i.test(tab?.url ?? tab?.pendingUrl ?? "");
}

export function protectedUiError(): Error {
  return new Error(
    "PROTECTED_UI: another extension's popup (usually a password manager's menu) keeps blocking this tab; ask the user to close it or finish the step (bu.handoff), then continue",
  );
}

// Runs in the page (isolated world), so it sees closed shadow hosts and the page cannot stop it.
function evict(ownId: string): number {
  const own = "chrome-extension://" + ownId;
  const foreign = (element: Element): boolean => {
    const tag = element.tagName.toLowerCase();
    if (
      tag.startsWith("com-1password-") ||
      element.hasAttribute("data-onepassword-extension") ||
      element.hasAttribute("data-lastpass-root") ||
      element.id.startsWith("bitwarden-")
    )
      return true;
    if (!["iframe", "frame", "object", "embed"].includes(tag)) return false;
    const src = element.getAttribute("src") ?? element.getAttribute("data") ?? "";
    return src.startsWith("chrome-extension://") && !src.startsWith(own);
  };
  let removed = 0;
  const visit = (root: Document | ShadowRoot | Element): void => {
    for (const element of Array.from(root.querySelectorAll("*"))) {
      if (!element.isConnected) continue;
      if (foreign(element)) {
        element.remove();
        removed += 1;
      } else if (element.shadowRoot) visit(element.shadowRoot);
    }
  };
  visit(document);
  return removed;
}
