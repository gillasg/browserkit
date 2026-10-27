import {
  BrowserExecutorHeartbeatReplySchema,
  BrowserExecutorHeartbeatSchema,
} from "@browserkit/protocol";
import type { BrowserIdentity } from "./native-worker-identity.js";

/** Prepare on worker load, browser startup, and wake before a page requests a grant. */
export function installNativeStartup(connect: () => Promise<unknown>, retry: () => void): void {
  const warm = () => {
    void connect().catch(retry);
  };
  chrome.runtime.onStartup.addListener(warm);
  chrome.runtime.onInstalled.addListener(warm);
  chrome.tabs.onActivated.addListener(warm);
  chrome.windows.onFocusChanged.addListener((windowId) => {
    if (windowId !== chrome.windows.WINDOW_ID_NONE) warm();
  });
  // A service worker can sleep while the daemon restarts; an alarm wakes it to retry the link.
  const alarm = "aeon-executor-reconnect";
  void chrome.alarms?.create(alarm, { periodInMinutes: 1 });
  chrome.alarms?.onAlarm.addListener((fired) => {
    if (fired.name === alarm) warm();
  });
  warm();
}

let timer: number | undefined;
let attempts = 0;
/** Re-establish the browser executor without replaying any browser operation. */
export function scheduleExecutorReconnect(connect: () => Promise<unknown>): void {
  if (timer !== undefined) return;
  const delay = Math.min(250 * 2 ** Math.min(attempts++, 3), 2000);
  timer = globalThis.setTimeout(() => {
    timer = undefined;
    void connect().then(
      () => {
        attempts = 0;
      },
      () => scheduleExecutorReconnect(connect),
    );
  }, delay);
}

export function startExecutorHeartbeat(
  socket: WebSocket,
  identity: BrowserIdentity,
  build?: () => string | undefined,
): number {
  let acknowledged = Date.now();
  const onMessage = (event: MessageEvent) => {
    try {
      const reply = BrowserExecutorHeartbeatReplySchema.safeParse(JSON.parse(String(event.data)));
      if (
        reply.success &&
        reply.data.clientInstanceId === identity.clientInstanceId &&
        reply.data.browserRunId === identity.browserRunId
      )
        acknowledged = Date.now();
    } catch {
      /* Other protocol messages are handled by the worker. */
    }
  };
  socket.addEventListener("message", onMessage);
  const timer = globalThis.setInterval(() => {
    if (socket.readyState !== WebSocket.OPEN) return;
    if (Date.now() - acknowledged > 65000) {
      socket.close(4004, "Daemon heartbeat expired; reconnect required");
      return;
    }
    try {
      const stamp = build?.();
      socket.send(
        JSON.stringify(
          BrowserExecutorHeartbeatSchema.parse({
            kind: "browser.executor.heartbeat",
            ...identity,
            ...(stamp ? { build: stamp } : {}),
          }),
        ),
      );
    } catch {
      socket.close(4004, "Executor heartbeat failed");
    }
  }, 20000);
  socket.addEventListener(
    "close",
    () => {
      clearInterval(timer);
      socket.removeEventListener("message", onMessage);
    },
    { once: true },
  );
  return timer;
}
