import { noteActionTiming } from "./native-browser-action-timing.js";
import { engineConfig } from "./engine-config.js";
import {
  type BrowserExecutorRequest,
  type BrowserExecutorResult,
  type BrowserStep,
  BrowserExecutorRequestSchema,
  BrowserExecutorResultSchema,
  BrowserOperationResultSchema,
  type BrowserTargetKey,
} from "@browserkit/protocol";
import {
  withBrowserDebugger,
  reconnectBrowserSession,
  assertRequestActive,
  bindBrowserSession,
  handleBrowserRelease,
  registerBrowserRequest,
  completeBrowserRequest,
} from "./native-browser-session.js";
import {
  discoverFrames,
  frameDebuggee,
  evaluateFrame,
  uploadFiles,
} from "./native-browser-frames.js";
import {
  enableConsoleCapture,
  executeBrowserEvent,
  readDiagnostics,
} from "./native-browser-events.js";
import { executeDownload } from "./native-browser-downloads.js";
import { claimAgentTab, groupAgentTab } from "./native-browser-groups.js";
import {
  ensureAgentTabsRestored,
  markAgentTabGrouped,
  mineTabIds,
  trackAgentTab,
} from "./native-browser-tab-cleanup.js";
import { currentFocusedWindowId } from "./native-inventory-client.js";
import { ownerTitle } from "./native-browser-owner.js";
import { enableQuietTab } from "./native-browser-quiet.js";
import { showAgentCaption } from "./native-browser-cursor.js";

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www./, "");
  } catch {
    return "page";
  }
}
import {
  executeInteraction,
  interactFrame,
  focusNode,
  pressKey,
  prepareElement,
  performAction,
} from "./native-browser-input.js";
import { refreshInventoryTab, currentInventoryTabs } from "./native-inventory-client.js";
import {
  createSemanticNodes,
  captureScreenshot,
  observeSemantic,
} from "./native-browser-observation.js";
import {
  type AxNode,
  sameTarget,
  BrowserActionError,
  safePage,
  browserErrorDetail,
  errorCode,
  sameIdentity,
  targetIdentity,
} from "./native-browser-common.js";
import { selectorState, isFocusedInput } from "./native-browser-dom.js";
import {
  navigateReady,
  executePageCode,
  primeBrowserSettle,
  settleBrowserPage,
} from "./native-browser-navigation.js";
import { executeSiteScript, handleScriptSync } from "./site-script-runtime.js";
import { browserPopups } from "./native-browser-popup.js";
import { captureFromTabStart } from "./native-browser-network.js";
import { executeCookies, type CookieStep } from "./native-browser-cookies.js";
import {
  classifyReadiness,
  readinessSnapshotExpression,
  type ReadinessSnapshot,
} from "./readiness.js";
import {
  bodyGlobal,
  clearGlobal,
  curlGlobal,
  getGlobal,
  harGlobal,
  originsGlobal,
  queryGlobal,
  statsGlobal,
  type StoreFilter,
} from "./network-store.js";
import { scheduleStep, schedulerStatus } from "./native-browser-scheduler.js";
import type { BrowserIdentity } from "./native-worker-identity.js";

type Capability = Extract<
  BrowserStep,
  { op: "event" | "frames" | "upload" | "downloads" | "pointer" | "keys" | "reconnect" }
>;
export function isCapabilityStep(step: BrowserStep): step is Capability {
  return ["event", "frames", "upload", "downloads", "pointer", "keys", "reconnect"].includes(
    step.op,
  );
}
type Request = BrowserExecutorRequest & { step: Capability };
export async function performCapability(
  request: Request,
  revalidate: (request: BrowserExecutorRequest, tabId: number) => Promise<void>,
): Promise<BrowserExecutorResult> {
  const step = request.step,
    tabId = step.target.tabId;
  await revalidate(request, tabId);
  if (step.op === "reconnect") await reconnectBrowserSession(tabId);
  const data = await withBrowserDebugger(tabId, async (root) => {
    await revalidate(request, tabId);
    const debuggee =
      "frameId" in step ? await frameDebuggee(root, step.frameId, step.frameKey) : root;
    if (step.op === "event") return executeBrowserEvent({ ...request, step }, debuggee);
    if (step.op === "frames") return executeFrame(root, debuggee, step);
    if (step.op === "upload") return uploadFiles(debuggee, { ...request, step });
    if (step.op === "downloads") return executeDownload({ ...request, step });
    if (step.op === "pointer" || step.op === "keys") return executeInteraction(debuggee, step);
    return { reconnected: true, handlesMustBeRefreshed: true };
  });
  if (JSON.stringify(data).length > 1_000_000)
    throw new Error("Browser result exceeds 1 MB; select fewer fields or split the request");
  assertRequestActive(request);
  const tab = await refreshInventoryTab(tabId);
  if (!tab || !sameTarget(tab.target, step.target)) throw new Error("TARGET_LOST");
  return {
    kind: "page",
    source: "website",
    trust: "untrusted",
    target: tab.target,
    documentEpoch: tab.documentEpoch,
    url: tab.url,
    data,
  };
}
async function executeFrame(
  root: chrome.debugger.Debuggee,
  debuggee: chrome.debugger.Debuggee,
  step: Extract<BrowserStep, { op: "frames" }>,
): Promise<unknown> {
  if (step.action === "list") return discoverFrames(root);
  if (!step.frameId)
    throw new Error(
      "INVALID_TARGET: pass both frameId and frameKey from page.frames(); a frameKey alone is not a frame target",
    );
  if (step.action === "evaluate")
    return evaluateFrame(debuggee, step.frameId, step.expression ?? "");
  if (step.action === "click" || step.action === "fill") {
    const element = step.selector ?? step.backendNodeId;
    if (element === undefined) throw new Error("INVALID_TARGET");
    return interactFrame(debuggee, step.frameId, element, frameValue(step));
  }
  if (step.action === "snapshot") return frameSnapshot(debuggee, step.frameId);
  if (!step.method || /^(Browser|Target)\./.test(step.method)) throw new Error("UNSUPPORTED");
  return chrome.debugger.sendCommand(debuggee, step.method, step.params);
}
async function frameSnapshot(
  debuggee: chrome.debugger.Debuggee,
  frameId: string,
): Promise<unknown> {
  const tree = (await chrome.debugger.sendCommand(debuggee, "Accessibility.getFullAXTree", {
    frameId,
  })) as { nodes: AxNode[] };
  return createSemanticNodes(tree.nodes);
}

function frameValue(step: Extract<BrowserStep, { op: "frames" }>): string | undefined {
  return step.action === "fill" ? (step.value ?? "") : undefined;
}

type ExtraRequest = BrowserExecutorRequest & {
  step: Extract<
    BrowserExecutorRequest["step"],
    {
      op:
        | "press"
        | "read"
        | "wait"
        | "navigate"
        | "diagnostics"
        | "siteScript"
        | "popups"
        | "evaluate"
        | "cdp"
        | "readiness"
        | "settle"
        | "cookies"
        | "networkStore"
        | "scheduler"
        | "waitFor";
    }
  >;
};
export async function performExtra(
  request: ExtraRequest,
  revalidate: (request: BrowserExecutorRequest, tabId: number) => Promise<void>,
): Promise<BrowserExecutorResult> {
  const tabId = request.step.target.tabId;
  const step = request.step;
  let data: unknown;
  if (step.op === "cookies") {
    // Host-wide, and never requires a debugger: no page is touched.
    await revalidate(request, tabId);
    data = await executeCookies(step as CookieStep);
  } else if (step.op === "networkStore") {
    await revalidate(request, tabId);
    data = networkStoreAction(step);
  } else if (step.op === "scheduler") {
    await revalidate(request, tabId);
    data = schedulerStatus();
  } else if (step.op === "siteScript") {
    await revalidate(request, tabId);
    data = await executeSiteScript(step.action, tabId, step.definition, step.scriptId, () =>
      revalidate(request, tabId),
    );
  } else
    data = await withBrowserDebugger(tabId, async (debuggee) => {
      await revalidate(request, tabId);
      if (step.op === "settle") {
        const settle = await settleBrowserPage(debuggee, step.timeoutMs, Date.now(), step.quietMs);
        return {
          settled: settle.why === "quiet",
          why: settle.why,
          waitedMs: settle.ms,
          pending: settle.pending,
        };
      }
      if (step.op === "readiness")
        return classifyReadiness(
          ((await evaluate(debuggee, readinessSnapshotExpression)) ?? {}) as ReadinessSnapshot,
        );
      if (step.op === "evaluate" || step.op === "cdp" || step.op === "waitFor")
        return executePageCode(debuggee, { ...request, step }, () => revalidate(request, tabId));
      if (step.op === "press")
        return pressElement(debuggee, request, () => revalidate(request, tabId));
      if (step.op === "navigate") {
        // Recorded from the first request, so page.network.list() has the new page's calls.
        await captureFromTabStart(tabId);
        return navigateReady(tabId, step.url);
      }
      if (step.op === "diagnostics") {
        await enableConsoleCapture(tabId);
        return readDiagnostics(tabId, step.clear);
      }
      if (step.op === "popups") return { tabs: await browserPopups(tabId) };
      return readOrWait(debuggee, request, () => revalidate(request, tabId));
    });
  const tab = await refreshInventoryTab(tabId);
  assertRequestActive(request);
  if (!tab || !sameTarget(tab.target, request.step.target) || !safePage(tab.url))
    throw new Error("TARGET_LOST");
  const encoded = JSON.stringify(data);
  if (encoded && encoded.length > 1_000_000)
    throw new BrowserActionError(
      "UNSUPPORTED",
      "Result exceeds 1 MB; extract in smaller batches and save artifacts.",
    );
  return {
    kind: "page",
    source: "website",
    trust: "untrusted",
    target: tab.target,
    documentEpoch: tab.documentEpoch,
    url: tab.url,
    data,
  };
}
type NetworkStoreStep = Extract<BrowserStep, { op: "networkStore" }>;

/** Only the fields the store filters on, so undefined options never reach it. */
function storeFilterOf(step: NetworkStoreStep): StoreFilter {
  return {
    ...(step.match ? { match: step.match } : {}),
    ...(step.origin ? { origin: step.origin } : {}),
    ...(step.method ? { method: step.method } : {}),
    ...(step.type ? { type: step.type } : {}),
    ...(step.status === undefined ? {} : { status: step.status }),
    ...(step.static ? { static: step.static } : {}),
    ...(step.since === undefined ? {} : { since: step.since }),
    ...(step.until === undefined ? {} : { until: step.until }),
    ...(step.limit === undefined ? {} : { limit: step.limit }),
  };
}

function networkStoreAction(step: NetworkStoreStep): unknown {
  const filter = storeFilterOf(step);
  switch (step.action) {
    case "list": {
      const entries = queryGlobal(filter);
      return { entries, count: entries.length };
    }
    case "get":
      return step.id
        ? (getGlobal(step.id) ?? { id: step.id, found: false })
        : { error: "get needs an id" };
    case "body":
      return step.id ? bodyGlobal(step.id) : { error: "body needs an id" };
    case "curl":
      return step.id
        ? { curl: curlGlobal(step.id, step.secrets === true) }
        : { error: "curl needs an id" };
    case "origins":
      return { origins: originsGlobal() };
    case "stats":
      return statsGlobal();
    case "clear":
      return clearGlobal();
    case "har":
      return harGlobal(filter);
  }
}

async function readOrWait(
  debuggee: chrome.debugger.Debuggee,
  request: ExtraRequest,
  revalidate: () => Promise<void>,
): Promise<unknown> {
  const step = request.step;
  if (step.op === "read")
    return evaluate(
      debuggee,
      `(${extract.toString()})(${JSON.stringify(step.selector)},${step.limit},${step.textLimit},${JSON.stringify(step.attributes)})`,
    );
  if (step.op !== "wait") throw new Error("UNSUPPORTED");
  const deadline = Date.now() + step.timeoutMs;
  while (Date.now() < deadline) {
    await revalidate();
    const found = await evaluate(
      debuggee,
      `(${selectorState.toString()})(${JSON.stringify(step.selector)},${JSON.stringify(step.state)})`,
    );
    if (found) return { found: true };
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new BrowserActionError(
    "TIMEOUT",
    `Selector ${JSON.stringify(step.selector)} did not become ${step.state} within ${step.timeoutMs}ms. Inspect the page or use another selector.`,
  );
}
function extract(
  selector: string,
  limit: number,
  textLimit: number,
  attributes: string[],
): unknown {
  const elements = document.querySelectorAll(selector);
  return {
    count: elements.length,
    truncated: elements.length > limit,
    items: [...elements].slice(0, limit).map((element) => ({
      text: ((element as HTMLElement).innerText ?? element.textContent ?? "")
        .trim()
        .slice(0, textLimit),
      attributes: Object.fromEntries(
        attributes.map((attribute) => [
          attribute,
          element.getAttribute(attribute)?.slice(0, textLimit) ?? null,
        ]),
      ),
    })),
  };
}
async function evaluate(debuggee: chrome.debugger.Debuggee, expression: string): Promise<unknown> {
  const result = (await chrome.debugger.sendCommand(debuggee, "Runtime.evaluate", {
    expression,
    returnByValue: true,
  })) as {
    result?: { value?: unknown };
    exceptionDetails?: unknown;
  };
  if (result.exceptionDetails) throw new Error("INVALID_TARGET");
  return result.result?.value;
}

async function pressElement(
  debuggee: chrome.debugger.Debuggee,
  request: ExtraRequest,
  revalidate: () => Promise<void>,
) {
  if (request.step.op !== "press") throw new Error("INVALID_TARGET");
  noteActionTiming(debuggee.tabId, { tAct: Date.now() });
  if (request.step.focus === false) {
    const element = request.step.element;
    if (element.kind === "backend" && element.documentEpoch !== request.expectedDocumentEpoch)
      throw new Error("STALE_REF");
    if (!(await isFocusedInput(debuggee))) throw new Error("NOT_EDITABLE");
  } else {
    const { node } = await prepareElement(debuggee, request, request.step.element, revalidate);
    await focusNode(debuggee, node.backendNodeId);
  }
  await primeBrowserSettle(debuggee);
  await revalidate();
  await pressKey(debuggee, request.step.key);
  return { pressed: request.step.key, settle: await settleBrowserPage(debuggee) };
}

export { releaseBrowserExecutor } from "./native-browser-session.js";

const claimGenerations = new Map<string, number>();
const usedClaims = new Set<string>();
const targetChains = new Map<string, Promise<BrowserExecutorResult>>();

export function handleBrowserExecutorMessage(
  identity: BrowserIdentity,
  socket: WebSocket,
  candidate: unknown,
): boolean {
  if (handleScriptSync(candidate) || handleBrowserRelease(candidate)) return true;
  const request = BrowserExecutorRequestSchema.safeParse(candidate);
  if (!request.success) return false;
  registerBrowserRequest(request.data);
  if (isEventDrain(request.data.step)) {
    void drainEvents(request.data).then(
      (result) => sendResult(socket, request.data, result),
      (error: unknown) =>
        sendFailure(socket, request.data, errorCode(error), browserErrorDetail(error)),
    );
    return true;
  }
  if (needsClaim(request.data.step) && !claimIsFresh(request.data))
    return respondFailure(socket, request.data, "CLAIM_CONFLICT");
  const work = isTargetStep(request.data.step)
    ? enqueueTarget(request.data.step.target, () => executeStep(identity, request.data))
    : executeStep(identity, request.data);
  void work.then(
    (result) => sendResult(socket, request.data, result),
    (error: unknown) =>
      sendFailure(socket, request.data, errorCode(error), browserErrorDetail(error)),
  );
  return true;
}

// Polling or disposing an event subscription only reads its buffer (checked against the chat that
// made it), so it skips the tab's queue and claim: a long poll never blocks or cancels actions.
function isEventDrain(step: BrowserStep): boolean {
  return step.op === "event" && step.action !== "subscribe";
}
async function drainEvents(request: BrowserExecutorRequest): Promise<BrowserExecutorResult> {
  const step = request.step as Extract<BrowserStep, { op: "event" }>;
  const data = await executeBrowserEvent({ ...request, step }, { tabId: step.target.tabId });
  const tab = await refreshInventoryTab(step.target.tabId);
  if (!tab) throw new Error("TARGET_LOST");
  return {
    kind: "page",
    source: "website",
    trust: "untrusted",
    target: tab.target,
    documentEpoch: tab.documentEpoch,
    url: tab.url,
    data,
  };
}

function needsClaim(step: BrowserStep): boolean {
  return step.op !== "listTabs" && step.op !== "openTab";
}

function claimIsFresh(request: BrowserExecutorRequest): boolean {
  if (
    !request.claimId ||
    !request.claimGeneration ||
    request.step.op === "listTabs" ||
    request.step.op === "openTab" ||
    request.step.op === "attachTab"
  )
    return false;
  const key = targetIdentity(request.step.target);
  const previous = claimGenerations.get(key) ?? 0;
  if (request.claimGeneration <= previous || usedClaims.has(request.claimId)) return false;
  usedClaims.add(request.claimId);
  if (usedClaims.size > 2048) usedClaims.delete(usedClaims.values().next().value as string);
  return true;
}

async function executeStep(
  identity: BrowserIdentity,
  request: BrowserExecutorRequest,
): Promise<BrowserExecutorResult> {
  const step = request.step;
  assertRequestActive(request);
  if (step.op === "listTabs") return listTabs(request);
  if (step.op === "openTab") return openTab(identity, request);
  if (step.op === "attachTab") return attachTab(step.target);
  activateClaim(request);
  const tab = await assertTarget(request);
  bindBrowserSession(step.target.tabId, request.chatId);
  // One step per tab at a time, and writes one at a time browser-wide: two sessions cannot type
  // into each other's page, and a session's own steps keep their order.
  return scheduleStep(step, step.target.tabId, () => dispatchStep(request, step, tab));
}

async function dispatchStep(
  request: BrowserExecutorRequest,
  step: BrowserStep,
  tab: chrome.tabs.Tab,
): Promise<BrowserExecutorResult> {
  if (isCapabilityStep(step)) return performCapability({ ...request, step }, revalidateTarget);
  if (step.op === "observe" || step.op === "navigate")
    showAgentCaption(
      { tabId: step.target.tabId },
      step.op === "navigate" ? "Opening " + hostOf(step.url) : "Reading the page",
    );
  if (step.op === "observe")
    return step.kind === "semantic"
      ? observeSemantic(request, tab, revalidateTarget)
      : captureScreenshot(request, tab, revalidateTarget);
  if (step.op === "click" || step.op === "fill" || step.op === "scroll")
    return performAction({ ...request, step }, revalidateTarget);
  if (isExtraStep(step)) return performExtra({ ...request, step }, revalidateTarget);
  throw new Error("UNSUPPORTED");
}

async function listTabs(request: BrowserExecutorRequest): Promise<BrowserExecutorResult> {
  const query = request.step.op === "listTabs" ? request.step.query : undefined;
  await ensureAgentTabsRestored();
  const tabs = currentInventoryTabs().filter((tab) => safePage(tab.url));
  const filtered = query
    ? tabs.filter((tab) => `${tab.title} ${tab.url}`.toLowerCase().includes(query.toLowerCase()))
    : tabs;
  const mine = new Set(mineTabIds(request.chatId));
  return BrowserExecutorResultSchema.parse({
    kind: "tabs",
    tabs: filtered.slice(0, 256).map((tab) => ({ ...tab, mine: mine.has(tab.target.tabId) })),
    focusedWindowId: currentFocusedWindowId(),
  });
}

// A tab the user already has open, picked from browser.tabs(): the runtime host checked the
// target is listed; it is borrowed, not owned, so it is not grouped or bound to the session.
function attachTab(target: BrowserTargetKey): BrowserExecutorResult {
  const tab = currentInventoryTabs().find((known) => sameTarget(known.target, target));
  if (!tab || !safePage(tab.url)) throw new Error("TARGET_LOST");
  return BrowserExecutorResultSchema.parse({ kind: "tab", tab });
}

async function openTab(
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
  const navigation = await navigateOpenedTab(created.id, step.url);
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
async function navigateOpenedTab(tabId: number, url: string): Promise<string | undefined> {
  try {
    await withBrowserDebugger(tabId, async () => {
      await captureFromTabStart(tabId);
      await navigateReady(tabId, url);
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

async function assertTarget(request: BrowserExecutorRequest): Promise<chrome.tabs.Tab> {
  if (!isTargetStep(request.step)) throw new Error("INVALID_TARGET");
  const target = request.step.target;
  const known = currentInventoryTabs().find((tab) => sameTarget(tab.target, target));
  if (!inventoryMatchesRequest(known, request)) throw new Error("TARGET_LOST");
  const live = await chrome.tabs.get(target.tabId).catch(() => undefined);
  if (!live?.url || !safePage(live.url)) throw new Error("TARGET_LOST");
  const refreshed = await refreshInventoryTab(target.tabId);
  if (!inventoryMatchesRequest(refreshed, request)) throw new Error("TARGET_LOST");
  return live;
}

function inventoryMatchesRequest(
  tab: ReturnType<typeof currentInventoryTabs>[number] | undefined,
  request: BrowserExecutorRequest,
): boolean {
  return Boolean(
    tab &&
    isTargetStep(request.step) &&
    sameTarget(tab.target, request.step.target) &&
    (request.step.op === "event" ||
      request.step.op === "downloads" ||
      tab.documentEpoch === request.expectedDocumentEpoch) &&
    safePage(tab.url),
  );
}

async function isLivePage(tabId: number): Promise<boolean> {
  const tab = await chrome.tabs.get(tabId).catch(() => undefined);
  return Boolean(tab?.url && safePage(tab.url));
}

async function revalidateTarget(request: BrowserExecutorRequest, tabId: number): Promise<void> {
  assertClaimActive(request);
  if (!isTargetStep(request.step) || request.step.target.tabId !== tabId)
    throw new Error("INVALID_TARGET");
  const current = await refreshInventoryTab(tabId);
  if (!inventoryMatchesRequest(current, request)) throw new Error("TARGET_LOST");
  if (!(await isLivePage(tabId))) throw new Error("TARGET_LOST");
}

function activateClaim(request: BrowserExecutorRequest): void {
  if (!isTargetStep(request.step) || !request.claimGeneration || !request.claimId)
    throw new Error("CLAIM_CONFLICT");
  const key = targetIdentity(request.step.target);
  if (request.claimGeneration <= (claimGenerations.get(key) ?? 0))
    throw new Error("CLAIM_CONFLICT");
  claimGenerations.set(key, request.claimGeneration);
}

function assertClaimActive(request: BrowserExecutorRequest): void {
  assertRequestActive(request);
  if (!isTargetStep(request.step) || !request.claimGeneration) throw new Error("CLAIM_CONFLICT");
  if (claimGenerations.get(targetIdentity(request.step.target)) !== request.claimGeneration)
    throw new Error("CLAIM_CONFLICT");
}

function enqueueTarget(
  target: BrowserTargetKey,
  action: () => Promise<BrowserExecutorResult>,
): Promise<BrowserExecutorResult> {
  const key = targetIdentity(target);
  const previous = targetChains.get(key) ?? Promise.resolve(undefined);
  const current = previous.catch(() => undefined).then(action);
  targetChains.set(key, current);
  const cleanup = () => {
    if (targetChains.get(key) === current) targetChains.delete(key);
  };
  void current.then(cleanup, cleanup);
  return current;
}

type TargetStep = Exclude<BrowserStep, { op: "listTabs" | "openTab" | "attachTab" }>;
function isTargetStep(step: BrowserStep): step is TargetStep {
  return !["listTabs", "openTab", "attachTab"].includes(step.op);
}
function isExtraStep(step: BrowserStep): step is Extract<
  BrowserStep,
  {
    op:
      | "press"
      | "read"
      | "wait"
      | "navigate"
      | "diagnostics"
      | "siteScript"
      | "popups"
      | "evaluate"
      | "cdp"
      | "readiness"
      | "settle"
      | "cookies"
      | "networkStore"
      | "scheduler"
      | "waitFor";
  }
> {
  return [
    "press",
    "read",
    "wait",
    "navigate",
    "diagnostics",
    "siteScript",
    "popups",
    "evaluate",
    "cdp",
    "readiness",
    "settle",
    "cookies",
    "networkStore",
    "scheduler",
    "waitFor",
  ].includes(step.op);
}

function sendResult(
  socket: WebSocket,
  request: BrowserExecutorRequest,
  result: BrowserExecutorResult,
): void {
  completeBrowserRequest(request);
  if (socket.readyState !== WebSocket.OPEN) return;
  socket.send(
    JSON.stringify(
      BrowserOperationResultSchema.parse({
        kind: "browser.operation.result",
        requestId: request.requestId,
        operationId: request.operationId,
        ok: true,
        result,
      }),
    ),
  );
}

function sendFailure(
  socket: WebSocket,
  request: BrowserExecutorRequest,
  code: string,
  detail?: string,
): void {
  completeBrowserRequest(request);
  if (socket.readyState !== WebSocket.OPEN) return;
  const safe = [
    "TARGET_LOST",
    "AMBIGUOUS_TARGET",
    "TARGET_NOT_FOUND",
    "TARGET_HIDDEN",
    "TARGET_DISABLED",
    "TARGET_BLOCKED",
    "NOT_EDITABLE",
    "INPUT_FAILED",
    "STALE_REF",
    "CLAIM_CONFLICT",
    "UNSUPPORTED",
    "INVALID_TARGET",
    "TIMEOUT",
    "BROWSER_OFFLINE",
    "DAEMON_OFFLINE",
    "OPERATION_FAILED",
  ].includes(code)
    ? code
    : "OPERATION_FAILED";
  socket.send(
    JSON.stringify(
      BrowserOperationResultSchema.parse({
        kind: "browser.operation.result",
        requestId: request.requestId,
        operationId: request.operationId,
        ok: false,
        code: safe,
        ...(detail ? { detail } : {}),
      }),
    ),
  );
}

function respondFailure(socket: WebSocket, request: BrowserExecutorRequest, code: string): true {
  sendFailure(socket, request, code);
  return true;
}

/** Runs one browser_code step inside the extension: same queueing, claims and target checks, no socket. */
export async function executeLocalBrowserStep(
  identity: BrowserIdentity,
  chatId: string,
  toolCallId: string,
  operationId: string,
  step: BrowserStep,
): Promise<BrowserExecutorResult> {
  const target = isTargetStep(step) ? step.target : undefined;
  const known = target && currentInventoryTabs().find((tab) => sameTarget(tab.target, target));
  if (target && !known) throw new Error("TARGET_LOST");
  const key = target && targetIdentity(target);
  const claimGeneration = key
    ? Math.max((claimGenerations.get(key) ?? 0) + 1, Date.now() * 1000)
    : undefined;
  const request = BrowserExecutorRequestSchema.parse({
    kind: "browser.operation",
    requestId: crypto.randomUUID(),
    operationId,
    toolCallId,
    chatId,
    step,
    ...(known
      ? {
          claimId: crypto.randomUUID(),
          claimGeneration,
          expectedDocumentEpoch: known.documentEpoch,
        }
      : {}),
  });
  registerBrowserRequest(request);
  try {
    if (isEventDrain(step)) return await drainEvents(request);
    return target
      ? await enqueueTarget(target, () => executeStep(identity, request))
      : await executeStep(identity, request);
  } finally {
    completeBrowserRequest(request);
  }
}
