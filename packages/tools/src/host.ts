import { join } from "node:path";
import { learnAbout, readLearned, learnedHint } from "@browserkit/site-mapper";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { handleCredentialRequest, isCredentialRequest } from "@browserkit/credentials";
import {
  isSiteToolRequest,
  listSiteTools,
  readPageTool,
  runSiteTool,
  siteToolSummaryFor,
} from "@browserkit/site-mapper";
import {
  bridgeDataDirectory,
  handleSiteMapperRequest,
  isSiteMapperRequest,
  siteCapabilities,
  listAbilities,
  readSiteNotes,
  readAbility,
  runAbility,
  saveAbility,
  testAbility,
  trashAbility,
  type Ability,
  type AbilityVia,
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
    if (isSiteToolRequest(request)) return handleSiteTool(request);
    if (isSiteCapabilitiesRequest(request))
      return siteCapabilities(String(request.siteCapabilities.host ?? ""));
    if (isAbilityRunRequest(request)) return answerAbilityRun(request);
    if (isAbilitySaveRequest(request)) return answerAbilitySave(request.abilitySave);
    if (isAbilityRemoveRequest(request))
      return trashAbility(
        String(request.abilityRemove.site ?? ""),
        String(request.abilityRemove.name ?? ""),
        "removed by agent",
      ).then((removed) => ({ removed }));
    if (isAbilityListRequest(request)) return listAbilities(String(request.abilityList.site ?? ""));
    if (isSiteNotesRequest(request))
      return readSiteNotes(siteNameFrom({ site: request.siteNotes }));
    if (isLearnRequest(request)) return answerLearn(request);
    if (isLearnedRequest(request)) return answerLearned(request);
    if (isSiteMapperRequest(request))
      return options.siteMapper?.(request, context) ?? handleSiteMapperRequest(request);
    return options.extra?.(request, context);
  };
}

interface SiteCapabilitiesRequest {
  siteCapabilities: { host?: unknown };
}

function isSiteCapabilitiesRequest(value: unknown): value is SiteCapabilitiesRequest {
  return Boolean(
    value && typeof (value as { siteCapabilities?: unknown }).siteCapabilities === "object",
  );
}

interface AbilityRunRequest {
  abilityRun: {
    site?: unknown;
    name?: unknown;
    inputs?: unknown;
    via?: unknown;
    key?: unknown;
    limit?: unknown;
    cursor?: unknown;
    /** Run the ability's stored test cases instead. */
    test?: unknown;
  };
}

interface AbilityRemoveRequest {
  abilityRemove: { site?: unknown; name?: unknown };
}

function isAbilityRemoveRequest(value: unknown): value is AbilityRemoveRequest {
  return Boolean(value && typeof (value as { abilityRemove?: unknown }).abilityRemove === "object");
}

interface AbilitySaveRequest {
  abilitySave: Record<string, unknown>;
}

function isAbilitySaveRequest(value: unknown): value is AbilitySaveRequest {
  return Boolean(value && typeof (value as { abilitySave?: unknown }).abilitySave === "object");
}

/** Saves an ability an agent wrote: a full ability, or a demonstration's skill ({name, code}). */
async function answerAbilitySave(spec: Record<string, unknown>): Promise<unknown> {
  const now = new Date().toISOString();
  const ways = Array.isArray(spec.ways)
    ? (spec.ways as Ability["ways"])
    : typeof spec.code === "string"
      ? [
          {
            kind: "script" as const,
            runtime: "page" as const,
            code: /^\s*(async\s*)?\(/.test(spec.code)
              ? spec.code
              : `async (page, bu, inputs) => { ${spec.code}\n return inputs; }`,
          },
        ]
      : [];
  const existing = await readAbility(String(spec.site ?? ""), String(spec.name ?? ""));
  const { breaking, code: _code, domains: _domains, ...rest } = spec;
  const saved = await saveAbility(
    {
      kind: spec.kind === "write" ? "write" : "read",
      inputs: (spec.inputs as Ability["inputs"]) ?? {},
      options: (spec.options as Ability["options"]) ?? {},
      ...rest,
      ways,
      name: String(spec.name ?? ""),
      site: String(spec.site ?? ""),
      createdBy: "agent",
      stats: existing?.stats ?? { runs: 0, failures: 0 },
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    } as Ability,
    { breaking: breaking === true },
  );
  return {
    saved: saved.ability.name,
    site: saved.ability.site,
    kind: saved.ability.kind,
    warnings: saved.warnings,
  };
}

function answerAbilityRun(request: AbilityRunRequest): Promise<unknown> {
  const run = request.abilityRun;
  const site = String(run.site ?? "");
  const name = String(run.name ?? "");
  if (run.test) return testAbility(site, name);
  return runAbility(site, name, (run.inputs ?? {}) as Record<string, unknown>, {
    ...(run.via ? { via: run.via as AbilityVia } : {}),
    ...(typeof run.key === "string" ? { key: run.key } : {}),
    ...(typeof run.limit === "number" ? { limit: run.limit } : {}),
    ...(typeof run.cursor === "string" ? { cursor: run.cursor } : {}),
  });
}

function isAbilityRunRequest(value: unknown): value is AbilityRunRequest {
  return Boolean(value && typeof (value as { abilityRun?: unknown }).abilityRun === "object");
}

interface AbilityListRequest {
  abilityList: { site?: unknown };
}

function isAbilityListRequest(value: unknown): value is AbilityListRequest {
  return Boolean(value && typeof (value as { abilityList?: unknown }).abilityList === "object");
}

interface SiteNotesRequest {
  siteNotes: unknown;
}

function isSiteNotesRequest(value: unknown): value is SiteNotesRequest {
  return Boolean(value && (value as { siteNotes?: unknown }).siteNotes !== undefined);
}

interface SiteToolRequest {
  siteTool: {
    action: "summary" | "run" | "page" | "list";
    site?: unknown;
    url?: unknown;
    name?: unknown;
    args?: unknown;
  };
}

function handleSiteTool(value: unknown): Promise<unknown> {
  const request = value as SiteToolRequest;
  const site = siteNameFrom(request.siteTool);
  if (request.siteTool.action === "summary") return siteToolSummaryFor(site);
  if (request.siteTool.action === "page")
    return readPageTool(site, String(request.siteTool.name ?? ""));
  if (request.siteTool.action === "list") return listSiteTools(site);
  return runSiteTool(
    site,
    String(request.siteTool.name ?? ""),
    (request.siteTool.args ?? {}) as Record<string, unknown>,
  );
}

function siteNameFrom(request: { site?: unknown; url?: unknown }): string {
  const value = String(request.site ?? request.url ?? "");
  try {
    return new URL(value.includes("://") ? value : `https://${value}`).hostname.replace(
      /^www\./,
      "",
    );
  } catch {
    return value.replace(/^https?:\/\//, "").split("/")[0] ?? "";
  }
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
