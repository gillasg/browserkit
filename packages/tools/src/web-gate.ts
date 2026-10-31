// The user's blocked sites hold for Node-side web access too, not only for the browser: crawl's
// plain HTTP (every page it follows, every redirect) and mapped-site calls ask this gate first.
// The list is browserkit's site-rules.json, the same one the extension enforces.
import { useWebGate } from "browser-crawl";
import { readBlockedSites, siteName } from "./host.js";

const FRESH_MS = 5_000;
let cached: { at: number; sites: Promise<string[]> } | undefined;

function blockedSites(): Promise<string[]> {
  if (!cached || Date.now() - cached.at > FRESH_MS)
    cached = { at: Date.now(), sites: readBlockedSites() };
  return cached.sites;
}

/** Why a URL or site is off limits, or undefined when it may be used. */
export async function blockedSiteReason(address: string): Promise<string | undefined> {
  const host = siteName(address);
  if (!host) return undefined;
  const site = (await blockedSites()).find(
    (blocked) => host === blocked || host.endsWith("." + blocked),
  );
  return site
    ? `SITE_BLOCKED: the user blocked ${host} for the agent. Do not use it; tell the user if the task needs it.`
    : undefined;
}

export async function assertSiteAllowed(address: string | undefined): Promise<void> {
  const reason = address ? await blockedSiteReason(address) : undefined;
  if (reason) throw new Error(reason);
}

useWebGate(blockedSiteReason);
