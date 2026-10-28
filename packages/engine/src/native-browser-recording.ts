import { toOffscreen } from "./code-offscreen-host.js";
import { setTabRecording, showAgentGlow } from "./native-browser-cursor.js";
import { beginManualScreencast, endManualScreencast } from "./native-browser-screencast.js";
import { browserSessionOwner, withBrowserDebugger } from "./native-browser-session.js";
import { onEngineInstall } from "./native-engine-install.js";

// Video recordings of a tab for page.recordVideo: a real video file (MP4 where Chrome can encode
// it, else WebM) made by MediaRecorder in the offscreen document. Tab capture gives true pixels
// and the tab's sound, but Chrome allows it only on a tab the user has invoked the extension on
// (its toolbar button, side panel or shortcut); elsewhere the DevTools screencast is drawn onto
// a canvas and encoded, without sound. While a tab records, nothing of ours is drawn on it: no
// glow, caption or hand-off card (the cursor only when asked for), so the video shows the page.

interface Recording {
  mode: "tab" | "screencast";
  audio: boolean;
  startedAt: number;
}
const recordings = new Map<number, Recording>();
const OFFSCREEN = "aeon-code-offscreen";
const SLICE = 750_000;

export async function recordingCall(
  tabId: number,
  value: Record<string, unknown>,
): Promise<unknown> {
  if (value.recording === "start") return start(tabId, value);
  if (value.recording === "stop") return stop(tabId);
  if (value.recording === "read")
    return toOffscreen({
      target: OFFSCREEN,
      kind: "recordRead",
      tabId,
      offset: Number(value.offset) || 0,
      size: SLICE,
    });
  if (value.recording === "drop")
    return toOffscreen({ target: OFFSCREEN, kind: "recordDrop", tabId });
  if (value.recording === "cancel") return cancel(tabId);
  if (value.recording === "status") {
    const entry = recordings.get(tabId);
    return entry
      ? { recording: true, ...entry, seconds: (Date.now() - entry.startedAt) / 1000 }
      : { recording: false };
  }
  throw new Error("UNSUPPORTED");
}

async function start(tabId: number, value: Record<string, unknown>): Promise<unknown> {
  if (recordings.has(tabId))
    throw new Error("RECORDING_ACTIVE: this tab is already recording; stop it first");
  const options = {
    audio: value.audio !== false,
    format: value.format === "webm" ? "webm" : "mp4",
    fps: Math.max(5, Math.min(60, Number(value.fps) || 30)),
  };
  setTabRecording(tabId, { cursor: value.cursor === true });
  void chrome.tabs
    .sendMessage(tabId, { kind: "browserkit.recording", recording: true })
    .catch(() => undefined);
  try {
    const captured = await startTabCapture(tabId, options);
    const result = captured.ok ? captured : await startScreencast(tabId, options);
    if (!result.ok) throw new Error("RECORDING_FAILED: " + result.error);
    const mode = captured.ok ? "tab" : "screencast";
    recordings.set(tabId, { mode, audio: mode === "tab" && options.audio, startedAt: Date.now() });
    return {
      mode,
      audio: mode === "tab" && options.audio,
      mimeType: result.mimeType,
      ...(captured.ok
        ? {}
        : {
            note:
              "No sound: Chrome records a tab's picture and sound only after the user clicks the extension's toolbar button on that tab once. " +
              captured.error,
          }),
    };
  } catch (error) {
    await finish(tabId);
    throw error;
  }
}

type Started = { ok: true; mimeType: string } | { ok: false; error: string };

async function startTabCapture(
  tabId: number,
  options: { audio: boolean; format: string; fps: number },
): Promise<Started> {
  try {
    const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
    return (await toOffscreen({
      target: OFFSCREEN,
      kind: "recordStart",
      tabId,
      streamId,
      ...options,
    })) as Started;
  } catch (error) {
    return { ok: false, error: String(error instanceof Error ? error.message : error) };
  }
}

async function startScreencast(
  tabId: number,
  options: { format: string; fps: number },
): Promise<Started> {
  const started = (await toOffscreen({
    target: OFFSCREEN,
    kind: "recordStart",
    tabId,
    canvas: true,
    audio: false,
    ...options,
  })) as Started;
  if (!started.ok) return started;
  beginManualScreencast(tabId);
  await withBrowserDebugger(tabId, (debuggee) =>
    chrome.debugger.sendCommand(debuggee, "Page.startScreencast", {
      format: "jpeg",
      quality: 85,
      maxWidth: 1920,
      maxHeight: 1080,
      everyNthFrame: 1,
    }),
  );
  return started;
}

async function stop(tabId: number): Promise<unknown> {
  const entry = recordings.get(tabId);
  if (!entry) throw new Error("NOT_RECORDING: this tab has no recording to stop");
  try {
    const result = (await toOffscreen({ target: OFFSCREEN, kind: "recordStop", tabId })) as {
      ok: boolean;
      error?: string;
      bytes?: number;
      mimeType?: string;
    };
    if (!result.ok) throw new Error("RECORDING_FAILED: " + (result.error ?? "no video"));
    return { ...result, mode: entry.mode, audio: entry.audio, ms: Date.now() - entry.startedAt };
  } finally {
    await finish(tabId);
  }
}

async function cancel(tabId: number): Promise<unknown> {
  await toOffscreen({ target: OFFSCREEN, kind: "recordDrop", tabId }).catch(() => undefined);
  await finish(tabId);
  return { cancelled: true };
}

async function finish(tabId: number): Promise<void> {
  const entry = recordings.get(tabId);
  recordings.delete(tabId);
  setTabRecording(tabId, undefined);
  if (entry?.mode === "screencast")
    await withBrowserDebugger(tabId, (debuggee) =>
      chrome.debugger.sendCommand(debuggee, "Page.stopScreencast", {}),
    ).catch(() => undefined);
  await endManualScreencast(tabId);
  void chrome.tabs
    .sendMessage(tabId, { kind: "browserkit.recording", recording: false })
    .catch(() => undefined);
  if (browserSessionOwner(tabId)) void showAgentGlow(tabId);
}

onEngineInstall(() => {
  chrome.debugger.onEvent.addListener((source, method, params) => {
    if (method !== "Page.screencastFrame" || source.tabId === undefined) return;
    if (recordings.get(source.tabId)?.mode !== "screencast") return;
    const frame = params as { data?: string };
    if (frame.data)
      void toOffscreen({
        target: OFFSCREEN,
        kind: "recordFrame",
        tabId: source.tabId,
        data: frame.data,
      }).catch(() => undefined);
  });
  chrome.tabs.onRemoved.addListener((tabId) => {
    if (recordings.has(tabId)) void cancel(tabId);
  });
});
