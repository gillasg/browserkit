// Another extension's frame in a page (a password manager's inline menu, for example) makes
// Chrome refuse debugger commands on the tab or drop the debugger. Removing those
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

// Runs in the page's isolated world. Walks the document and every shadow root, closed ones too
// (chrome.dom reaches them from an extension). A frame of another extension goes with the element
// whose shadow root holds it (that extension's own wrapper), never anything further out, so a
// page built from web components keeps its own elements.
function evict(ownId: string): number {
  const own = `chrome-extension://${ownId}/`;
  const shadowOf = (element: Element): ShadowRoot | null => {
    try {
      return chrome.dom.openOrClosedShadowRoot(element as HTMLElement) ?? null;
    } catch {
      return element.shadowRoot;
    }
  };
  const foreignFrame = (element: Element): boolean => {
    if (!/^(IFRAME|FRAME|OBJECT|EMBED)$/.test(element.tagName)) return false;
    const url = element.getAttribute("src") ?? element.getAttribute("data") ?? "";
    return url.startsWith("chrome-extension://") && !url.startsWith(own);
  };
  const doomed = new Set<Element>();
  const walk = (root: Document | ShadowRoot, host: Element | undefined): void => {
    for (const element of Array.from(root.querySelectorAll("*"))) {
      if (foreignFrame(element)) doomed.add(host ?? element);
      const inner = shadowOf(element);
      if (inner) walk(inner, element);
    }
  };
  walk(document, undefined);
  for (const element of doomed) element.remove();
  return doomed.size;
}
