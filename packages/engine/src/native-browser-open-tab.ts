// Opening a tab: create it where the run wants it, record it, and wait for its first page.
import { engineConfig } from "./engine-config.js";
import type {
  BrowserExecutorRequest,
  BrowserExecutorResult,
  BrowserStep,
} from "@browserkit/protocol";
import { BrowserExecutorResultSchema } from "@browserkit/protocol";
import {
  withBrowserDebugger,
  assertRequestActive,
  bindBrowserSession,
} from "./native-browser-session.js";
import { claimAgentTab, groupAgentTab } from "./native-browser-groups.js";
import { markAgentTabGrouped, trackAgentTab } from "./native-browser-tab-cleanup.js";
import { ownerTitle } from "./native-browser-owner.js";
import { enableQuietTab } from "./native-browser-quiet.js";
import { refreshInventoryTab } from "./native-inventory-client.js";
import { safePage, sameIdentity } from "./native-browser-common.js";
import { navigateReady } from "./native-browser-navigation.js";
import { captureFromTabStart } from "./native-browser-network.js";
import type { BrowserIdentity } from "./native-worker-identity.js";

export async function openTab(
  identity: BrowserIdentity,
  request: BrowserExecutorRequest,
): Promise<BrowserExecutorResult> {
  const step = validOpenTab(request, identity);
  const created = await createTab(step);
  if (created.id === undefined) throw new Error("TARGET_LOST");
  trackAgentTab(created.id, request.chatId, { url: step.url });
  bindBrowserSession(created.id, request.chatId);
  markAgentTabGrouped(created.id);
  claimAgentTab(created.id);
  await groupAgentTab(
    created.id,
    created.windowId,
    request.chatId,
    step.ownerTitle ?? ownerTitle(request.chatId),
  );
  if (step.quiet) await enableQuietTab(created.id);
  const navigation = await navigateOpenedTab(created.id, step.url, step.timeoutMs, step.referer);
  assertRequestActive(request);
  const tab = await refreshInventoryTab(created.id);
  if (!tab || !sameIdentity(tab.target, identity)) throw new Error("TARGET_LOST");
  bindBrowserSession(created.id, request.chatId);
  return BrowserExecutorResultSchema.parse({
    kind: "tab",
    tab,
    ...(navigation ? { navigation: "failed" as const, reason: navigation } : {}),
  });
}

/**
 * Opens the tab's page, recording it from its first request. A page that will not load leaves a
 * tab behind: it belongs to this run, so it is reported (navigation: "failed", reason) rather
 * than thrown away as an untracked stray.
 */
async function navigateOpenedTab(
  tabId: number,
  url: string,
  timeoutMs?: number,
  referer?: string,
): Promise<string | undefined> {
  try {
    await withBrowserDebugger(tabId, async () => {
      await captureFromTabStart(tabId);
      await navigateReady(tabId, url, timeoutMs, referer);
    });
    return undefined;
  } catch (error) {
    return (error instanceof Error ? error.message : String(error)).slice(0, 400);
  }
}

// A window of its own is focused and normal-sized, so Chrome keeps painting it (screencasts and
// screenshots of a minimized or hidden window stall).
async function createTab(step: Extract<BrowserStep, { op: "openTab" }>): Promise<chrome.tabs.Tab> {
  if (!step.window) {
    const front = step.foreground || (await engineConfig.agentInFront().catch(() => false));
    return chrome.tabs.create({ url: "about:blank", active: front });
  }
  const window = await chrome.windows.create({
    url: "about:blank",
    focused: true,
    type: "normal",
    width: step.window.width,
    height: step.window.height,
  });
  const tab = window?.tabs?.[0];
  if (!tab) throw new Error("TARGET_LOST");
  return tab;
}

function validOpenTab(
  request: BrowserExecutorRequest,
  identity: BrowserIdentity,
): Extract<BrowserStep, { op: "openTab" }> {
  if (
    request.step.op !== "openTab" ||
    request.step.clientInstanceId !== identity.clientInstanceId ||
    !safePage(request.step.url)
  )
    throw new Error("INVALID_TARGET");
  return request.step;
}
