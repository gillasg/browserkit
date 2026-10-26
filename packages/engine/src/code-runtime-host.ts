import { stepTrace, takeActionTiming } from "./native-browser-action-timing.js";
import {
  BrowserCodeCancelSchema,
  BrowserCodeReplySchema,
  BrowserCodeRunSchema,
  BrowserStepSchema,
  type BrowserCodeRun,
  type BrowserStep,
  type BrowserTargetKey,
} from "@browserkit/protocol";
import { jobs, saveJobs } from "./code-runtime-jobs.js";
import { browserErrorDetail, errorCode, targetIdentity } from "./native-browser-common.js";
import { OFFSCREEN, toOffscreen } from "./code-offscreen-host.js";
import { stepFailure } from "./code-step-errors.js";
import { jobCall, finishJob, cancelJobs } from "./code-runtime-job-control.js";
import { executeLocalBrowserStep } from "./native-browser-executor.js";
import { browserSessionOwner } from "./native-browser-session.js";
import { currentInventoryTabs } from "./native-inventory-client.js";
import { notePreviewActivity } from "./native-browser-preview.js";
import { signInToPage } from "./native-browser-signin.js";
import { sessionHeadersFor } from "./native-browser-session-headers.js";
import {
  captureTypedPassword,
  finishVaultCapture,
  vaultCandidate,
} from "./native-browser-vault.js";
import {
  NO_RULES,
  assertAllowed,
  combinedRules,
  guardTab,
  releaseTabs,
  type SiteRules,
} from "./native-browser-site-rules.js";
import { handOffToUser } from "./native-browser-handoff.js";
import { presentBrowserTask, presentsBrowserTask } from "./native-browser-layout.js";
import { engineConfig } from "./engine-config.js";
import { resetChatTabs, agentTabSummary, reapChatPopups } from "./native-browser-tab-cleanup.js";
import { setOwnerTitle } from "./native-browser-owner.js";
import { disableQuietTab, enableQuietTab } from "./native-browser-quiet.js";
import { saveFlight } from "./native-browser-flight.js";
import { setFlightAllowed } from "./native-browser-flight.js";
import { networkCall } from "./native-browser-network.js";
import { mediaCall, type MediaRequest } from "./native-browser-media.js";
import { isLibraryRequest, libraryCall } from "./native-browser-library.js";
import { windowsCall } from "./native-browser-windows.js";
import { tabGroupsCall } from "./native-browser-groups.js";
import { closeTabCall } from "./code-tab-close.js";
import { rulesCall } from "./native-browser-rules.js";
import { permissionCall } from "./native-browser-permissions.js";
import { googleCall } from "./native-browser-google.js";
import { fetchCall, isFetchRequest } from "./native-browser-fetch.js";
import type { BrowserIdentity } from "./native-worker-identity.js";

const MAX_STEPS = 1000;
const MAX_TRACE = 256;

export interface Cell {
  run: BrowserCodeRun;
  socket: WebSocket;
  identity: BrowserIdentity;
  operationId: string;
  allowed: Map<string, BrowserTargetKey>;
  opened: Map<string, BrowserTargetKey>;
  steps: Record<string, unknown>[];
  count: number;
  calls: Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void }>;
  sequence: number;
  progressTimer: ReturnType<typeof setTimeout> | undefined;
  waitingForUser: boolean;
  done: boolean;
  /** Sites the machine says are off limits for this cell, asked once. */
  siteRules?: Promise<SiteRules>;
  /** Tabs holding a block rule for this cell, lifted when it finishes. */
  guarded: Set<number>;
  /** Popup count when the cell started, so its tab line says what this cell parked. */
  popupsAtStart: number;
  /** When the cell began; its result carries the total ms. */
  startedAt?: number;
}
const cells = new Map<string, Cell>();

/** Handles browser.code.* frames from Core. Returns false for anything else. */
export function handleBrowserCodeMessage(
  identity: BrowserIdentity,
  socket: WebSocket,
  candidate: unknown,
): boolean {
  const run = BrowserCodeRunSchema.safeParse(candidate);
  if (run.success) {
    void startCell(identity, socket, run.data);
    return true;
  }
  const reply = BrowserCodeReplySchema.safeParse(candidate);
  if (reply.success) {
    const owner = cells.get(reply.data.cellId) ?? jobs.get(reply.data.cellId);
    const waiter = owner?.calls.get(reply.data.callId);
    owner?.calls.delete(reply.data.callId);
    if (reply.data.error !== undefined) waiter?.reject(new Error(reply.data.error));
    else waiter?.resolve(reply.data.value);
    return true;
  }
  const cancel = BrowserCodeCancelSchema.safeParse(candidate);
  if (cancel.success) {
    const cell = cells.get(cancel.data.cellId);
    const reset = cancel.data.reset === true;
    if (cell && reset) void resetRealm(cell.run.chatId);
    if (cell)
      finish(cell, {
        output: "",
        error: reset ? "Browser workflow cancelled; runtime reset" : "Browser workflow cancelled",
        reset,
      });
    return true;
  }
  return false;
}

/** Drops a chat's REPL realm (session closed or runtime reset). */
export async function resetRealm(chatId: string): Promise<void> {
  cancelJobs(chatId);
  if (!(await chrome.offscreen.hasDocument())) return;
  const reset = chrome.runtime
    .sendMessage({ target: "aeon-code-offscreen", kind: "reset", chatId })
    .then(
      () => true,
      () => false,
    );
  const answered = await Promise.race([
    reset,
    new Promise((done) => setTimeout(done, 1000, false)),
  ]);
  // A synchronous infinite loop blocks the realm's thread; closing the document is the only kill.
  if (!answered) await chrome.offscreen.closeDocument().catch(() => undefined);
}

async function startCell(identity: BrowserIdentity, socket: WebSocket, run: BrowserCodeRun) {
  setOwnerTitle(run.chatId, run.ownerTitle);
  setFlightAllowed(run.chatId, run.flight !== false);
  const allowed = new Map(run.targets.map((target) => [targetIdentity(target), target]));
  const cell: Cell = {
    run,
    socket,
    identity,
    operationId: crypto.randomUUID(),
    allowed,
    opened: new Map(),
    guarded: new Set(),
    steps: [],
    count: 0,
    calls: new Map(),
    sequence: 0,
    progressTimer: undefined,
    waitingForUser: false,
    done: false,
    popupsAtStart: agentTabSummary(run.chatId).popups,
  };
  cell.startedAt = Date.now();
  cells.set(run.cellId, cell);
  try {
    const result = (await toOffscreen({
      target: "aeon-code-offscreen",
      kind: "cell",
      cellId: run.cellId,
      chatId: run.chatId,
      code: run.code,
      timeoutMs: run.timeoutMs,
      attached: run.targets[0],
    })) as { value?: unknown; output?: string; error?: string; reset?: boolean } | undefined;
    finish(
      cell,
      result ?? {
        output: "",
        error: "Browser runtime did not respond; runtime reset",
        reset: true,
      },
    );
  } catch (error) {
    finish(cell, {
      output: "",
      error: String(error instanceof Error ? error.message : error),
      reset: true,
    });
  }
}

function finish(
  cell: Cell,
  result: { value?: unknown; output?: string; error?: string; reset?: boolean },
): void {
  if (cell.done) return;
  cell.done = true;
  if (cell.progressTimer) clearTimeout(cell.progressTimer);
  if (!result.error) {
    finalize(cell, result, []);
    return;
  }
  // A failed run keeps its last two minutes: encode for the tabs it opened, save through the host,
  // and name the file in the result so a chat can link it.
  void attachFlights(cell)
    .then((flights) => finalize(cell, result, flights))
    .catch(() => finalize(cell, result, []));
}

async function attachFlights(cell: Cell): Promise<Record<string, unknown>[]> {
  if (cell.run.flight === false) return [];
  const tabs = [...new Set([...cell.opened.values()].map((target) => target.tabId))].slice(0, 4);
  const saved: Record<string, unknown>[] = [];
  for (const tabId of tabs) {
    const encoded = await saveFlight(tabId).catch(() => undefined);
    if (!encoded) continue;
    const written = (await callCore(cell, { flight: encoded }).catch(() => undefined)) as
      Record<string, unknown> | undefined;
    if (written) saved.push(written);
  }
  return saved;
}

function finalize(
  cell: Cell,
  result: { value?: unknown; output?: string; error?: string; reset?: boolean },
  flights: Record<string, unknown>[],
): void {
  cells.delete(cell.run.cellId);
  void releaseTabs(cell.guarded);
  for (const waiter of cell.calls.values()) waiter.reject(new Error("Browser cell finished"));
  send(cell.socket, {
    kind: "browser.code.result",
    cellId: cell.run.cellId,
    output: (result.output ?? "").slice(0, 1_000_000),
    ...(result.value !== undefined ? { value: result.value } : {}),
    ...(result.error ? { error: result.error.slice(0, 20000) } : {}),
    ...(result.reset ? { reset: true } : {}),
    ...(flights.length ? { flight: flights } : {}),
    steps: cell.steps.slice(-MAX_TRACE),
    ms: Math.max(0, Date.now() - (cell.startedAt ?? Date.now())),
    opened: [...cell.opened.values()],
    tabStats: (() => {
      const summary = agentTabSummary(cell.run.chatId);
      return { ...summary, popups: Math.max(0, summary.popups - cell.popupsAtStart) };
    })(),
  });
}

// Offscreen relays calls from the sandboxed realm. Only that document may send them.
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (message?.target !== "aeon-code-host") return;
  if (sender.id !== chrome.runtime.id || sender.url !== chrome.runtime.getURL(OFFSCREEN)) return;
  if (message.kind === "jobDone") {
    finishJob(message as Record<string, unknown>);
    reply({ ok: true });
    return true;
  }
  if (message.kind !== "call") return;
  const cell = cells.get(message.cellId) ?? jobs.get(message.cellId);
  if (!cell) {
    reply({ error: "Browser cell is no longer active" });
    return;
  }
  serve(cell, message.request).then(
    (value) => reply({ value }),
    (error: unknown) => reply({ error: describe(error) }),
  );
  return true;
});

// Non-step requests: browser info and hand-off stay local, everything else goes to Core.
function serveCall(cell: Cell, value: Record<string, unknown> | null): Promise<unknown> {
  if (value && typeof value.sessionHeaders === "object" && value.sessionHeaders)
    return Promise.resolve({
      headers: sessionHeadersFor(String((value.sessionHeaders as { url?: unknown }).url ?? "")),
    });
  const signIn = serveSignIn(cell, value);
  if (signIn) return signIn;
  const guarded = guardedCall(cell, value);
  if (guarded) return guarded;
  if (value?.browserInfo === true)
    return Promise.resolve({ clientInstanceIds: [cell.identity.clientInstanceId] });
  if (value && typeof value.job === "object" && value.job)
    return jobCall(cell, value.job as Record<string, unknown>);
  if (value && typeof value.media === "object" && value.media) {
    const media = value.media as { target?: unknown } & Record<string, unknown>;
    const target = authorizedTarget(cell, media.target);
    return mediaCall(target.tabId, media as MediaRequest);
  }
  if (value && typeof value.progress === "object" && jobs.get(cell.run.cellId) === cell) {
    const job = jobs.get(cell.run.cellId);
    const progress = value.progress as { done?: unknown; total?: unknown; label?: unknown };
    if (job)
      job.progress = {
        done: Math.max(0, Number(progress.done) || 0),
        total: Math.max(0, Number(progress.total) || 0),
        ...(typeof progress.label === "string" ? { label: progress.label.slice(0, 200) } : {}),
      };
    void saveJobs();
    return Promise.resolve({ ok: true });
  }
  if (value && typeof value.handoff === "object" && value.handoff)
    return handoff(cell, value.handoff);
  if (value && typeof value.quiet === "object" && value.quiet) return quietCall(cell, value.quiet);
  if (value && value.tabs === "reset") return resetCall(cell);
  if (value && value.session === "close") return resetCall(cell);
  if (value && value.session === "reap")
    return reapChatPopups(cell.run.chatId).then((closed) => ({ closed }));
  if (value && value.tabs === "close") return closeTabCall(cell.run.chatId, value);
  if (value && typeof value.network === "string")
    return networkCall(authorizedTarget(cell, value.target).tabId, value.network, value);
  if (value && typeof value.rules === "string")
    return rulesCall(authorizedTarget(cell, value.target).tabId, value);
  if (value && typeof value.windows === "string") return windowsCall(value);
  if (value && typeof value.tabGroups === "string") return tabGroupsCall(value);
  if (value && value.permission === "set")
    return permissionCall(authorizedTarget(cell, value.target).tabId, value);
  if (value && isLibraryRequest(value)) return libraryCall(value);
  if (value && typeof value.google === "string") return googleCall(value);
  if (value && isFetchRequest(value)) return fetchCall(value);
  return callCore(cell, value);
}

// Passwords and one-time codes travel only between the machine and the engine: agent code may
// ask to sign in, never for the login itself.
function serveSignIn(
  cell: Cell,
  value: Record<string, unknown> | null,
): Promise<unknown> | undefined {
  if (value && "credential" in value)
    return Promise.reject(new Error("FORBIDDEN: use bu.signIn() to sign in"));
  if (!value || typeof value.signIn !== "object" || !value.signIn) return undefined;
  const request = value.signIn as { target?: unknown; account?: unknown };
  const target = authorizedTarget(cell, request.target);
  void notePreviewActivity(cell.run.chatId, target.tabId);
  return guardCellTab(cell, target.tabId).then(() => {
    setWaiting(cell, true);
    return signInToPage(
      target.tabId,
      { account: request.account },
      (ask) => callCore(cell, ask),
      () => !cell.done,
    ).finally(() => setWaiting(cell, false));
  });
}

function siteRulesFor(cell: Cell): Promise<SiteRules> {
  cell.siteRules ??= callCore(cell, { siteRules: true })
    .catch(() => NO_RULES)
    .then(combinedRules);
  return cell.siteRules;
}

async function quietCall(cell: Cell, request: object): Promise<unknown> {
  const value = request as { target?: unknown; enabled?: unknown };
  const target = authorizedTarget(cell, value.target);
  const enabled = value.enabled !== false;
  if (enabled) await enableQuietTab(target.tabId);
  else await disableQuietTab(target.tabId);
  return { quiet: enabled };
}

async function resetCall(cell: Cell): Promise<unknown> {
  cancelJobs(cell.run.chatId);
  await toOffscreen({
    target: "aeon-code-offscreen",
    kind: "stopJobs",
    chatId: cell.run.chatId,
  }).catch(() => undefined);
  return resetChatTabs(cell.run.chatId);
}

async function guardCellTab(cell: Cell, tabId: number): Promise<void> {
  await guardTab(tabId, await siteRulesFor(cell));
  cell.guarded.add(tabId);
}

/** browser.fetch and site API calls name their site up front: refuse blocked ones. */
function guardedCall(
  cell: Cell,
  value: Record<string, unknown> | null,
): Promise<unknown> | undefined {
  if (!value) return undefined;
  const fetch = isFetchRequest(value);
  if (!fetch && typeof value.siteMapper !== "string") return undefined;
  return siteRulesFor(cell).then((rules) => {
    assertAllowed(rules, fetch ? (value.fetch as { url?: unknown }).url : value.site);
    return fetch ? fetchCall(value) : callCore(cell, value);
  });
}

/** A step that goes somewhere, or acts in a tab, stays off blocked sites. */
async function enforceSites(cell: Cell, step: BrowserStep): Promise<void> {
  const rules = await siteRulesFor(cell);
  assertAllowed(rules, (step as { url?: unknown }).url);
  const target = (step as { target?: { tabId?: unknown } }).target;
  if (typeof target?.tabId === "number") await guardCellTab(cell, target.tabId);
}

async function serve(cell: Cell, request: unknown): Promise<unknown> {
  const value = request as Record<string, unknown> | null;
  if (!value || typeof value.op !== "string") return serveCall(cell, value);
  const step = await prepare(cell, value);
  authorize(cell, step);
  await enforceSites(cell, step);
  const entry: Record<string, unknown> = {
    index: cell.steps.length,
    action: step,
    disposition: "running",
    tStart: Date.now(),
  };
  cell.steps.push(entry);
  progress(cell);
  const stepTab = "target" in step ? step.target.tabId : undefined;
  if (stepTab !== undefined) takeActionTiming(stepTab);
  let resultTab: number | undefined;
  if ((step.op === "click" || step.op === "press") && "target" in step)
    await captureTypedPassword(step.target.tabId).catch(() => undefined);
  try {
    const result = await executeLocalBrowserStep(
      cell.identity,
      cell.run.chatId,
      cell.run.toolCallId,
      cell.operationId,
      step,
    );
    if (result.kind === "tab") {
      await guardCellTab(cell, result.tab.target.tabId);
      const key = targetIdentity(result.tab.target);
      cell.allowed.set(key, result.tab.target);
      cell.opened.set(key, result.tab.target);
    }
    if (step.op === "fill" && vaultCandidate(step.target.tabId)?.password === step.value)
      entry.action = { ...step, value: "[hidden password]" };
    Object.assign(entry, { disposition: "completed", result });
    const tabId = (resultTab =
      result.kind === "tab"
        ? result.tab.target.tabId
        : "target" in step
          ? step.target.tabId
          : undefined);
    if (tabId !== undefined) {
      if (step.op === "click" || step.op === "press")
        void finishVaultCapture(
          tabId,
          (request) => callCore(cell, request),
          () => true,
        ).catch(() => undefined);
      void notePreviewActivity(cell.run.chatId, tabId);
      // Only work in a tab (not reads) brings its chat and the tab together in Split View.
      if (presentsBrowserTask(step.op) && !("present" in step && step.present === false))
        void presentBrowserTask(cell.run.chatId, tabId);
    }
    recordScreenshot(cell, step, result);
    return result;
  } catch (error) {
    Object.assign(entry, { disposition: "failed", code: describe(error) });
    throw await stepFailure(step, error);
  } finally {
    entry.tEnd = Date.now();
    entry.ms = Math.max(0, Number(entry.tEnd) - Number(entry.tStart ?? entry.tEnd));
    const tabId = resultTab ?? stepTab;
    if (tabId !== undefined)
      Object.assign(entry, await stepTrace(tabId, INPUT_OPS.has(step.op)).catch(() => ({})));
    progress(cell);
  }
}
// Steps whose trace entries carry input timing, pixel ratio included.
const INPUT_OPS = new Set([
  "click",
  "fill",
  "press",
  "scroll",
  "navigate",
  "openTab",
  "pointer",
  "keys",
]);

async function handoff(cell: Cell, request: object): Promise<"done" | "cancelled"> {
  const { message } = request as { message?: unknown };
  const target = authorizedTarget(cell, (request as { target?: unknown }).target);
  void notePreviewActivity(cell.run.chatId, target.tabId);
  // The user needs to see the tab: pair it beside its Chat in Split View, whatever the view setting.
  void presentBrowserTask(cell.run.chatId, target.tabId, true);
  const text = String(message ?? "").slice(0, 500) || "Please take over, then click Done.";
  const entry: Record<string, unknown> = {
    index: cell.steps.length,
    action: { op: "handoff", message: text, target },
    disposition: "running",
  };
  cell.steps.push(entry);
  setWaiting(cell, true);
  try {
    const outcome = await handOffToUser(target.tabId, text, () => !cell.done);
    Object.assign(entry, { disposition: outcome === "done" ? "completed" : "failed" });
    return outcome;
  } catch (error) {
    Object.assign(entry, { disposition: "failed", code: describe(error) });
    throw error;
  } finally {
    setWaiting(cell, false);
  }
}

/** A target from a local request, held to the same ownership rules as browser steps. */
function authorizedTarget(cell: Cell, target: unknown): BrowserTargetKey {
  const parsed = BrowserStepSchema.safeParse({ op: "observe", kind: "semantic", target });
  if (!parsed.success || parsed.data.op !== "observe") throw new Error("INVALID_TARGET");
  authorize(cell, parsed.data);
  return parsed.data.target;
}

// Sent at once rather than throttled: Core pauses or restarts the cell deadline on it.
function setWaiting(cell: Cell, waiting: boolean): void {
  cell.waitingForUser = waiting;
  if (cell.done) return;
  send(cell.socket, {
    kind: "browser.code.progress",
    cellId: cell.run.cellId,
    steps: progressSteps(cell),
    waitingForUser: waiting,
  });
}

async function prepare(cell: Cell, value: Record<string, unknown>): Promise<BrowserStep> {
  if (++cell.count > MAX_STEPS)
    throw new Error(`Browser workflow reached its ${MAX_STEPS}-operation limit`);
  if (value.op === "openTab" && !value.clientInstanceId)
    value.clientInstanceId = cell.identity.clientInstanceId;
  if (value.op === "openTab" && value.space === undefined)
    value.space =
      value.quiet === true
        ? "window"
        : (cell.run.space ?? engineConfig.defaultSpace(cell.run.chatId));
  if (value.op === "upload" && Array.isArray(value.files))
    value.files = await callCore(cell, { validateUpload: value.files });
  const parsed = BrowserStepSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  const issues = parsed.error.issues.map((issue) => issue.message).join("; ");
  throw new Error("INVALID_TARGET: " + issues.slice(0, 400));
}

function authorize(cell: Cell, step: BrowserStep): void {
  if (step.op === "listTabs" || step.op === "openTab") return;
  const target = step.target;
  if (target.clientInstanceId !== cell.identity.clientInstanceId) throw new Error("TARGET_LOST");
  const key = targetIdentity(target);
  if (step.op === "attachTab") {
    // Attaching a listed tab is an explicit agent choice; Core records it after the cell.
    if (!currentInventoryTabs().some((tab) => targetIdentity(tab.target) === key))
      throw new Error("TARGET_LOST");
    const owner = browserSessionOwner(target.tabId);
    if (owner !== undefined && owner !== cell.run.chatId)
      throw new Error(
        "TAB_OWNED_ELSEWHERE: tab " +
          target.tabId +
          " is driven by another session; browser.tabs({all:true}) shows it, open your own copy with browser.openTab(url, {newTab:true})",
      );
    cell.allowed.set(key, target);
    cell.opened.set(key, target);
    return;
  }
  if (cell.allowed.has(key) || browserSessionOwner(target.tabId) === cell.run.chatId) return;
  throw new Error("TARGET_LOST: attach the exact browser target first (browser.attachTab)");
}

function recordScreenshot(cell: Cell, step: BrowserStep, result: unknown): void {
  if (step.op !== "cdp" || step.method !== "Page.captureScreenshot") return;
  const data = (result as { data?: { value?: { data?: unknown } } }).data?.value?.data;
  if (typeof data !== "string") return;
  const format = (step.params as { format?: string } | undefined)?.format;
  cell.steps.push({
    result: {
      kind: "screenshot",
      screenshotId: crypto.randomUUID(),
      dataBase64: data,
      mimeType: format === "jpeg" ? "image/jpeg" : format === "webp" ? "image/webp" : "image/png",
    },
  });
}

function callCore(cell: Cell, request: unknown): Promise<unknown> {
  const callId = String(++cell.sequence);
  return new Promise((resolve, reject) => {
    cell.calls.set(callId, { resolve, reject });
    if (
      !send(cell.socket, { kind: "browser.code.call", cellId: cell.run.cellId, callId, request })
    ) {
      cell.calls.delete(callId);
      reject(
        new Error(
          cell.socket.readyState === WebSocket.OPEN
            ? "TOO_LARGE: this call carries over 3.5 MB; split the data into smaller pieces"
            : "BROWSER_OFFLINE",
        ),
      );
    }
  });
}

function progress(cell: Cell): void {
  if (cell.progressTimer) return;
  cell.progressTimer = setTimeout(() => {
    cell.progressTimer = undefined;
    if (cell.done) return;
    send(cell.socket, {
      kind: "browser.code.progress",
      cellId: cell.run.cellId,
      steps: progressSteps(cell),
    });
  }, 150);
}

// Progress is for the live activity view; images and full observations wait for the result.
function progressSteps(cell: Cell): Record<string, unknown>[] {
  return cell.steps.slice(-MAX_TRACE).map(({ result, ...rest }) => ({
    ...rest,
    ...(result ? { result: { kind: (result as { kind?: unknown }).kind } } : {}),
  }));
}

// The receiving socket closes on frames over 4 MB, which would end every running cell. Larger
// messages are refused here instead: a call fails on its own, a result drops its value.
const MAX_MESSAGE_CHARS = 3_500_000;
function send(socket: WebSocket, message: unknown): boolean {
  if (socket.readyState !== WebSocket.OPEN) return false;
  let text = JSON.stringify(message);
  const limit = Array.isArray((message as { flight?: unknown }).flight)
    ? 80_000_000
    : MAX_MESSAGE_CHARS;
  if (text.length > limit) {
    const result = message as { kind?: string; value?: unknown; steps?: unknown[] };
    if (result.kind !== "browser.code.result") return false;
    const size = (text.length / 1_000_000).toFixed(1);
    text = JSON.stringify({
      ...result,
      value: undefined,
      steps: [],
      output: "",
      error: `RESULT_TOO_LARGE: the result was ${size} MB. Return less, or write it with artifact(name, data) and return a summary.`,
    });
  }
  socket.send(text);
  return true;
}

function describe(error: unknown): string {
  const code = errorCode(error);
  const detail = browserErrorDetail(error);
  const message = error instanceof Error ? error.message : String(error);
  if (code === "OPERATION_FAILED" && message && message !== code) return message;
  return detail ? `${code}: ${detail}` : code;
}
