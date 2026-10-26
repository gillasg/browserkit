import { engineConfig } from "./engine-config.js";
import { guardAgentTab } from "./native-browser-tab-cleanup.js";
import { withBrowserDebugger } from "./native-browser-session.js";
import { handoffActive } from "./native-browser-control.js";

// The first sign-in to a site asks the user, on the page itself: not now, this once, or always
// for this site. "Always" is remembered in the extension, per site, until the user clears it.
const STORE_KEY = "signin-allowed-sites";
const POLL_MS = 600;
const MAX_WAIT_MS = 10 * 60_000;
const KEY = "Symbol.for('signin.approval')";

export type Approval = "once" | "always" | "no";

const BANNER = (text: string) => `(() => {
  const state = globalThis[${KEY}];
  if (state && state !== "waiting") { document.getElementById("signin-approval")?.remove(); return state; }
  if (document.getElementById("signin-approval")) return "waiting";
  const host = document.createElement("div");
  host.id = "signin-approval";
  host.setAttribute("data-aeon-overlay", "");
  host.style.cssText = "position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:2147483647;";
  const root = host.attachShadow({ mode: "closed" });
  root.innerHTML = '<style>div{display:flex;align-items:center;gap:10px;max-width:min(620px,calc(100vw - 32px));padding:12px 14px;border-radius:14px;background:#17181c;color:#f3f4f6;font:14px/1.4 system-ui,sans-serif;box-shadow:0 8px 30px rgba(0,0,0,.35),0 0 0 1px rgba(255,255,255,.08)}p{margin:0;flex:1}b{display:block;font-size:12px;color:#a5b4fc;font-weight:600}button{border:0;border-radius:9px;padding:7px 12px;font:600 13px system-ui,sans-serif;cursor:pointer;white-space:nowrap}.always{background:#4f46e5;color:#fff}.once{background:#2a2c33;color:#f3f4f6}.no{background:transparent;color:#9ca3af}</style><div><p><b>Sign in with your password manager?</b></p><button class="no">Not now</button><button class="once">This time</button><button class="always">Always here</button></div>';
  root.querySelector("p").append(${JSON.stringify(text)});
  for (const choice of ["no", "once", "always"])
    root.querySelector("." + choice).onclick = () => { globalThis[${KEY}] = choice; host.remove(); };
  globalThis[${KEY}] = "waiting";
  (document.body || document.documentElement).append(host);
  return "waiting";
})()`;

const CLEAR = `(() => { delete globalThis[${KEY}]; document.getElementById("signin-approval")?.remove(); })()`;

export async function alwaysAllowed(site: string): Promise<boolean> {
  const stored = (await chrome.storage.local.get(STORE_KEY))[STORE_KEY] as string[] | undefined;
  return Array.isArray(stored) && stored.includes(site);
}

async function rememberAlways(site: string): Promise<void> {
  const stored = (await chrome.storage.local.get(STORE_KEY))[STORE_KEY] as string[] | undefined;
  const sites = new Set(Array.isArray(stored) ? stored : []);
  sites.add(site);
  await chrome.storage.local.set({ [STORE_KEY]: [...sites] });
}

/** Asks on the page whether the agent may sign in here; "always" skips the question next time. */
export async function approveSignIn(
  tabId: number,
  site: string,
  detail: string,
  active: () => boolean,
): Promise<Approval> {
  if (await alwaysAllowed(site)) return "always";
  const tab = await chrome.tabs.get(tabId).catch(() => undefined);
  if (!tab) throw new Error("TARGET_LOST");
  await chrome.tabs.update(tabId, { active: true }).catch(() => undefined);
  await chrome.windows.update(tab.windowId, { focused: true }).catch(() => undefined);
  void chrome.notifications
    .create("signin-approval-" + tabId, {
      type: "basic",
      iconUrl: chrome.runtime.getURL(engineConfig.notificationIcon),
      title: "Sign in to " + site + "?",
      message: detail,
      requireInteraction: true,
    })
    .catch(() => undefined);
  guardAgentTab(tabId, true);
  handoffActive(tabId, true);
  try {
    const answer = await waitForAnswer(tabId, detail, active);
    if (answer === "always") await rememberAlways(site);
    return answer;
  } finally {
    guardAgentTab(tabId, false);
    handoffActive(tabId, false);
    void chrome.notifications.clear("signin-approval-" + tabId).catch(() => undefined);
    void evaluate(tabId, CLEAR).catch(() => undefined);
  }
}

async function waitForAnswer(
  tabId: number,
  text: string,
  active: () => boolean,
): Promise<Approval> {
  const deadline = Date.now() + MAX_WAIT_MS;
  while (active() && Date.now() < deadline) {
    if (!(await chrome.tabs.get(tabId).catch(() => undefined))) throw new Error("TARGET_LOST");
    const state = await evaluate(tabId, BANNER(text)).catch(() => "waiting");
    if (state === "once" || state === "always" || state === "no") return state;
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  return "no";
}

async function evaluate(tabId: number, expression: string): Promise<unknown> {
  const result = await withBrowserDebugger(tabId, (debuggee) =>
    chrome.debugger.sendCommand(debuggee, "Runtime.evaluate", {
      expression,
      returnByValue: true,
      silent: true,
    }),
  );
  return (result as { result?: { value?: unknown } } | undefined)?.result?.value ?? "waiting";
}
