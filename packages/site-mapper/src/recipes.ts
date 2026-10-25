// Site recipes: one site, one named way to fetch (or write) its data, stored inside the site's
// pack folder next to the mapped model. A recipe names ordered strategies (site API first, then
// page collect, then a script), how to page through a cursor API, how to map a raw record, and
// which records it produced. There is no second recipe system: a "playbook" is a recipe here.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { siteDir, siteName, writeAtomic } from "./registry.js";
import type { Json, JsonObject, Operation, SiteModel } from "./types.js";
import { pickPath } from "./recipe-map.js";

export interface RecipeParam {
  description?: string;
  required?: boolean;
  default?: Json;
  type?: "string" | "number" | "boolean";
}

export interface RecipePagination {
  /** Request parameter that carries the cursor. */
  param: string;
  /** Response pointer to the next cursor. */
  next: string;
  /** Response pointer to the items. Found automatically when absent. */
  items?: string;
  /** Response pointer that says whether more pages exist. */
  hasMore?: string;
  limitParam?: string;
  pageSize?: number;
  maxPages?: number;
}

export interface CollectRecipe {
  url?: string;
  /** CSS for one row. */
  row: string;
  /** Field name → CSS selector; an `@attr` suffix reads an attribute, `?` marks it optional. */
  fields: Record<string, string>;
  scroll?: boolean;
  expand?: string[];
  max?: number;
  idleRounds?: number;
}

export type RecipeStrategy =
  | {
      kind: "api";
      /** Operation id, or a distinctive part of it (resolved against the site's model). */
      operation: string;
      params?: JsonObject;
      pagination?: RecipePagination;
    }
  | { kind: "collect"; collect: CollectRecipe }
  | { kind: "script"; code: string; input?: Json };

export type RecipeFieldRule = import("./recipe-map.js").FieldRule;
export type RecipeFieldMapping = import("./recipe-map.js").FieldMapping;
export type RecipeFilter = import("./recipe-map.js").RecipeFilter;

export interface RecipeHealth {
  ok?: boolean;
  strategy?: string;
  at?: string;
  error?: string;
  failures: number;
}

export interface SiteRecipe {
  version: 1;
  name: string;
  site?: string;
  description?: string;
  /** items (default): a list of records; single: one record. */
  kind?: "items" | "single";
  params?: Record<string, RecipeParam>;
  /** Tried in order; the first that produces records wins. */
  strategies: RecipeStrategy[];
  map?: Record<string, RecipeFieldMapping>;
  /** Mapped field that identifies a record; defaults to id/url/key. */
  key?: string;
  filter?: RecipeFilter[];
  limit?: number;
  /** Write recipes: the operation to repeat and how a repeat is detected. */
  write?: { operation?: string; receipt?: "record" | "params"; ttlDays?: number };
  /** How a feed renders this recipe as Markdown. */
  render?: { title?: string; text?: string; author?: string; date?: string; url?: string };
  source?: {
    kind: "manual" | "recorded" | "activity";
    at?: string;
    flow?: string;
    operation?: string;
  };
  health?: RecipeHealth;
  createdAt: string;
  updatedAt: string;
}

export interface RecipeSummary {
  name: string;
  site: string;
  description?: string;
  kind: "items" | "single";
  strategies: string[];
  fields: string[];
  params: string[];
  health?: RecipeHealth;
  updatedAt: string;
}

interface RecipeFile {
  version: 1;
  recipes: SiteRecipe[];
}

const LIBRARY = "recipes.json";

function now(): string {
  return new Date().toISOString();
}

export async function listRecipes(site: string): Promise<RecipeSummary[]> {
  const file = await readRecipeFile(site);
  return file.recipes
    .map((recipe) => ({
      name: recipe.name,
      site: recipe.site ?? siteName(site),
      kind: recipe.kind ?? "items",
      strategies: recipe.strategies.map((strategy) => strategy.kind),
      fields: Object.keys(recipe.map ?? {}),
      params: Object.keys(recipe.params ?? {}),
      updatedAt: recipe.updatedAt,
      ...(recipe.description ? { description: recipe.description } : {}),
      ...(recipe.health ? { health: recipe.health } : {}),
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

export async function readRecipe(site: string, name: string): Promise<SiteRecipe | undefined> {
  const file = await readRecipeFile(site);
  return (
    file.recipes.find((recipe) => recipe.name === name) ??
    file.recipes.find((recipe) => recipe.name.toLowerCase() === name.toLowerCase())
  );
}

export async function saveRecipe(recipe: SiteRecipe): Promise<{ site: string; path: string }> {
  const site = siteName(recipe.site ?? "");
  if (!site) throw new Error("A recipe needs a site");
  const checked = validateRecipe({ ...recipe, site });
  const file = await readRecipeFile(site);
  const index = file.recipes.findIndex((item) => item.name === checked.name);
  const createdAt = index >= 0 ? (file.recipes[index]?.createdAt ?? now()) : now();
  const stored: SiteRecipe = {
    ...checked,
    createdAt,
    updatedAt: now(),
  };
  if (index >= 0) file.recipes[index] = stored;
  else file.recipes.push(stored);
  await mkdir(siteDir(site), { recursive: true });
  const path = join(siteDir(site), LIBRARY);
  await writeAtomic(path, JSON.stringify(file, null, 2) + "\n", 0o600);
  return { site, path };
}

export async function deleteRecipe(site: string, name: string): Promise<boolean> {
  const file = await readRecipeFile(site);
  const before = file.recipes.length;
  file.recipes = file.recipes.filter((recipe) => recipe.name !== name);
  if (file.recipes.length === before) return false;
  await writeAtomic(join(siteDir(site), LIBRARY), JSON.stringify(file, null, 2) + "\n", 0o600);
  return true;
}

export async function exportRecipes(
  site: string,
  out: string,
): Promise<{ site: string; out: string; count: number }> {
  const file = await readRecipeFile(site);
  await writeFile(out, JSON.stringify(file, null, 2) + "\n", "utf8");
  return { site: siteName(site), out, count: file.recipes.length };
}

export async function importRecipes(
  path: string,
  options: { site?: string } = {},
): Promise<SiteRecipe[]> {
  const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
  const recipes = recipesOf(parsed).map((recipe) =>
    validateRecipe({
      ...recipe,
      ...(options.site ? { site: siteName(options.site) } : {}),
    }),
  );
  for (const recipe of recipes) await saveRecipe(recipe);
  return recipes;
}

function recipesOf(value: unknown): SiteRecipe[] {
  if (Array.isArray(value)) return value as SiteRecipe[];
  if (value && typeof value === "object" && Array.isArray((value as RecipeFile).recipes))
    return (value as RecipeFile).recipes;
  throw new Error("A recipe file holds a recipe array or { version, recipes }");
}

async function readRecipeFile(site: string): Promise<RecipeFile> {
  try {
    const parsed = JSON.parse(await readFile(join(siteDir(site), LIBRARY), "utf8")) as RecipeFile;
    return { version: 1, recipes: Array.isArray(parsed.recipes) ? parsed.recipes : [] };
  } catch {
    return { version: 1, recipes: [] };
  }
}

/** Validates a recipe before it is saved or run. */
export function validateRecipe(value: unknown): SiteRecipe {
  if (!value || typeof value !== "object") throw new Error("A recipe must be an object");
  const recipe = value as SiteRecipe;
  if (typeof recipe.name !== "string" || !recipe.name.trim())
    throw new Error("A recipe needs a name");
  if (!Array.isArray(recipe.strategies) || recipe.strategies.length === 0)
    throw new Error(`Recipe ${recipe.name} needs at least one strategy`);
  recipe.strategies.forEach((strategy) => validateStrategy(recipe.name, strategy));
  const pagination = strategyPagination(recipe);
  if (pagination && (!pagination.param || !pagination.next))
    throw new Error(`Recipe ${recipe.name}: pagination needs param and next`);
  return { ...recipe, version: 1, createdAt: recipe.createdAt ?? now(), updatedAt: now() };
}

function validateStrategy(name: string, strategy: RecipeStrategy): void {
  if (!strategy || typeof strategy !== "object")
    throw new Error(`Recipe ${name} has an invalid strategy`);
  if (strategy.kind === "api" && !strategy.operation)
    throw new Error(`Recipe ${name}: an api strategy needs an operation`);
  if (strategy.kind === "collect" && !strategy.collect?.row)
    throw new Error(`Recipe ${name}: a collect strategy needs a row selector`);
  if (strategy.kind === "script" && !strategy.code)
    throw new Error(`Recipe ${name}: a script strategy needs code`);
}

function strategyPagination(recipe: SiteRecipe): RecipePagination | undefined {
  for (const strategy of recipe.strategies)
    if (strategy.kind === "api" && strategy.pagination) return strategy.pagination;
  return undefined;
}

export async function recordRecipeHealth(
  site: string,
  name: string,
  outcome: { ok: boolean; strategy?: string; error?: string },
): Promise<void> {
  const recipe = await readRecipe(site, name);
  if (!recipe) return;
  const failures = recipe.health?.failures ?? 0;
  await saveRecipe({
    ...recipe,
    health: {
      ok: outcome.ok,
      failures: outcome.ok ? 0 : failures + 1,
      at: now(),
      ...(outcome.strategy ? { strategy: outcome.strategy } : {}),
      ...(outcome.error ? { error: outcome.error } : {}),
    },
  });
}

/* ---------------------------------------------------------------- write receipts */

interface Receipt {
  at: string;
  response?: unknown;
}

type ReceiptFile = Record<string, Record<string, Receipt>>;

async function readReceipts(site: string): Promise<ReceiptFile> {
  try {
    return JSON.parse(await readFile(join(siteDir(site), "receipts.json"), "utf8")) as ReceiptFile;
  } catch {
    return {};
  }
}

export async function findReceipt(
  site: string,
  recipe: string,
  key: string,
  ttlDays = 0,
): Promise<Receipt | undefined> {
  const file = await readReceipts(site);
  const receipt = file[recipe]?.[key];
  if (!receipt) return undefined;
  if (ttlDays > 0) {
    const age = Date.now() - Date.parse(receipt.at);
    if (Number.isFinite(age) && age > ttlDays * 86_400_000) return undefined;
  }
  return receipt;
}

export async function writeReceipt(
  site: string,
  recipe: string,
  key: string,
  response?: unknown,
): Promise<void> {
  const file = await readReceipts(site);
  const entries = file[recipe] ?? {};
  entries[key] = { at: now(), ...(response === undefined ? {} : { response }) };
  // Keep the newest 5000 per recipe; a receipt is a guard against repeats, not an audit log.
  const keys = Object.keys(entries);
  if (keys.length > 5000)
    for (const stale of keys.sort().slice(0, keys.length - 5000)) delete entries[stale];
  file[recipe] = entries;
  await mkdir(siteDir(site), { recursive: true });
  await writeAtomic(join(siteDir(site), "receipts.json"), JSON.stringify(file, null, 2), 0o600);
}

/* ---------------------------------------------------------------- drafts from a mapped site */

/**
 * Drafts a recipe from a mapped operation and one of its recorded responses: items pointer,
 * cursor pagination, field mappings from the first record, and a write config for actions.
 */
export function draftRecipeFromModel(
  model: SiteModel,
  options: { operation?: string; name?: string } = {},
): SiteRecipe {
  const operation = chooseOperation(model, options.operation);
  const first = findItems(firstSampleBody(operation)).records[0];
  const mapped = draftMapping(first);
  const recipe: SiteRecipe = {
    version: 1,
    name:
      options.name ??
      `${slug(operation.summary ?? operation.id)}-${slug(operation.id)}`.slice(0, 60),
    description: `Records from ${operation.method} ${operation.path} on ${model.site}`,
    kind: "items",
    site: model.site,
    strategies: [{ kind: "api", operation: operation.id, ...draftPagination(operation) }],
    ...(Object.keys(mapped).length ? { map: mapped } : {}),
    source: { kind: "activity", at: now(), operation: operation.id },
    createdAt: now(),
    updatedAt: now(),
  };
  if (operation.role === "action") recipe.write = { operation: operation.id, receipt: "params" };
  return recipe;
}

function draftMapping(
  first: Record<string, unknown> | undefined,
): Record<string, RecipeFieldMapping> {
  const mapped: Record<string, RecipeFieldMapping> = {};
  for (const [field, path] of Object.entries(describeFields(first)).slice(0, 12))
    mapped[field] = path;
  return mapped;
}

function draftPagination(operation: Operation): { pagination?: RecipePagination } {
  const pagination = operation.pagination;
  if (pagination?.style !== "cursor" || !pagination.param || !pagination.nextPointer) return {};
  return {
    pagination: {
      param: pagination.param,
      next: pagination.nextPointer,
      ...(pagination.itemsPointer ? { items: pagination.itemsPointer } : {}),
      ...(pagination.hasMorePointer ? { hasMore: pagination.hasMorePointer } : {}),
      ...(pagination.limitParam ? { limitParam: pagination.limitParam } : {}),
    },
  };
}

function chooseOperation(model: SiteModel, wanted?: string): Operation {
  const reads = model.operations.filter((operation) => operation.role === "read");
  if (wanted) {
    const match = model.operations.find(
      (operation) =>
        operation.id === wanted ||
        operation.id.toLowerCase().includes(wanted.toLowerCase()) ||
        (operation.summary ?? "").toLowerCase().includes(wanted.toLowerCase()),
    );
    if (match) return match;
    throw new Error(`No operation matching ${JSON.stringify(wanted)} in ${model.site}`);
  }
  const withItems = reads.find((operation) => operation.capabilities?.includes("list"));
  const withSample = reads.find((operation) =>
    operation.samples.some((sample) => sample.responseBody),
  );
  const chosen = withItems ?? withSample ?? reads[0];
  if (!chosen) throw new Error(`${model.site} has no read operation to draft from`);
  return chosen;
}

function firstSampleBody(operation: Operation): Json | undefined {
  for (const sample of operation.samples) {
    if (!sample.responseBody) continue;
    try {
      return JSON.parse(sample.responseBody) as Json;
    } catch {
      continue;
    }
  }
  return undefined;
}

interface ItemsFound {
  pointer?: string;
  records: Record<string, unknown>[];
}

/** The biggest array of objects in a response, preferring names an API uses for lists. */
function findItems(value: Json | undefined): ItemsFound {
  let best: ItemsFound = { records: [] };
  const visit = (node: Json | undefined, pointer: string, depth: number): void => {
    if (!node || typeof node !== "object" || depth > 6) return;
    if (Array.isArray(node)) {
      const records = node.filter(
        (item) => !!item && typeof item === "object" && !Array.isArray(item),
      ) as Record<string, unknown>[];
      const bonus = /(items|results|data|list|entries|edges|tweets|posts)$/i.test(pointer) ? 1 : 0;
      const score = records.length * 10 + bonus * 5 - depth;
      const bestScore = best.records.length * 10;
      if (records.length && score >= bestScore) best = { pointer, records };
      return;
    }
    for (const [key, child] of Object.entries(node)) visit(child, `${pointer}/${key}`, depth + 1);
  };
  visit(value, "", 0);
  return best;
}

function isScalar(value: unknown): boolean {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

function describeFields(record: Record<string, unknown> | undefined): Record<string, string> {
  if (!record) return {};
  const fields: Record<string, string> = {};
  for (const [key, value] of Object.entries(record)) {
    if (isScalar(value)) fields[key] = key;
    else if (value && typeof value === "object" && !Array.isArray(value))
      nestedFields(fields, key, value);
  }
  return fields;
}

function nestedFields(fields: Record<string, string>, key: string, value: object): void {
  for (const [inner, nested] of Object.entries(value as Record<string, unknown>))
    if (typeof nested === "string" || typeof nested === "number")
      fields[`${key}_${inner}`] = `${key}.${inner}`;
}

function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/* ---------------------------------------------------------------- built-in packs */

const X_SITES = new Set(["x.com", "twitter.com", "mobile.twitter.com"]);

function xRecipe(name: "thread" | "feed"): SiteRecipe {
  const stamp = now();
  const collect: RecipeStrategy = {
    kind: "collect",
    collect: {
      row: 'article[data-testid="tweet"]',
      fields: {
        url: "a[href*='/status/']@href",
        author: "[data-testid='User-Name']",
        text: "[data-testid='tweetText']",
        time: "time@datetime",
      },
      scroll: true,
      expand: ["Show more replies", "Show additional replies", "Read more"],
      max: name === "thread" ? 300 : 100,
    },
  };
  return {
    version: 1,
    name,
    site: "x.com",
    description:
      name === "thread"
        ? "Every post in a thread, in order, with author and time."
        : "The posts currently in the home feed, newest first.",
    kind: "items",
    params:
      name === "thread"
        ? { url: { description: "A post URL to read the thread from", required: true } }
        : { url: { description: "The feed URL to read", default: "https://x.com/home" } },
    strategies: [
      // A mapped x.com has TweetDetail/HomeTimeline operations; the runner skips this strategy
      // when the site is not mapped and falls through to the page when a call is refused.
      {
        kind: "api",
        operation: name === "thread" ? "TweetDetail" : "HomeTimeline",
        params: {},
      },
      collect,
    ],
    map: {
      id: { path: ["url"], pattern: "/status/(\\d+)", group: 1 },
      url: { path: ["url"], required: true },
      author: { path: ["author", "author.name", "user.name"] },
      text: { path: ["text", "text.text", "full_text"] },
      date: { path: ["time", "date"], transform: "iso" },
    },
    key: "id",
    render: { title: "author", text: "text", author: "author", date: "date", url: "url" },
    source: { kind: "manual", at: stamp },
    createdAt: stamp,
    updatedAt: stamp,
  };
}

/** Built-in recipes installed for a site, when it has one. */
export function builtinRecipes(site: string): SiteRecipe[] {
  return X_SITES.has(siteName(site)) ? [xRecipe("thread"), xRecipe("feed")] : [];
}

/** Writes the built-in recipes for a site, keeping existing ones with the same name untouched. */
export async function installBuiltinRecipes(site: string): Promise<SiteRecipe[]> {
  const installed: SiteRecipe[] = [];
  for (const recipe of builtinRecipes(site)) {
    if (await readRecipe(site, recipe.name)) continue;
    await saveRecipe(recipe);
    installed.push(recipe);
  }
  return installed;
}

/** A short, safe summary of a raw payload for diagnostics. */
export function payloadShape(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return `array(${value.length})`;
  if (typeof value === "object")
    return `object(${Object.keys(value as object)
      .slice(0, 6)
      .join(",")})`;
  return typeof value;
}

export { pickPath };
