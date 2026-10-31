// One named thing doable on a site, read or write, with the ways to do it tried in order: the
// site's API, a replayed step list, code, or a page collector. Abilities replace the old recipe,
// action, workflow, skill and site-tool stores; notes.md holds what is not callable.

import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { needsError } from "./ability-needs.js";
import { join } from "node:path";
import { runNodeScript } from "./ability-node.js";
import {
  contractBreaks,
  contractWarnings,
  testAbilityCases,
  unusedInputs,
  type AbilityTest,
  type AbilityTestReport,
} from "./ability-contract.js";
import {
  assertInputsApplied,
  pageRows,
  readRecords,
  rowsOf,
  usesRecordRuntime,
  type AbilityCheck,
  type AbilityPage,
} from "./ability-records.js";
import {
  AbilityWriteError,
  answerRepeat,
  classifyFailure,
  findWriteKey,
  readBack,
  recordWriteKey,
  writeKey,
  type ReadBack,
  type WriteOutcome,
} from "./ability-writes.js";
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
  /** Write abilities: index of the operation that applies the change (default: the last). */
  commit?: number;
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
  /** Rules a read's rows must satisfy when the caller passed the input. */
  checks?: AbilityCheck[];
  /** Write abilities: a read run afterwards to confirm the change. */
  readBack?: ReadBack;
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
  /** JSON Schema of the result (its properties are the fields callers may rely on). */
  outputs?: Record<string, unknown>;
  ways: AbilityWay[];
  /** Cases `testAbility` runs: inputs and values the result must contain. */
  tests?: AbilityTest[];
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
  /** Writes: how the call left the site, and the key it ran under. */
  write?: Partial<WriteOutcome> & { key?: string; replayed?: boolean };
  /** Writes with readBack: whether the site shows the change. */
  readBack?: { ok: boolean; missing: string[] };
}

export interface AbilityRunOptions {
  via?: AbilityVia;
  host?: AbilityHost;
  /** Writes: the same key never applies twice (kept a day). */
  key?: string;
  /** Lists: rows per page; the result becomes {items, next_cursor, has_more}. */
  limit?: number;
  /** Lists: next_cursor from the previous page. */
  cursor?: string;
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

export interface SaveAbilityOptions {
  replace?: boolean;
  /** Allow a replacement that drops or retypes an input, or drops an output field. */
  breaking?: boolean;
  /** Skip the caller-contract checks (run stats and migrations). */
  check?: boolean;
}

export async function saveAbility(
  ability: Ability,
  options: SaveAbilityOptions = {},
): Promise<{
  ability: Ability;
  path: string;
  warnings: string[];
}> {
  const site = siteName(ability.site);
  const name = validAbilityName(ability.name);
  validateAbility({ ...ability, name, site });
  await mkdir(abilityDirectory(site), { recursive: true });
  const path = join(abilityDirectory(site), abilitySlug(name) + ".json");
  const existing = await readAbilityFile(path);
  if (existing && options.replace === false)
    throw new Error(`ABILITY_EXISTS: ${site} already has ${name}`);
  if (options.check !== false) checkContract(ability, existing, options);
  const next: Ability = {
    ...ability,
    name,
    site,
    stats: ability.stats ?? { runs: 0, failures: 0 },
    createdAt: ability.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  await writeAtomic(path, JSON.stringify(next, null, 2) + "\n");
  return { ability: next, path, warnings: options.check === false ? [] : contractWarnings(next) };
}

function checkContract(
  ability: Ability,
  existing: Ability | undefined,
  options: SaveAbilityOptions,
): void {
  if (ability.createdBy === "agent") {
    const unused = unusedInputs(ability);
    if (unused.length)
      throw new Error(
        `ABILITY_INPUT_UNUSED: ${ability.name} declares ${unused.join(", ")} but no way uses it; ` +
          'use it, drop it, or say "By design:" in its description',
      );
  }
  if (!existing || options.breaking) return;
  const breaks = contractBreaks(existing, ability);
  if (breaks.length)
    throw new Error(
      `ABILITY_CONTRACT_WEAKENED: ${ability.name}: ${breaks.join("; ")}. Callers rely on these; ` +
        "keep them, save under a new name, or pass breaking: true",
    );
}

export async function createAbility(
  ability: Omit<Ability, "name" | "site" | "stats" | "createdAt" | "updatedAt"> & {
    name: string;
    site: string;
  },
): Promise<{ ability: Ability; path: string; warnings: string[] }> {
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
  options: AbilityRunOptions = {},
): Promise<AbilityRunResult> {
  const ability = await readAbility(site, name);
  if (!ability) throw new Error(`ABILITY_UNKNOWN: ${siteName(site)} has no ability ${name}`);
  const host = options.host ?? defaultHost(site);
  if (ability.kind === "write") return runWrite(ability, inputs, host, options);
  const run = await runRead(ability, inputs, host, options);
  assertInputsApplied(ability, inputs, run.result);
  await recordAbilityRun(ability, true);
  if (options.limit === undefined && options.cursor === undefined) return run;
  return { ...run, result: pageOf(ability, run.result, options) };
}

function pageOf(ability: Ability, result: unknown, options: AbilityRunOptions): AbilityPage {
  const key = (ability.options.recordMapping as { key?: string } | undefined)?.key;
  return pageRows(rowsOf(result) ?? [result], {
    ...(options.limit ? { limit: options.limit } : {}),
    ...(options.cursor ? { cursor: options.cursor } : {}),
    ...(key ? { key } : {}),
  });
}

/** Rows a first page needs from the site: the page plus one, to know whether more exist. */
function wantedRows(options: AbilityRunOptions): number | undefined {
  if (options.limit === undefined || options.cursor) return undefined;
  return options.limit + 1;
}

async function runRead(
  ability: Ability,
  inputs: Record<string, unknown>,
  host: AbilityHost,
  options: AbilityRunOptions,
): Promise<AbilityRunResult> {
  const tried: { via: AbilityVia; error: string }[] = [];
  let ways = ability.ways;
  if (usesRecordRuntime(ability) && options.via !== "script") {
    try {
      return { ...(await readRecords(ability, inputs, host, wantedRows(options))), tried };
    } catch (error) {
      tried.push({ via: "api", error: messageOf(error) });
      // The recipe runtime already tried every way it can run; node scripts remain.
      ways = ways.filter((way) => way.kind === "script" && way.runtime === "node");
    }
  }
  for (const way of ways) {
    if (options.via && way.kind !== options.via) continue;
    const unmet = needsError(way, host);
    if (unmet) {
      tried.push({ via: way.kind, error: unmet });
      continue;
    }
    try {
      return { result: await attemptWay(ability, way, inputs, host), via: way.kind, tried };
    } catch (error) {
      tried.push({ via: way.kind, error: messageOf(error) });
    }
  }
  await recordAbilityRun(ability, false);
  throw new Error(`ABILITY_FAILED: ${ability.site} ${ability.name} (${triedText(tried)})`);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function triedText(tried: { via: AbilityVia; error: string }[]): string {
  return tried.map((item) => `${item.via}: ${item.error}`).join("; ") || "no way matched";
}

/**
 * A write tries its ways in order only while nothing may have applied: once a way fails after its
 * commit step started, the runner stops and reports it instead of trying again another way.
 */
async function runWrite(
  ability: Ability,
  inputs: Record<string, unknown>,
  host: AbilityHost,
  options: AbilityRunOptions,
): Promise<AbilityRunResult> {
  const key = writeKey(ability, inputs, options.key);
  const entry = key ? await findWriteKey(ability, key) : undefined;
  const repeat = key && entry ? answerRepeat(ability, key, entry) : undefined;
  if (repeat)
    return {
      result: repeat.result,
      via: "api",
      tried: [],
      write: { write_status: "applied", key, replayed: true },
    };
  const tried: { via: AbilityVia; error: string }[] = [];
  let last: WriteOutcome | undefined;
  for (const way of ability.ways) {
    if (options.via && way.kind !== options.via) continue;
    const unmet = needsError(way, host);
    if (unmet) {
      tried.push({ via: way.kind, error: unmet });
      continue;
    }
    const progress = { reachedCommit: way.kind !== "api" };
    try {
      const result = await attemptWay(ability, way, inputs, host, progress);
      return await appliedWrite(ability, inputs, host, { result, via: way.kind, tried }, key);
    } catch (error) {
      last = classifyFailure(error, progress.reachedCommit);
      tried.push({ via: way.kind, error: messageOf(error) });
      if (last.possible_commit) break;
    }
  }
  return failedWrite(ability, key, tried, last);
}

async function appliedWrite(
  ability: Ability,
  inputs: Record<string, unknown>,
  host: AbilityHost,
  run: AbilityRunResult,
  key: string | undefined,
): Promise<AbilityRunResult> {
  if (key) await recordWriteKey(ability, key, { write_status: "applied", result: run.result });
  await recordAbilityRun(ability, true);
  const rule = ability.options.readBack;
  const check = rule
    ? await readBack(
        rule,
        inputs,
        async (name, values) => (await runAbility(ability.site, name, values, { host })).result,
        fill,
      )
    : undefined;
  return {
    ...run,
    write: { write_status: "applied", possible_commit: true, ...(key ? { key } : {}) },
    ...(check ? { readBack: { ok: check.ok, missing: check.missing } } : {}),
  };
}

async function failedWrite(
  ability: Ability,
  key: string | undefined,
  tried: { via: AbilityVia; error: string }[],
  last: WriteOutcome | undefined,
): Promise<never> {
  await recordAbilityRun(ability, false);
  const outcome: WriteOutcome = last ?? {
    code: "execution_failed",
    write_status: "not_attempted",
    possible_commit: false,
    retry: "same_key",
  };
  if (key && outcome.possible_commit)
    await recordWriteKey(ability, key, { write_status: "may_have_applied" });
  throw new AbilityWriteError(
    `ABILITY_FAILED: ${ability.site} ${ability.name} (${triedText(tried)})`,
    outcome,
  );
}

/** Runs an ability's stored test cases and reports failures and constant output. */
export async function testAbility(
  site: string,
  name: string,
  options: { host?: AbilityHost } = {},
): Promise<AbilityTestReport> {
  const ability = await readAbility(site, name);
  if (!ability) throw new Error(`ABILITY_UNKNOWN: ${siteName(site)} has no ability ${name}`);
  if (ability.kind === "write")
    throw new Error(`ABILITY_TEST_WRITE: ${name} writes; its cases would change the site`);
  return testAbilityCases(
    ability,
    async (inputs) =>
      (await runAbility(site, name, inputs, options.host ? { host: options.host } : {})).result,
  );
}

async function attemptWay(
  ability: Ability,
  way: AbilityWay,
  inputs: Record<string, unknown>,
  host: AbilityHost,
  progress?: { reachedCommit: boolean },
): Promise<unknown> {
  if (way.kind === "api") return attemptApi(way, inputs, host, progress);
  if (way.kind === "steps") return attemptSteps(way, inputs, host);
  if (way.kind === "page") return attemptPage(way, inputs, host);
  return attemptScript(ability, way, inputs, host);
}

async function attemptApi(
  way: AbilityWayApi,
  inputs: Record<string, unknown>,
  host: AbilityHost,
  progress?: { reachedCommit: boolean },
): Promise<unknown> {
  const operations = apiOperations(way);
  if (!operations.length) throw new Error("API way has no operation");
  const call = host.write ?? host.call;
  if (!call) throw new Error("ABILITY_NEEDS: no site API transport");
  if (way.open) {
    if (!host.open) throw new Error("ABILITY_NEEDS: this host cannot open a page for that way");
    await host.open(String(fill(way.open, inputs)));
  }
  const stepResults: unknown[] = [];
  const commit = Math.min(way.commit ?? operations.length - 1, operations.length - 1);
  let result: unknown;
  for (const [index, step] of operations.entries()) {
    if (progress && index >= commit) progress.reachedCommit = true;
    result = await callApiStep(step, way, inputs, stepResults, call, host);
  }
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

async function handleCall(
  site: string,
  operation: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  const { handleSiteMapperRequest } = await import("./requests.js");
  return handleSiteMapperRequest({ siteMapper: "call", site, operation, params });
}

/** Site calls through the mapped runtime; page ways and page scripts in a browser tab on the site. */
function defaultHost(site: string): AbilityHost {
  const browser = once(async () => {
    const { browserRecipeHost } = await import("./runtime/recipe-host.js");
    return browserRecipeHost(site, { session: `ability-${siteName(site)}` });
  });
  return {
    call: (operation, params) => handleCall(site, operation, params),
    write: (operation, params) => handleCall(site, operation, params),
    open: async (url) => required(await browser(), "open")(url),
    collect: async (input) => required(await browser(), "collect")(input),
    script: async (code, input) => required(await browser(), "script")(onSite(site, code), input),
  };
}

/** Wraps a page script so it runs on a tab of its own site, opening one in the background if needed. */
function onSite(site: string, code: string): string {
  const host = siteName(site);
  return `async (page, bu, inputs) => {
  let tab = page;
  try { if (!tab || !new URL(await tab.url()).hostname.endsWith(${JSON.stringify(host)})) tab = undefined; } catch { tab = undefined; }
  tab ??= await browser.openTab(${JSON.stringify(`https://${host}/`)}, { active: false });
  return await (${code})(tab, bu, inputs);
}`;
}

function required<K extends "open" | "collect" | "script">(
  host: AbilityHost,
  name: K,
): NonNullable<AbilityHost[K]> {
  const run = host[name];
  if (!run) throw new Error(`ABILITY_NEEDS: the browser host has no ${name}`);
  return run as NonNullable<AbilityHost[K]>;
}

function once<T>(make: () => Promise<T>): () => Promise<T> {
  let value: Promise<T> | undefined;
  return () => (value ??= make());
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
  await saveAbility(next, { check: false });
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
