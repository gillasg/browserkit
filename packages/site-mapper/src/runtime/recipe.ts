// Runs a site recipe: resolves parameters, tries its strategies in order (site API, then page
// collect, then a script), pages a cursor API, maps and filters records, and keeps write receipts
// so a repeat is a no-op. The host supplies the four touch points (call, write, collect, script),
// so the same runtime works from the CLI, an MCP session or Aeon's daemon.

import {
  findReceipt,
  recordRecipeHealth,
  writeReceipt,
  type CollectRecipe,
  type RecipePagination,
  type RecipeParam,
  type RecipeStrategy,
  type SiteRecipe,
} from "../recipes.js";
import { mapRecords, matchesFilters, recordKey } from "../recipe-map.js";
import type { SiteModel } from "../types.js";

/** A strategy that cannot run here (no browser for collect, site not mapped): try the next one. */
export class RecipeSkip extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RecipeSkip";
  }
}

export class RecipeError extends Error {
  constructor(
    message: string,
    readonly attempts: StrategyAttempt[],
  ) {
    super(message);
    this.name = "RecipeError";
  }
}

export interface RecipeHost {
  /** One mapped-site API call. */
  call(operation: string, params: Record<string, unknown>): Promise<unknown>;
  /** A write operation (receipts guard repeats). */
  write?: (operation: string, params: Record<string, unknown>) => Promise<unknown>;
  /** Reads rows from the page (browser side). */
  collect?: (input: CollectRecipe & { url?: string }) => Promise<unknown>;
  /** Runs in-page code for a script strategy. */
  script?: (code: string, input: unknown) => Promise<unknown>;
  /** Maps a recipe's operation name onto a real operation id; returns undefined when absent. */
  resolveOperation?: (wanted: string) => string | undefined;
}

export interface RecipeRunOptions {
  site: string;
  recipe: SiteRecipe;
  inputs?: Record<string, unknown>;
  host: RecipeHost;
  /** Hard cap on returned records. */
  limit?: number;
  /** Overrides the recipe's maxPages. */
  maxPages?: number;
  /** Set false to skip writing health into the site folder (tests, previews). */
  trackHealth?: boolean;
}

export interface StrategyAttempt {
  strategy: string;
  error?: string;
  skipped?: boolean;
}

export interface RecipeRunResult {
  site: string;
  recipe: string;
  records: Record<string, unknown>[];
  count: number;
  strategy?: string;
  pages: number;
  attempts: StrategyAttempt[];
  truncated: boolean;
  /** A write recipe that had already been run for this key. */
  receipt?: { at: string; skipped: true };
}

export async function runRecipe(options: RecipeRunOptions): Promise<RecipeRunResult> {
  const { site, recipe, host } = options;
  const inputs = resolveParams(recipe.params ?? {}, options.inputs ?? {});
  const maxPages = Math.max(1, options.maxPages ?? maxPageSetting(recipe));
  const limit = options.limit ?? recipe.limit ?? 500;

  if (recipe.write) return runWrite(options, inputs);

  const attempts: StrategyAttempt[] = [];
  for (const strategy of recipe.strategies) {
    try {
      const raw = await collectWith(strategy, inputs, host, maxPages);
      const records = finish(raw.items, recipe, limit);
      await health(site, recipe, { ok: true, strategy: strategy.kind }, options);
      return {
        site,
        recipe: recipe.name,
        records,
        count: records.length,
        strategy: strategy.kind,
        pages: raw.pages,
        attempts,
        truncated: raw.truncated,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      attempts.push(
        error instanceof RecipeSkip
          ? { strategy: strategy.kind, error: message, skipped: true }
          : { strategy: strategy.kind, error: message },
      );
    }
  }
  const detail = attempts.map((item) => `${item.strategy}: ${item.error}`).join("; ");
  await health(site, recipe, { ok: false, error: detail }, options);
  throw new RecipeError(
    `Recipe ${recipe.name} on ${site} could not fetch records (${detail})`,
    attempts,
  );
}

async function health(
  site: string,
  recipe: SiteRecipe,
  outcome: { ok: boolean; strategy?: string; error?: string },
  options: RecipeRunOptions,
): Promise<void> {
  if (options.trackHealth === false) return;
  await recordRecipeHealth(site, recipe.name, outcome);
}

async function runWrite(
  options: RecipeRunOptions,
  inputs: Record<string, unknown>,
): Promise<RecipeRunResult> {
  const { site, recipe, host } = options;
  const write = recipe.write;
  if (!write) throw new Error("runWrite called without a write recipe");
  if (!host.write)
    throw new RecipeError(`Recipe ${recipe.name} writes but the host cannot write`, [
      { strategy: "write", error: "no write transport" },
    ]);
  const key = recordKey(inputs);
  const existing = await findReceipt(site, recipe.name, key, write.ttlDays ?? 0);
  if (existing)
    return {
      site,
      recipe: recipe.name,
      records: [],
      count: 0,
      pages: 1,
      attempts: [],
      truncated: false,
      receipt: { at: existing.at, skipped: true },
    };
  const operation = write.operation ?? firstApiOperation(recipe);
  if (!operation)
    throw new RecipeError(`Recipe ${recipe.name} has no write operation`, [
      { strategy: "write", error: "missing operation" },
    ]);
  const response = await host.write(operation, inputs);
  await writeReceipt(site, recipe.name, key, response);
  await health(site, recipe, { ok: true, strategy: "write" }, options);
  return {
    site,
    recipe: recipe.name,
    records: [],
    count: 0,
    strategy: "write",
    pages: 1,
    attempts: [],
    truncated: false,
  };
}

function firstApiOperation(recipe: SiteRecipe): string | undefined {
  for (const strategy of recipe.strategies) if (strategy.kind === "api") return strategy.operation;
  return undefined;
}

interface Collected {
  items: unknown[];
  pages: number;
  truncated: boolean;
}

async function collectWith(
  strategy: RecipeStrategy,
  inputs: Record<string, unknown>,
  host: RecipeHost,
  maxPages: number,
): Promise<Collected> {
  switch (strategy.kind) {
    case "api":
      return collectApi(strategy, inputs, host, maxPages);
    case "collect":
      return collectRows(strategy, inputs, host);
    case "script":
      return collectScript(strategy, inputs, host);
  }
}

async function collectRows(
  strategy: Extract<RecipeStrategy, { kind: "collect" }>,
  inputs: Record<string, unknown>,
  host: RecipeHost,
): Promise<Collected> {
  if (!host.collect) throw new RecipeSkip("No browser is attached for a collect strategy");
  const url = strategy.collect.url === undefined ? undefined : fill(strategy.collect.url, inputs);
  const items = await host.collect({ ...strategy.collect, ...(url ? { url } : {}) });
  if (!Array.isArray(items)) throw new Error("collect returned no rows");
  return { items, pages: 1, truncated: false };
}

async function collectScript(
  strategy: Extract<RecipeStrategy, { kind: "script" }>,
  inputs: Record<string, unknown>,
  host: RecipeHost,
): Promise<Collected> {
  if (!host.script) throw new RecipeSkip("No browser is attached for a script strategy");
  const extra =
    strategy.input && typeof strategy.input === "object" && !Array.isArray(strategy.input)
      ? strategy.input
      : {};
  const value = await host.script(strategy.code, { inputs, ...extra });
  const items = Array.isArray(value) ? value : value && typeof value === "object" ? [value] : [];
  if (!items.length) throw new Error("script returned nothing");
  return { items, pages: 1, truncated: false };
}

async function collectApi(
  strategy: Extract<RecipeStrategy, { kind: "api" }>,
  inputs: Record<string, unknown>,
  host: RecipeHost,
  maxPages: number,
): Promise<Collected> {
  const operation = host.resolveOperation
    ? host.resolveOperation(strategy.operation)
    : strategy.operation;
  if (!operation)
    throw new RecipeSkip(`Site has no operation matching ${JSON.stringify(strategy.operation)}`);
  const params = apiParams(strategy, inputs);
  const pagination = strategy.pagination;
  const items: unknown[] = [];
  let pages = 0;
  let cursor: unknown;
  while (pages < maxPages) {
    const page = await host.call(operation, params);
    pages += 1;
    items.push(...itemsOf(page, pagination));
    const next = pagination ? advanceCursor(page, pagination, cursor) : undefined;
    if (next === undefined || !pagination) break;
    cursor = next;
    params[pagination.param] = next;
    if (pagination.limitParam && pagination.pageSize)
      params[pagination.limitParam] = pagination.pageSize;
  }
  return { items, pages, truncated: pages >= maxPages };
}

/** The next cursor, or undefined when this page was the last. */
function advanceCursor(page: unknown, pagination: RecipePagination, cursor: unknown): unknown {
  const next = cursorValue(page, pagination.next);
  const more = pagination.hasMore ? cursorValue(page, pagination.hasMore) : true;
  if (next === undefined || next === null || next === "" || more === false) return undefined;
  if (next === cursor) return undefined;
  return next;
}

function apiParams(
  strategy: Extract<RecipeStrategy, { kind: "api" }>,
  inputs: Record<string, unknown>,
): Record<string, unknown> {
  const params: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(strategy.params ?? {}))
    params[key] = typeof value === "string" ? fill(value, inputs) : value;
  for (const [key, value] of Object.entries(inputs)) if (!(key in params)) params[key] = value;
  if (strategy.pagination?.limitParam && strategy.pagination.pageSize)
    params[strategy.pagination.limitParam] = strategy.pagination.pageSize;
  return params;
}

function itemsOf(page: unknown, pagination: RecipePagination | undefined): unknown[] {
  const explicit = pagination?.items ? walk(page, pagination.items) : undefined;
  const found = explicit ?? biggestList(page);
  if (Array.isArray(found)) return found;
  if (found === undefined) return Array.isArray(page) ? page : [];
  return [found];
}

/** Reads a pointer, falling back to the last path key (X-style instruction trees move levels). */
function walk(value: unknown, pointer: string): unknown {
  const direct = pick(value, pointer);
  if (direct !== undefined && direct !== null) return direct;
  const last = pointer.split("/").filter(Boolean).at(-1);
  return last ? findKey(value, last) : undefined;
}

function pick(value: unknown, pointer: string): unknown {
  if (!pointer) return value;
  const parts = pointer.replace(/^\//, "").split("/");
  let current: unknown = value;
  for (const part of parts) {
    if (current == null) return undefined;
    current = Array.isArray(current)
      ? current[Number(part)]
      : (current as Record<string, unknown>)[part];
  }
  return current;
}

function findKey(value: unknown, key: string, depth = 0): unknown {
  if (!value || typeof value !== "object" || depth > 6) return undefined;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findKey(item, key, depth + 1);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (key in record) return record[key];
  for (const child of Object.values(record)) {
    const found = findKey(child, key, depth + 1);
    if (found !== undefined) return found;
  }
  return undefined;
}

function biggestList(value: unknown, depth = 0): unknown {
  if (!value || typeof value !== "object" || depth > 6) return undefined;
  if (Array.isArray(value)) {
    const objects = value.filter(
      (item) => item && typeof item === "object" && !Array.isArray(item),
    );
    return objects.length ? value : undefined;
  }
  let best: unknown;
  let bestSize = 0;
  for (const child of Object.values(value as Record<string, unknown>)) {
    const found = biggestList(child, depth + 1);
    if (Array.isArray(found) && found.length > bestSize) {
      best = found;
      bestSize = found.length;
    }
  }
  return best;
}

function cursorValue(page: unknown, pointer: string): unknown {
  const value = walk(page, pointer);
  if (value && typeof value === "object" && "value" in (value as Record<string, unknown>))
    return (value as Record<string, unknown>).value;
  return value;
}

function finish(items: unknown[], recipe: SiteRecipe, limit: number): Record<string, unknown>[] {
  const mapped = mapRecords(items, recipe.map);
  const kept = mapped.filter((record) => matchesFilters(record, recipe.filter));
  const seen = new Set<string>();
  const unique: Record<string, unknown>[] = [];
  for (const record of kept) {
    const key = recordKey(record, recipe.key);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(record);
    if (unique.length >= limit) break;
  }
  return recipe.kind === "single" ? unique.slice(0, 1) : unique;
}

function maxPageSetting(recipe: SiteRecipe): number {
  for (const strategy of recipe.strategies)
    if (strategy.kind === "api" && strategy.pagination?.maxPages)
      return strategy.pagination.maxPages;
  return 20;
}

function fill(text: string, inputs: Record<string, unknown>): string {
  return text.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, path: string) => {
    const value = pick(inputs, path);
    return value === undefined || value === null ? "" : String(value);
  });
}

export function resolveParams(
  declared: Record<string, RecipeParam>,
  given: Record<string, unknown>,
): Record<string, unknown> {
  const resolved: Record<string, unknown> = {};
  for (const [name, spec] of Object.entries(declared)) {
    const value = given[name];
    if (value === undefined) {
      if (spec.default !== undefined) resolved[name] = spec.default;
      else if (spec.required) throw new Error(`Missing required input ${JSON.stringify(name)}`);
      continue;
    }
    if (spec.type === "number") resolved[name] = Number(value);
    else if (spec.type === "boolean") resolved[name] = value === true || value === "true";
    else resolved[name] = value;
  }
  // Undeclared inputs still flow through to API params: recipes often pass a site's own filters.
  for (const [name, value] of Object.entries(given))
    if (!(name in resolved)) resolved[name] = value;
  return resolved;
}

/** Resolves a recipe's operation name against a mapped site. */
export function resolveOperationInModel(model: SiteModel, wanted: string): string | undefined {
  const lower = wanted.toLowerCase();
  const match =
    model.operations.find((operation) => operation.id === wanted) ??
    model.operations.find((operation) => operation.id.toLowerCase().includes(lower)) ??
    model.operations.find((operation) => (operation.summary ?? "").toLowerCase().includes(lower)) ??
    model.operations.find((operation) =>
      operation.samples.some((sample) => sample.url.toLowerCase().includes(lower)),
    );
  return match?.id;
}

export interface FeedResult extends RecipeRunResult {
  markdown: string;
  jsonl: string;
}

/** A recipe read as a feed: records plus Markdown and JSONL for a chat or a file. */
export async function readFeed(
  options: RecipeRunOptions & { format?: "markdown" | "jsonl" },
): Promise<FeedResult> {
  const result = await runRecipe(options);
  const render = options.recipe.render ?? {};
  const blocks = result.records.map((record, index) => {
    const title = text(record, render.title) ?? `#${index + 1}`;
    const author = text(record, render.author);
    const date = text(record, render.date);
    const url = text(record, render.url);
    const body = text(record, render.text) ?? "";
    const meta = [author, date].filter(Boolean).join(" · ");
    return `## ${title}${meta ? `\n${meta}` : ""}${body ? `\n\n${body}` : ""}${url ? `\n\n${url}` : ""}`;
  });
  const markdown = `# ${options.recipe.description ?? options.recipe.name} (${result.count})\n\n${blocks.join("\n\n")}\n`;
  return {
    ...result,
    markdown,
    jsonl: result.records.map((record) => JSON.stringify(record)).join("\n"),
  };
}

function text(record: Record<string, unknown>, field: string | undefined): string | undefined {
  if (!field) return undefined;
  const value = record[field];
  if (value === undefined || value === null || value === "") return undefined;
  return String(value);
}
