import { engineConfig } from "./engine-config.js";
import { guardAgentTab } from "./native-browser-tab-cleanup.js";
import { withBrowserDebugger } from "./native-browser-session.js";
import { onEngineInstall } from "./native-engine-install.js";
import { handoffActive } from "./native-browser-control.js";

// Hand-off: the agent pauses and asks the user to do something in the real tab (sign in, 2FA,
// pick an option). A banner on the page carries the request plus Done and Cancel; the cell
// waits until one is clicked. Login flows navigate, so the banner is re-shown on every poll.
const POLL_MS = 600;
const MAX_WAIT_MS = 30 * 60_000;
const KEY = "Symbol.for('aeon.handoff')";

const BANNER = (message: string) => `(() => {
  const state = globalThis[${KEY}];
  if (state === "done" || state === "cancelled") {
    document.getElementById("aeon-handoff")?.remove();
    return state;
  }
  if (document.getElementById("aeon-handoff")) return "waiting";
  const host = document.createElement("div");
  host.id = "aeon-handoff";
  host.setAttribute("data-aeon-overlay", "");
  host.style.cssText = "position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:2147483647;";
  const root = host.attachShadow({ mode: "closed" });
  root.innerHTML = '<style>div{display:flex;align-items:center;gap:12px;max-width:min(560px,calc(100vw - 32px));padding:12px 14px;border-radius:14px;background:#17181c;color:#f3f4f6;font:14px/1.4 system-ui,sans-serif;box-shadow:0 8px 30px rgba(0,0,0,.35),0 0 0 1px rgba(255,255,255,.08)}p{margin:0;flex:1}b{display:block;font-size:12px;color:#a5b4fc;font-weight:600}button{border:0;border-radius:9px;padding:7px 12px;font:600 13px system-ui,sans-serif;cursor:pointer}.done{background:#4f46e5;color:#fff}.cancel{background:transparent;color:#9ca3af}</style><div><p><b>Agent needs you</b></p><button class="cancel">Cancel</button><button class="done">Done</button></div>';
  root.querySelector("p").append(${JSON.stringify(message)});
  root.querySelector(".done").onclick = () => { globalThis[${KEY}] = "done"; host.remove(); };
  root.querySelector(".cancel").onclick = () => { globalThis[${KEY}] = "cancelled"; host.remove(); };
  globalThis[${KEY}] = "waiting";
  (document.body || document.documentElement).append(host);
  return "waiting";
})()`;

// Answers given from the chat's hand-off card, keyed by tab; the next poll picks them up.
const answers = new Map<number, "done" | "cancelled">();
onEngineInstall(() => {
  chrome.runtime.onMessage.addListener((message, sender) => {
    if (sender.id !== chrome.runtime.id || message?.kind !== "aeon.handoff.answer") return;
    if (message.answer === "done" || message.answer === "cancelled")
      answers.set(Number(message.tabId), message.answer);
  });
});

const CLEAR = `(() => { delete globalThis[${KEY}]; document.getElementById("aeon-handoff")?.remove(); })()`;

export async function handOffToUser(
  tabId: number,
  message: string,
  active: () => boolean,
): Promise<"done" | "cancelled"> {
  const tab = await chrome.tabs.get(tabId).catch(() => undefined);
  if (!tab) throw new Error("TARGET_LOST");
  await chrome.tabs.update(tabId, { active: true }).catch(() => undefined);
  await chrome.windows.update(tab.windowId, { focused: true }).catch(() => undefined);
  const notification = "aeon-handoff-" + tabId;
  void chrome.notifications
    .create(notification, {
      type: "basic",
      iconUrl: chrome.runtime.getURL(engineConfig.notificationIcon),
      title: "The agent needs you",
      message,
      requireInteraction: true,
    })
    .catch(() => undefined);
  const deadline = Date.now() + MAX_WAIT_MS;
  answers.delete(tabId);
  guardAgentTab(tabId, true);
  handoffActive(tabId, true);
  try {
    while (active() && Date.now() < deadline) {
      if (!(await chrome.tabs.get(tabId).catch(() => undefined))) throw new Error("TARGET_LOST");
      const answered = answers.get(tabId);
      if (answered) return answered;
      const state = await evaluate(tabId, BANNER(message));
      if (state === "done" || state === "cancelled") return state;
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
    return "cancelled";
  } finally {
    guardAgentTab(tabId, false);
    handoffActive(tabId, false);
    answers.delete(tabId);
    void chrome.notifications.clear(notification).catch(() => undefined);
    void evaluate(tabId, CLEAR).catch(() => undefined);
  }
}

onEngineInstall(() => {
  chrome.notifications.onClicked.addListener((id) => {
    if (!id.startsWith("aeon-handoff-")) return;
    const tabId = Number(id.slice("aeon-handoff-".length));
    void chrome.tabs.get(tabId).then(
      (tab) =>
        Promise.all([
          chrome.tabs.update(tabId, { active: true }),
          chrome.windows.update(tab.windowId, { focused: true }),
        ]),
      () => undefined,
    );
  });
});

async function evaluate(tabId: number, expression: string): Promise<unknown> {
  // A page mid-navigation has no context to evaluate in; that poll just reports "waiting".
  const result = await withBrowserDebugger(tabId, (debuggee) =>
    chrome.debugger.sendCommand(debuggee, "Runtime.evaluate", {
      expression,
      returnByValue: true,
      silent: true,
    }),
  ).catch(() => undefined);
  return (result as { result?: { value?: unknown } } | undefined)?.result?.value ?? "waiting";
}
