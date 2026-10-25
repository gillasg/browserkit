import { join } from "node:path";
import { learnAbout, readLearned, learnedHint } from "@browserkit/site-mapper";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { handleCredentialRequest, isCredentialRequest } from "@browserkit/credentials";
import {
  bridgeDataDirectory,
  handleSiteMapperRequest,
  isSiteMapperRequest,
} from "@browserkit/site-mapper";

// One answer for what a browser cell asks the machine: a login from the password manager, the
// sites this run must stay off, and a mapped site's API. Every host (the bridge, Aeon's chats,
// routine checks and outside MCP sessions) goes through this handler and adds only its own
// storage (workspace files, saved reads, site skills) through `extra`.
//
// Credentials belong to the engine's sign-in flow, never to agent code: the engine refuses a
// `{credential}` call from a cell and only sends one while it is filling a sign-in form. This
// handler answers that request and nothing else; no caller puts the answer in a step or result.
//
// `allow` lifts a block for one run and comes only from Aeon's typed-user-message source. A
// routine, a check, an external session and the bridge always get `allow: []`, whatever their
// siteRules provider says.

export type HostSource = "chat" | "routine" | "external" | "bridge";

export interface HostSiteRules {
  blocked: string[];
  only: string[];
  allow: string[];
}

export interface HostRequestContext {
  source: HostSource;
  /** A chat id, routine id, external session name or bridge session name. */
  scope: string;
  /** The host's workspace for this request, when it serves workspace files. */
  workspace?: string;
}

export interface HostHandlerOptions {
  /** browserkit's home (BROWSERKIT_HOME); default: the shared browserkit data folder. */
  dataDirectory?: string;
  siteRules?: (context: HostRequestContext) => HostSiteRules | Promise<HostSiteRules>;
  /** A host's own mapped-site call path (Aeon attributes it to a chat); default: the shared one. */
  siteMapper?: (request: unknown, context: HostRequestContext) => Promise<unknown> | undefined;
  /** A host's own requests: workspace files, site skills, saved reads, upload checks. */
  extra?: (request: unknown, context: HostRequestContext) => Promise<unknown> | undefined;
}

export function browserkitHome(): string {
  return bridgeDataDirectory();
}

export const siteRulesPath = (home = browserkitHome()): string => join(home, "site-rules.json");

export function isSiteRulesRequest(value: unknown): boolean {
  return (value as { siteRules?: unknown } | null)?.siteRules === true;
}

/** The user's block list from browserkit's own site-rules.json. */
export async function readBlockedSites(home = browserkitHome()): Promise<string[]> {
  try {
    const value = JSON.parse(await readFile(siteRulesPath(home), "utf8")) as {
      blocked?: unknown;
    };
    return Array.isArray(value.blocked) ? value.blocked.map(String) : [];
  } catch {
    return [];
  }
}

export async function saveBlockedSites(sites: string[], home = browserkitHome()): Promise<void> {
  await mkdir(home, { recursive: true });
  await writeFile(siteRulesPath(home), JSON.stringify({ blocked: sites }, null, 2) + "\n");
}

/** "hdfcbank.com" from whatever the user typed: a URL, a host, with or without www. */
export function siteName(value: string): string | undefined {
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(value) ? value : "https://" + value);
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    return host.includes(".") || host === "localhost" ? host : undefined;
  } catch {
    return undefined;
  }
}

export async function addBlockedSite(
  value: string,
  home = browserkitHome(),
): Promise<string | undefined> {
  const site = siteName(value);
  if (!site) return undefined;
  const blocked = await readBlockedSites(home);
  await saveBlockedSites([...new Set([...blocked, site])].sort(), home);
  return site;
}

export async function removeBlockedSite(
  value: string,
  home = browserkitHome(),
): Promise<string | undefined> {
  const site = siteName(value);
  if (!site) return undefined;
  const blocked = await readBlockedSites(home);
  await saveBlockedSites(
    blocked.filter((item) => item !== site),
    home,
  );
  return site;
}

/**
 * The machine's answer to a host request, or undefined when it is not one of these. `allow` is
 * forced empty outside a chat: only Aeon's typed-user-message answer may lift a block.
 */
export function createHostHandler(
  options: HostHandlerOptions = {},
): (request: unknown, context: HostRequestContext) => Promise<unknown> | undefined {
  const home = options.dataDirectory ?? browserkitHome();
  return (request, context) => {
    if (isCredentialRequest(request)) return handleCredentialRequest(request, home);
    if (isSiteRulesRequest(request)) return answerSiteRules(context, options, home);
    if (isLearnRequest(request)) return answerLearn(request);
    if (isLearnedRequest(request)) return answerLearned(request);
    if (isSiteMapperRequest(request))
      return options.siteMapper?.(request, context) ?? handleSiteMapperRequest(request);
    return options.extra?.(request, context);
  };
}

/** What a run learned about a site, kept in the site's pack (see site-mapper's learned.ts). */
export function isLearnRequest(value: unknown): boolean {
  return Boolean(value && typeof (value as { learn?: unknown }).learn === "object");
}

export function isLearnedRequest(value: unknown): boolean {
  return Boolean(value && typeof (value as { learned?: unknown }).learned === "string");
}

async function answerLearn(request: unknown): Promise<unknown> {
  const patch = (request as { learn?: Record<string, unknown> }).learn ?? {};
  const site =
    (typeof patch.site === "string" && patch.site) ||
    siteName(String(patch.url ?? "")) ||
    undefined;
  if (!site) throw new Error("learn needs a site (or a url)");
  const note = await learnAbout(site, {
    ...(typeof patch.gate === "string" ? { gate: patch.gate } : {}),
    ...(typeof patch.clicked === "string" ? { clicked: patch.clicked } : {}),
    ...(typeof patch.referer === "string" ? { referer: patch.referer } : {}),
    ...(patch.play === true ? { play: true } : {}),
    ...(Array.isArray(patch.functions)
      ? { functions: patch.functions.map(String).slice(0, 20) }
      : {}),
    ...(typeof patch.note === "string" ? { note: patch.note.slice(0, 500) } : {}),
  });
  return { saved: true, site: note.site, runs: note.runs };
}

async function answerLearned(request: unknown): Promise<unknown> {
  const url = String((request as { learned?: unknown }).learned ?? "");
  const site = siteName(url);
  const note = site ? await readLearned(site) : undefined;
  return { site, ...(note ? note : {}), hint: learnedHint(note) };
}

async function answerSiteRules(
  context: HostRequestContext,
  options: HostHandlerOptions,
  home: string,
): Promise<HostSiteRules> {
  const answer = (await options.siteRules?.(context)) ?? { blocked: [], only: [], allow: [] };
  return {
    blocked: [...new Set([...(await readBlockedSites(home)), ...(answer.blocked ?? [])])],
    only: answer.only ?? [],
    allow: context.source === "chat" ? (answer.allow ?? []) : [],
  };
}
