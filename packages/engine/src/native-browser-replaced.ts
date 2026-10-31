// Chrome swaps a tab's id when it discards it (Memory Saver, chrome.tabs.discard) or swaps in a
// prerendered page, and a discarded tab has no page to drive. Agent tabs sit in the background,
// exactly where Memory Saver discards, so without this a step failed as TAB_DEAD on a tab that
// is still there: our failure, not the page's.

const MAX_HOPS = 16;
const MAX_REMEMBERED = 64;
const replaced = new Map<number, number>();

/** The tab id now standing in for `tabId`, or `tabId` when it was never replaced. */
export function followReplacement(tabId: number): number {
  let current = tabId;
  for (let hop = 0; hop < MAX_HOPS; hop++) {
    const next = replaced.get(current);
    if (next === undefined || next === current) return current;
    current = next;
  }
  return current;
}

/** Records that `added` replaced `removed`, flattening chains and keeping the map small. */
export function recordReplacement(removed: number, added: number): void {
  for (const [from, to] of replaced) if (to === removed) replaced.set(from, added);
  replaced.set(removed, added);
  while (replaced.size > MAX_REMEMBERED) replaced.delete(replaced.keys().next().value as number);
}

/** Loads a discarded tab back in the background (never activating it), bounded. */
export async function reviveDiscardedTab(tabId: number, timeoutMs = 8000): Promise<void> {
  const tab = await readTab(tabId);
  if (!tab?.discarded) return;
  await chrome.tabs.reload(tabId);
  const until = Date.now() + timeoutMs;
  for (;;) {
    const current = await readTab(followReplacement(tabId));
    if (!current || (!current.discarded && current.status === "complete")) return;
    if (Date.now() >= until) return;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
}

/** A tab that cannot be read is treated as not discarded: attaching then says what is wrong. */
async function readTab(tabId: number): Promise<chrome.tabs.Tab | undefined> {
  try {
    return await chrome.tabs.get(tabId);
  } catch {
    return undefined;
  }
}
