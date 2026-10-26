// Park idle agent tabs. A frozen tab stops timers and repaints, which also stops screencast and
// flight, so tabs that are recording, guarded or being watched are never frozen. Requests reconcile
// the wanted state through a chain: two steps on one tab cannot race freeze/unfreeze.
import { onEngineInstall } from "./native-engine-install.js";
import {
  idleAgentTabIds,
  isAgentTabGuarded,
  isAgentTabSeen,
  setAgentTabIdleListener,
  setAgentTabTouchListener,
} from "./native-browser-tab-cleanup.js";
import { isManualScreencast } from "./native-browser-flight.js";

let sequence = 0;
const desired = new Map<number, "active" | "frozen">();
const applied = new Map<number, "active" | "frozen">();
const chains = new Map<number, Promise<void>>();

export async function setAgentTabLifecycle(
  tabId: number,
  state: "active" | "frozen",
): Promise<void> {
  desired.set(tabId, state);
  const previous = chains.get(tabId) ?? Promise.resolve();
  const run = previous.then(async () => {
    if (applied.get(tabId) === state) return;
    await chrome.debugger.sendCommand({ tabId }, "Page.setWebLifecycleState", { state });
    applied.set(tabId, state);
  });
  chains.set(
    tabId,
    run.catch(() => undefined),
  );
  await run;
}

export async function unparkAgentTab(tabId: number): Promise<void> {
  if (desired.get(tabId) !== "frozen" && applied.get(tabId) !== "frozen") return;
  await setAgentTabLifecycle(tabId, "active").catch(() => undefined);
}

/** Freeze tracked tabs that have been idle past BUSY_MS and are not watched or recording. */
export async function parkIdleAgentTabs(now = Date.now(), busyMs = 30_000): Promise<number[]> {
  const parked: number[] = [];
  for (const tabId of idleAgentTabIds(now, busyMs)) {
    if (isAgentTabSeen(tabId) || isManualScreencast(tabId) || isAgentTabGuarded(tabId)) continue;
    await setAgentTabLifecycle(tabId, "frozen").catch(() => undefined);
    parked.push(tabId);
  }
  return parked;
}

// Kept as a soft reference so the cleanup module does not import this one (a cycle would freeze
// the module graph before the listener is installed).
setAgentTabTouchListener((tabId) => void unparkAgentTab(tabId));
setAgentTabIdleListener(() => void parkIdleAgentTabs());

onEngineInstall(() => {
  chrome.tabs.onRemoved.addListener((tabId) => {
    desired.delete(tabId);
    applied.delete(tabId);
    chains.delete(tabId);
    sequence++;
  });
});

/** Exposed for tests: the reconciliation sequence is strictly monotonic. */
export function lifecycleSequence(): number {
  return sequence;
}
