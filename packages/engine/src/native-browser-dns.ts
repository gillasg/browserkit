// DNS lookups for the private-network preflight. The extension has no DNS API, so the bridge
// resolves names on the machine (its own resolver, including the hosts file) and returns every
// address. A preflight is only as good as this answer; rebinding after it is caught in the network
// recorder from the response's remote address.
import { engineConfig } from "./engine-config.js";
import { privateAddress, privateTarget, resolvedTarget } from "./native-browser-policy.js";

interface Pending {
  resolve: (addresses: string[]) => void;
  timer: ReturnType<typeof setTimeout>;
}

let socket: WebSocket | undefined;
let sequence = 0;
const pending = new Map<number, Pending>();

export function installBrowserDns(connection: WebSocket): void {
  socket = connection;
}

/** Every address the machine's resolver returns, or an empty list when it cannot answer. */
export function resolveBrowserHost(host: string): Promise<string[]> {
  if (!host || socket?.readyState !== WebSocket.OPEN) return Promise.resolve([]);
  const requestId = ++sequence;
  return new Promise((resolve) => {
    const timer = globalThis.setTimeout(() => {
      pending.delete(requestId);
      resolve([]);
    }, 4_000);
    pending.set(requestId, { resolve, timer });
    socket?.send(JSON.stringify({ kind: "browser.dns.query", requestId, host }));
  });
}

export function handleBrowserDnsMessage(candidate: unknown): boolean {
  const message = candidate as { kind?: unknown; requestId?: unknown; addresses?: unknown };
  if (message?.kind !== "browser.dns.result") return false;
  const requestId = Number(message.requestId);
  const item = pending.get(requestId);
  if (!item) return true;
  pending.delete(requestId);
  clearTimeout(item.timer);
  item.resolve(
    Array.isArray(message.addresses)
      ? message.addresses.filter((value): value is string => typeof value === "string")
      : [],
  );
  return true;
}

/**
 * The opt-in check every agent fetch, open and navigation runs. Literal private addresses are
 * decided without DNS; other names are resolved first. A name that cannot be resolved is refused
 * while the policy is on, because the preflight cannot prove it public.
 */
export async function assertBrowserNetwork(url: string): Promise<void> {
  if (!(await engineConfig.privateNetwork())) return;
  const ports = await engineConfig.privateNetworkPorts();
  const literal = privateTarget(url, ports);
  if (literal) throw new Error(`PRIVATE_NETWORK: ${literal}`);
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase().replace(/^\[|\]$/g, "");
  } catch {
    throw new Error("PRIVATE_NETWORK: invalid url");
  }
  // A literal loopback host on an allowed development port stops here; everything else resolves.
  if (privateAddress(host) || host === "localhost") return;
  const addresses = await resolveBrowserHost(host);
  if (!addresses.length) throw new Error(`PRIVATE_NETWORK: could not resolve ${host}`);
  const resolved = resolvedTarget(host, addresses);
  if (resolved) throw new Error(`PRIVATE_NETWORK: ${resolved}`);
}
