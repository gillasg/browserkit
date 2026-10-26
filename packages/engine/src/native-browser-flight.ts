import { onEngineInstall } from "./native-engine-install.js";
import { toOffscreen } from "./code-offscreen-host.js";

// A low-frame-rate screencast of an agent tab into a 120 s ring buffer. Frames live in the
// offscreen document, which outlives the worker; saving encodes them to WebM there. Recording
// starts with agent work and stops on detach or when the user takes the tab.

interface Active {
  chatId: string;
  startedAt: number;
  lastFrameAt: number;
}
const active = new Map<number, Active>();
const allowed = new Map<string, boolean>();
const manual = new Set<number>();
const viewers = new Map<number, Set<(data: string, at: number) => void>>();
const latestFrame = new Map<number, { data: string; at: number }>();
const FRAME_MS = 500;

export function setFlightAllowed(chatId: string, allowedNow: boolean): void {
  allowed.set(chatId, allowedNow);
}

export async function startFlight(tabId: number, chatId: string): Promise<void> {
  if (allowed.get(chatId) === false || active.has(tabId)) return;
  active.set(tabId, { chatId, startedAt: Date.now(), lastFrameAt: 0 });
  if (manual.has(tabId)) return;
  await chrome.debugger
    .sendCommand({ tabId }, "Page.startScreencast", {
      format: "jpeg",
      quality: 60,
      maxWidth: 1280,
      maxHeight: 800,
      everyNthFrame: 1,
    })
    .catch(() => active.delete(tabId));
}

export async function stopFlight(tabId: number): Promise<void> {
  manual.delete(tabId);
  if (!active.delete(tabId)) return;
  if (manual.has(tabId)) return;
  await chrome.debugger.sendCommand({ tabId }, "Page.stopScreencast").catch(() => undefined);
}

export function beginManualScreencast(tabId: number): void {
  manual.add(tabId);
}

export async function endManualScreencast(tabId: number): Promise<void> {
  if (!manual.delete(tabId)) return;
  if (!active.has(tabId)) return;
  await chrome.debugger
    .sendCommand({ tabId }, "Page.startScreencast", {
      format: "jpeg",
      quality: 60,
      maxWidth: 1280,
      maxHeight: 800,
      everyNthFrame: 1,
    })
    .catch(() => undefined);
}

export async function withManualScreencast<T>(
  tabId: number,
  method: string,
  run: () => Promise<T>,
): Promise<T> {
  const start = method === "Page.startScreencast";
  const stop = method === "Page.stopScreencast";
  if (start) beginManualScreencast(tabId);
  try {
    return await run();
  } catch (error) {
    if (start) await endManualScreencast(tabId);
    throw error;
  } finally {
    if (stop) await endManualScreencast(tabId);
  }
}

export function subscribeViewer(
  tabId: number,
  send: (data: string, at: number) => void,
): () => void {
  const set = viewers.get(tabId) ?? new Set<(data: string, at: number) => void>();
  set.add(send);
  viewers.set(tabId, set);
  const latest = latestFrame.get(tabId);
  if (latest) send(latest.data, latest.at);
  return () => {
    set.delete(send);
    if (!set.size) viewers.delete(tabId);
  };
}

export function forgetFlight(tabId: number): void {
  active.delete(tabId);
  manual.delete(tabId);
  viewers.delete(tabId);
  latestFrame.delete(tabId);
  void toOffscreen({ target: "aeon-code-offscreen", kind: "flightClear", tabId }).catch(
    () => undefined,
  );
}

export interface SavedFlight {
  tabId: number;
  data: string;
  frames: number;
  durationMs: number;
  startedAt: number;
}

export async function saveFlight(tabId: number): Promise<SavedFlight | undefined> {
  const reply = (await Promise.race([
    toOffscreen({ target: "aeon-code-offscreen", kind: "flightSave", tabId }).catch(
      () => undefined,
    ),
    new Promise((resolve) => setTimeout(() => resolve(undefined), 10_000)),
  ])) as
    | { data?: string; frames?: number; durationMs?: number; startedAt?: number; error?: string }
    | undefined;
  if (!reply?.data || !reply.frames) return undefined;
  return {
    tabId,
    data: reply.data,
    frames: Number(reply.frames),
    durationMs: Number(reply.durationMs ?? 0),
    startedAt: Number(reply.startedAt ?? 0),
  };
}

export async function flightStatus(tabId: number): Promise<Record<string, unknown>> {
  const reply = (await toOffscreen({
    target: "aeon-code-offscreen",
    kind: "flightStatus",
    tabId,
  }).catch(() => undefined)) as Record<string, unknown> | undefined;
  return reply ?? { frames: 0, durationMs: 0 };
}

export async function clearFlight(tabId: number): Promise<Record<string, unknown>> {
  await toOffscreen({ target: "aeon-code-offscreen", kind: "flightClear", tabId }).catch(
    () => undefined,
  );
  return { cleared: true };
}

onEngineInstall(() => {
  chrome.debugger.onEvent.addListener((source, method, raw) => {
    if (method !== "Page.screencastFrame" || source.tabId === undefined) return;
    const params = (raw ?? {}) as { data?: string };
    const entry = active.get(source.tabId);
    if (!entry || !params.data) return;
    const now = Date.now();
    if (now - entry.lastFrameAt < FRAME_MS) return;
    entry.lastFrameAt = now;
    latestFrame.set(source.tabId, { data: params.data, at: now });
    for (const send of viewers.get(source.tabId) ?? []) send(params.data, now);
    void toOffscreen({
      target: "aeon-code-offscreen",
      kind: "flightFrame",
      tabId: source.tabId,
      chatId: entry.chatId,
      startedAt: entry.startedAt,
      at: now,
      data: params.data,
    }).catch(() => undefined);
  });
  chrome.debugger.onDetach.addListener((source) => {
    if (source.tabId !== undefined) void stopFlight(source.tabId);
  });
  chrome.tabs.onRemoved.addListener((tabId) => {
    active.delete(tabId);
    manual.delete(tabId);
    void toOffscreen({ target: "aeon-code-offscreen", kind: "flightClear", tabId }).catch(
      () => undefined,
    );
  });
});
