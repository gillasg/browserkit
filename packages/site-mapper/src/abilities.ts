// One named thing doable on a site, read or write, with the ways to do it tried in order: the
// site's API, a replayed step list, code, or a page collector. Abilities replace the old recipe,
// action, workflow, skill and site-tool stores; notes.md holds what is not callable.

import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import vm from "node:vm";
import { siteDir, siteName, writeAtomic } from "./registry.js";
import type { CollectRecipe, RecipePagination } from "./recipes.js";
import type { Json } from "./types.js";

export type AbilityKind = "read" | "write";
export type AbilityCreatedBy = "agent" | "user" | "import";
export type AbilityVia = "api" | "steps" | "script" | "page";

export interface AbilityApiStep {
  operation: string;
  params?: Record<string, unknown>;
}

export interface AbilityWayApi {
  kind: "api";
  /** One operation. */
  operation?: string;
  /** A chain of operations; later steps may map values from inputs/earlier steps. */
  operations?: AbilityApiStep[];
  open?: string;
  params?: Record<string, unknown>;
  paging?: RecipePagination;
  records?: { find: { exists: string[] } };
  write?: Record<string, unknown>;
  input?: Json;
}

export interface AbilityWaySteps {
  kind: "steps";
  /** A saved workflow definition, or its name for the host's workflow store. */
  workflow?: unknown;
  name?: string;
  params?: Record<string, unknown>;
  steps?: unknown[];
}

export interface AbilityWayScript {
  kind: "script";
  code: string;
  runtime: "node" | "page";
  input?: Json;
}

export interface AbilityWayPage {
  kind: "page";
  collect?: CollectRecipe;
  url?: string;
  extractor?: unknown;
}

export type AbilityWay = AbilityWayApi | AbilityWaySteps | AbilityWayScript | AbilityWayPage;

export interface AbilityOptions {
  paging?: RecipePagination;
  recordMapping?: Record<string, unknown>;
  dryRun?: boolean;
  /** Old fields with no dedicated home live here (write receipts, render, thread, derive…). */
  [key: string]: unknown;
}

export interface AbilityStats {
  runs: number;
  failures: number;
  lastOkAt?: string;
  lastUsedAt?: string;
}

export interface Ability {
  name: string;
  site: string;
  description?: string;
  kind: AbilityKind;
  inputs: Record<string, unknown>;
  ways: AbilityWay[];
  options: AbilityOptions;
  stats: AbilityStats;
  createdBy: AbilityCreatedBy;
  /** The old store it came from: recipe, action, workflow, tool, pageTool, skill, pack. */
  sourceKind?: string;
  createdAt: string;
  updatedAt: string;
}

export interface AbilityRunResult {
  result: unknown;
  via: AbilityVia;
  tried: { via: AbilityVia; error: string }[];
}

export interface AbilityHost {
  call?: (operation: string, params: Record<string, unknown>) => Promise<unknown>;
  write?: (operation: string, params: Record<string, unknown>) => Promise<unknown>;
  open?: (url: string) => Promise<void>;
  collect?: (input: CollectRecipe & { url?: string }) => Promise<unknown>;
  script?: (code: string, input: unknown) => Promise<unknown>;
  workflow?: (input: {
    name?: string;
    workflow?: unknown;
    inputs: Record<string, unknown>;
  }) => Promise<unknown>;
  resolveOperation?: (wanted: string) => string | undefined;
}

const ABILITIES = "abilities";
const NOTES = "notes.md";
const TRASH = "trash";
const NAME = /^[a-z0-9][a-z0-9 _.-]{0,80}$/i;

export function abilityDirectory(site: string): string {
  return join(siteDir(siteName(site)), ABILITIES);
}

export function abilitySlug(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

export async function listAbilities(site: string): Promise<Ability[]> {
  const folder = abilityDirectory(site);
  const files = (await readdir(folder).catch(() => [] as string[])).filter((file) =>
    file.endsWith(".json"),
  );
  const abilities = await Promise.all(files.map((file) => readAbilityFile(join(folder, file))));
  return abilities
    .filter((ability): ability is Ability => !!ability)
    .sort((left, right) => left.name.localeCompare(right.name));
}

export async function readAbility(site: string, name: string): Promise<Ability | undefined> {
  const direct = await readAbilityFile(join(abilityDirectory(site), abilitySlug(name) + ".json"));
  if (direct) return direct;
  return (await listAbilities(site)).find((ability) => ability.name === name);
}

async function readAbilityFile(path: string): Promise<Ability | undefined> {
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as Ability;
    return value && typeof value.name === "string" && Array.isArray(value.ways) ? value : undefined;
  } catch {
    return undefined;
  }
}

export async function saveAbility(
  ability: Ability,
  options: { replace?: boolean } = {},
): Promise<{
  ability: Ability;
  path: string;
}> {
  const site = siteName(ability.site);
  const name = validAbilityName(ability.name);
  validateAbility({ ...ability, name, site });
  await mkdir(abilityDirectory(site), { recursive: true });
  const path = join(abilityDirectory(site), abilitySlug(name) + ".json");
  const existing = await readAbilityFile(path);
  if (existing && options.replace === false)
    throw new Error(`ABILITY_EXISTS: ${site} already has ${name}`);
  const next: Ability = {
    ...ability,
    name,
    site,
    stats: ability.stats ?? { runs: 0, failures: 0 },
    createdAt: ability.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  await writeAtomic(path, JSON.stringify(next, null, 2) + "\n");
  return { ability: next, path };
}

export async function createAbility(
  ability: Omit<Ability, "name" | "site" | "stats" | "createdAt" | "updatedAt"> & {
    name: string;
    site: string;
  },
): Promise<{ ability: Ability; path: string }> {
  const base = validAbilityName(ability.name);
  let name = base;
  for (let index = 2; await readAbility(ability.site, name); index++) name = `${base}-${index}`;
  return saveAbility({
    ...ability,
    name,
    site: siteName(ability.site),
    stats: { runs: 0, failures: 0 },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
}

/** Moves an ability to trash/; nothing is hard-deleted. */
export async function trashAbility(
  site: string,
  name: string,
  reason = "maintenance",
): Promise<boolean> {
  const ability = await readAbility(site, name);
  if (!ability) return false;
  const folder = join(siteDir(siteName(site)), TRASH);
  await mkdir(folder, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const path = join(folder, `${abilitySlug(ability.name)}-${stamp}.json`);
  await writeAtomic(
    path,
    JSON.stringify({ ...ability, trashedAt: new Date().toISOString(), reason }, null, 2) + "\n",
  );
  await rename(
    join(abilityDirectory(site), abilitySlug(ability.name) + ".json"),
    join(abilityDirectory(site), "." + abilitySlug(ability.name) + "." + stamp + ".deleted"),
  );
  return true;
}

/**
 * Five failures in a row with no success in 14 days, or unused for 60 days, go to trash/.
 * A never-used ability is measured from its creation.
 */
export async function maintainAbilities(
  site: string,
  now = new Date(),
): Promise<{ trashed: string[] }> {
  const trashed: string[] = [];
  const day = 86_400_000;
  for (const ability of await listAbilities(site)) {
    const lastOk = ability.stats.lastOkAt ? Date.parse(ability.stats.lastOkAt) : undefined;
    const lastUsed = ability.stats.lastUsedAt
      ? Date.parse(ability.stats.lastUsedAt)
      : Date.parse(ability.createdAt);
    const failing =
      ability.stats.failures >= 5 && (lastOk === undefined || now.getTime() - lastOk > 14 * day);
    const unused = Number.isFinite(lastUsed) && now.getTime() - lastUsed > 60 * day;
    if (!failing && !unused) continue;
    if (await trashAbility(site, ability.name, failing ? "failing" : "unused"))
      trashed.push(ability.name);
  }
  return { trashed };
}

export async function runAbility(
  site: string,
  name: string,
  inputs: Record<string, unknown> = {},
  options: { via?: AbilityVia; host?: AbilityHost } = {},
): Promise<AbilityRunResult> {
  const ability = await readAbility(site, name);
  if (!ability) throw new Error(`ABILITY_UNKNOWN: ${siteName(site)} has no ability ${name}`);
  const host = options.host ?? defaultHost(site);
  const tried: { via: AbilityVia; error: string }[] = [];
  for (const way of ability.ways) {
    if (options.via && way.kind !== options.via) continue;
    try {
      const result = await attemptWay(ability, way, inputs, host);
      await recordAbilityRun(ability, true);
      return { result, via: way.kind, tried };
    } catch (error) {
      tried.push({
        via: way.kind,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  await recordAbilityRun(ability, false);
  const detail = tried.map((item) => `${item.via}: ${item.error}`).join("; ") || "no way matched";
  throw new Error(`ABILITY_FAILED: ${siteName(site)} ${ability.name} (${detail})`);
}

async function attemptWay(
  ability: Ability,
  way: AbilityWay,
  inputs: Record<string, unknown>,
  host: AbilityHost,
): Promise<unknown> {
  if (way.kind === "api") return attemptApi(way, inputs, host);
  if (way.kind === "steps") return attemptSteps(way, inputs, host);
  if (way.kind === "page") return attemptPage(way, inputs, host);
  return attemptScript(ability, way, inputs, host);
}

async function attemptApi(
  way: AbilityWayApi,
  inputs: Record<string, unknown>,
  host: AbilityHost,
): Promise<unknown> {
  const operations = apiOperations(way);
  if (!operations.length) throw new Error("API way has no operation");
  const call = host.write ?? host.call;
  if (!call) throw new Error("No site API transport");
  if (way.open && host.open) await host.open(String(fill(way.open, inputs)));
  const stepResults: unknown[] = [];
  let result: unknown;
  for (const step of operations)
    result = await callApiStep(step, way, inputs, stepResults, call, host);
  return result;
}

function apiOperations(way: AbilityWayApi): AbilityApiStep[] {
  if (way.operations) return way.operations;
  return way.operation ? [{ operation: way.operation }] : [];
}

async function callApiStep(
  step: AbilityApiStep,
  way: AbilityWayApi,
  inputs: Record<string, unknown>,
  stepResults: unknown[],
  call: (operation: string, params: Record<string, unknown>) => Promise<unknown>,
  host: AbilityHost,
): Promise<unknown> {
  const params = fill(
    { ...(way.params ?? {}), ...(step.params ?? {}) },
    inputs,
    stepResults,
  ) as Record<string, unknown>;
  const result = await call(host.resolveOperation?.(step.operation) ?? step.operation, params);
  stepResults.push(result);
  return result;
}

async function attemptSteps(
  way: AbilityWaySteps,
  inputs: Record<string, unknown>,
  host: AbilityHost,
): Promise<unknown> {
  if (!host.workflow) throw new Error("No workflow runtime is attached");
  return host.workflow({
    ...(way.name ? { name: way.name } : {}),
    ...(way.workflow ? { workflow: way.workflow } : {}),
    inputs: { ...inputs, ...(fill(way.params ?? {}, inputs) as Record<string, unknown>) },
  });
}

async function attemptPage(
  way: AbilityWayPage,
  inputs: Record<string, unknown>,
  host: AbilityHost,
): Promise<unknown> {
  if (!host.collect) throw new Error("No browser is attached for a page way");
  return host.collect({
    ...(way.collect ?? { row: "body", fields: {} }),
    ...(way.url ? { url: fill(way.url, inputs) as string } : {}),
  });
}

async function attemptScript(
  ability: Ability,
  way: AbilityWayScript,
  inputs: Record<string, unknown>,
  host: AbilityHost,
): Promise<unknown> {
  if (way.runtime === "page") {
    if (!host.script) throw new Error("No browser is attached for a page script");
    const code = /^\s*(async\s*)?\(/.test(way.code)
      ? way.code
      : `async (page, bu, inputs) => { ${way.code}\n return inputs; }`;
    return host.script(code, {
      inputs,
      ...((way.input && typeof way.input === "object" ? way.input : {}) as Record<string, unknown>),
    });
  }
  return runNodeScript(
    way.code,
    inputs,
    host.call ?? (async (operation, params) => handleCall(ability.site, operation, params)),
  );
}

async function runNodeScript(
  code: string,
  inputs: Record<string, unknown>,
  call: (operation: string, params: Record<string, unknown>) => Promise<unknown>,
): Promise<unknown> {
  const context = vm.createContext({
    siteMapper: { call, write: call },
    browser: { fetch: (url: string, options: RequestInit = {}) => fetch(url, options) },
    inputs,
    args: inputs,
  });
  const result = new vm.Script(`(async () => { ${code}\n })()`, {
    filename: "ability.js",
  }).runInContext(context, { timeout: 30_000 }) as Promise<unknown>;
  return Promise.race([
    result,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("ABILITY_TIMEOUT: node script exceeded 30s")), 30_000),
    ),
  ]);
}

async function handleCall(
  site: string,
  operation: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  const { handleSiteMapperRequest } = await import("./requests.js");
  return handleSiteMapperRequest({ siteMapper: "call", site, operation, params });
}

function defaultHost(site: string): AbilityHost {
  return {
    call: (operation, params) => handleCall(site, operation, params),
    write: (operation, params) => handleCall(site, operation, params),
  };
}

async function recordAbilityRun(ability: Ability, ok: boolean): Promise<void> {
  const now = new Date().toISOString();
  const next: Ability = {
    ...ability,
    stats: {
      runs: ability.stats.runs + 1,
      failures: ok ? 0 : ability.stats.failures + 1,
      ...(ok
        ? { lastOkAt: now }
        : ability.stats.lastOkAt
          ? { lastOkAt: ability.stats.lastOkAt }
          : {}),
      lastUsedAt: now,
    },
    updatedAt: now,
  };
  await saveAbility(next);
}

function fill(value: unknown, inputs: Record<string, unknown>, steps: unknown[] = []): unknown {
  if (typeof value === "string") {
    const whole = /^\{\{\s*([^{}]+?)\s*\}\}$/.exec(value);
    if (whole) return lookup(whole[1] ?? "", inputs, steps);
    return value.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (_, path: string) =>
      String(lookup(path, inputs, steps) ?? ""),
    );
  }
  if (Array.isArray(value)) return value.map((item) => fill(item, inputs, steps));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, fill(item, inputs, steps)]),
    );
  return value;
}

function lookup(path: string, inputs: Record<string, unknown>, steps: unknown[]): unknown {
  const [head = "", ...rest] = path.split(".");
  let value: unknown =
    head === "inputs"
      ? inputs
      : head === "last"
        ? steps[steps.length - 1]
        : head === "steps"
          ? steps
          : undefined;
  for (const key of rest) value = (value as Record<string, unknown> | undefined)?.[key];
  return value;
}

export async function readSiteNotes(site: string): Promise<string> {
  try {
    return await readFile(join(siteDir(siteName(site)), NOTES), "utf8");
  } catch {
    return "";
  }
}

export async function writeSiteNotes(
  site: string,
  markdown: string,
  options: { append?: boolean } = {},
): Promise<string> {
  const folder = siteDir(siteName(site));
  await mkdir(folder, { recursive: true });
  const path = join(folder, NOTES);
  const text = options.append
    ? [await readSiteNotes(site), markdown.trim()].filter(Boolean).join("\n\n") + "\n"
    : markdown.trim() + "\n";
  await writeFile(path, text, "utf8");
  return path;
}

function validAbilityName(name: string): string {
  if (!NAME.test(name.trim())) throw new Error(`INVALID_ABILITY_NAME: ${name}`);
  return name.trim();
}

function validateAbility(ability: Ability): void {
  if (!ability.ways.length) throw new Error(`ABILITY_NO_WAYS: ${ability.name}`);
  for (const way of ability.ways) {
    if (!["api", "steps", "script", "page"].includes(way.kind))
      throw new Error(`ABILITY_BAD_WAY: ${ability.name}`);
    if (way.kind === "script" && (!way.code || !["node", "page"].includes(way.runtime)))
      throw new Error(`ABILITY_BAD_SCRIPT: ${ability.name}`);
  }
}
