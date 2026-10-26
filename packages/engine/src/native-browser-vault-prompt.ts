import { withBrowserDebugger } from "./native-browser-session.js";
import type { VaultAsk, VaultCandidate } from "./native-browser-vault.js";

// A small banner after a person's login succeeds: save it to the configured password manager,
// or not now. It never displays the password. The engine asks the host to save; the page only
// carries the answer. The banner is dropped on a navigation to another site and never outlives
// two minutes.
const KEY = "Symbol.for('vault.save')";
const POLL_MS = 700;
const MAX_WAIT_MS = 2 * 60_000;

const BANNER = (site: string) => `(() => {
  const site = ${JSON.stringify(site)};
  const state = globalThis[${KEY}];
  if (state && state !== "waiting" && state.site !== site) return "leave";
  if (state && state.site === site && state.choice && state.choice !== "waiting") return state.choice;
  if (location.hostname.replace(/^www\\./, "") !== site) return "leave";
  if (document.getElementById("vault-save")) return "waiting";
  const host = document.createElement("div");
  host.id = "vault-save";
  host.setAttribute("data-browserkit-overlay", "");
  host.style.cssText = "position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:2147483647;";
  const root = host.attachShadow({mode: "open"});
  root.innerHTML = '<style>div{display:flex;align-items:center;gap:10px;max-width:min(560px,calc(100vw - 32px));padding:12px 14px;border-radius:14px;background:#17181c;color:#f3f4f6;font:14px/1.4 system-ui,sans-serif;box-shadow:0 8px 30px rgba(0,0,0,.35),0 0 0 1px rgba(255,255,255,.08)}p{margin:0;flex:1}button{border:0;border-radius:9px;padding:7px 12px;font:600 13px system-ui,sans-serif;cursor:pointer;white-space:nowrap}.save{background:#4f46e5;color:#fff}.no{background:transparent;color:#9ca3af}</style><div><p>Save this login to your password manager?</p><button class="no">Not now</button><button class="save">Save</button></div>';
  for (const choice of ["no", "save"])
    root.querySelector("." + choice).onclick = () => {
      globalThis[${KEY}] = {site, choice};
      host.remove();
    };
  globalThis[${KEY}] = {site, choice: "waiting"};
  (document.body || document.documentElement).append(host);
  return "waiting";
})()`;

const CLEAR = `(() => { delete globalThis[${KEY}]; document.getElementById("vault-save")?.remove(); })()`;

export async function promptVaultSave(
  tabId: number,
  candidate: VaultCandidate,
  ask: VaultAsk,
  active: () => boolean,
): Promise<void> {
  const deadline = Date.now() + MAX_WAIT_MS;
  try {
    while (active() && Date.now() < deadline) {
      if (!(await chrome.tabs.get(tabId).catch(() => undefined))) return;
      const answer = await evaluate(tabId, BANNER(candidate.site)).catch(() => "waiting");
      if (answer === "leave") return;
      if (answer === "no") return;
      if (answer === "save") {
        const saved = await save(candidate, ask);
        await showResult(tabId, saved).catch(() => undefined);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
  } finally {
    await evaluate(tabId, CLEAR).catch(() => undefined);
  }
}

async function save(candidate: VaultCandidate, ask: VaultAsk): Promise<boolean> {
  try {
    const result = (await ask({
      credential: "save",
      url: candidate.url,
      username: candidate.username,
      password: candidate.password,
      name: candidate.site || new URL(candidate.url).hostname,
    })) as { saved?: boolean } | undefined;
    return Boolean(result?.saved);
  } catch {
    return false;
  }
}

async function showResult(tabId: number, saved: boolean): Promise<void> {
  const text = saved ? "Saved to your password manager." : "Could not save this login.";
  await evaluate(
    tabId,
    `(() => { const host = document.getElementById("vault-save"); if (!host) return; const root = host.shadowRoot; if (root) { const p = root.querySelector("p"); if (p) p.textContent = ${JSON.stringify(text)}; } setTimeout(() => host.remove(), 1600); })()`,
  );
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
