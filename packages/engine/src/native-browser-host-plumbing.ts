// Host plumbing for the Aeon UI: control hand-back, space windows and privacy settings. The
// extension speaks these as browser.host.* messages over the executor socket; responses are
// browser.host.result with the same requestId so the daemon can await one without touching code
// cells.
import { giveBack, controlOf } from "./native-browser-control.js";
import { claimSpace, finishSpace, listSpaces, touchSpace } from "./native-browser-spaces.js";
import { vaultNeverSaveSites } from "./native-browser-vault.js";

const PRIVATE_NETWORK = "private-network";
const PRIVATE_PORTS = "private-network-ports";
const NEVER_SAVE = "vault-never-save";

export function handlesHostPlumbing(candidate: unknown): boolean {
  const message = candidate as { kind?: unknown };
  return typeof message?.kind === "string" && message.kind.startsWith("browser.host.");
}

export async function hostPlumbing(candidate: unknown, socket: WebSocket): Promise<boolean> {
  if (!handlesHostPlumbing(candidate)) return false;
  const message = candidate as Record<string, unknown>;
  const requestId = String(message.requestId ?? "");
  const reply = (body: Record<string, unknown>) =>
    socket.send(JSON.stringify({ kind: "browser.host.result", requestId, ...body }));
  try {
    reply({ ok: true, result: await run(message) });
  } catch (error) {
    reply({ ok: false, error: String(error instanceof Error ? error.message : error) });
  }
  return true;
}

async function run(message: Record<string, unknown>): Promise<unknown> {
  const action = String(message.action ?? "");
  const chatId = String(message.chatId ?? "");
  if (action === "control.giveBack") {
    const tabId = Number(message.tabId);
    const changed = giveBack(tabId);
    return { tabId, control: controlOf(tabId), changed };
  }
  if (action === "spaces.list") return { spaces: await listSpaces() };
  if (action === "spaces.close") return finishSpace(chatId, []);
  if (action === "spaces.claim") return claimSpace(chatId);
  if (action === "spaces.touch") {
    touchSpace(chatId);
    return { touched: true };
  }
  if (action === "privacy.get") return privacy();
  if (action === "privacy.set") {
    if (typeof message.privateNetwork === "boolean")
      await chrome.storage.local.set({ [PRIVATE_NETWORK]: message.privateNetwork });
    if (Array.isArray(message.ports)) {
      const ports = message.ports
        .map(Number)
        .filter((port) => Number.isInteger(port) && port > 0 && port < 65536);
      await chrome.storage.local.set({ [PRIVATE_PORTS]: ports });
    }
    return privacy();
  }
  if (action === "vault.neverSave.list") return { sites: await vaultNeverSaveSites() };
  if (action === "vault.neverSave.remove") {
    const site = String(message.site ?? "")
      .trim()
      .toLowerCase();
    const sites = (await vaultNeverSaveSites()).filter((item) => item !== site);
    await chrome.storage.local.set({ [NEVER_SAVE]: sites });
    return { sites };
  }
  throw new Error(`Unknown host action ${action}`);
}

async function privacy(): Promise<{
  privateNetwork: boolean;
  ports: number[];
  neverSave: string[];
}> {
  const saved = (await chrome.storage.local.get([
    PRIVATE_NETWORK,
    PRIVATE_PORTS,
    NEVER_SAVE,
  ])) as Record<string, unknown>;
  return {
    privateNetwork: saved[PRIVATE_NETWORK] === true,
    ports: Array.isArray(saved[PRIVATE_PORTS])
      ? (saved[PRIVATE_PORTS] as unknown[]).map(Number).filter((port) => port > 0)
      : [3000, 5173, 8080],
    neverSave: await vaultNeverSaveSites(),
  };
}
