// Runs a site recipe: resolves parameters, tries its strategies in order (site API, then page
// collect, then a script), pages a cursor API, maps and filters records, and keeps write receipts
// so a repeat is a no-op. The host supplies the four touch points (call, write, collect, script),
// so the same runtime works from the CLI, an MCP session or Aeon's daemon.

import {
  findReceipt,
  recordRecipeHealth,
  writeReceipt,
  type CollectRecipe,
  type CursorSelector,
  type RecipePagination,
  type RecipeParam,
  type RecipeStrategy,
  type SiteRecipe,
} from "../recipes.js";
import { mapRecords, matchesFilters, pickPath, recordKey } from "../recipe-map.js";
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
  /** Opens a page before an API call that must come from it (best effort). */
  open?: (url: string) => Promise<void>;
  /** Reads rows from the page (browser side). */
  collect?: (input: CollectRecipe & { url?: string }) => Promise<unknown>;
  /** Runs in-page code for a script strategy. */
  script?: (code: string, input: unknown) => Promise<unknown>;
  /** Runs a workflow (by name or inline) and returns its records. */
  workflow?: (input: {
    name?: string;
    workflow?: unknown;
    inputs: Record<string, unknown>;
  }) => Promise<unknown>;
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
  const inputs = deriveInputs(recipe, resolveParams(recipe.params ?? {}, options.inputs ?? {}));
  const maxPages = Math.max(1, options.maxPages ?? maxPageSetting(recipe));
  const limit = options.limit ?? recipe.limit ?? 500;

  if (recipe.write) return runWrite(options, inputs);

  const attempts: StrategyAttempt[] = [];
  for (const strategy of recipe.strategies) {
    try {
      const raw = await collectWith(strategy, inputs, host, maxPages, wantedRows(recipe, limit));
      const records = finish(raw.items, recipe, limit, inputs);
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

/** Computes values a recipe derives from its inputs, such as a post id from a URL. */
function deriveInputs(
  recipe: SiteRecipe,
  inputs: Record<string, unknown>,
): Record<string, unknown> {
  for (const [name, rule] of Object.entries(recipe.derive ?? {})) {
    const source = inputs[rule.from];
    if (source === undefined || source === null) continue;
    const match = new RegExp(rule.pattern, rule.flags ?? "").exec(String(source));
    if (match) inputs[name] = match[rule.group ?? 1] ?? match[0];
  }
  return inputs;
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

/** Rows worth fetching: past the limit only when filters or threading may drop some. */
function wantedRows(recipe: SiteRecipe, limit: number): number {
  return recipe.filter?.length || recipe.thread ? Infinity : limit;
}

async function collectWith(
  strategy: RecipeStrategy,
  inputs: Record<string, unknown>,
  host: RecipeHost,
  maxPages: number,
  wanted = Infinity,
): Promise<Collected> {
  switch (strategy.kind) {
    case "api":
      return collectApi(strategy, inputs, host, maxPages, wanted);
    case "collect":
      return collectRows(strategy, inputs, host, wanted);
    case "script":
      return collectScript(strategy, inputs, host);
    case "workflow":
      return collectWorkflow(strategy, inputs, host);
  }
}

/**
 * A recipe strategy that is a workflow. The workflow engine runs it; the recipe keeps the
 * pagination, mapping and filters around it, so one flow serves both a workflow run and the
 * recipe CLI.
 */
async function collectWorkflow(
  strategy: Extract<RecipeStrategy, { kind: "workflow" }>,
  inputs: Record<string, unknown>,
  host: RecipeHost,
): Promise<Collected> {
  if (!host.workflow)
    throw new RecipeSkip("No workflow engine is attached for a workflow strategy");
  const params = strategy.params ? JSON.parse(fill(JSON.stringify(strategy.params), inputs)) : {};
  const result = await host.workflow({
    ...(strategy.name ? { name: strategy.name } : {}),
    ...(strategy.workflow ? { workflow: strategy.workflow } : {}),
    inputs: { ...inputs, ...(params as Record<string, unknown>) },
  });
  const items = workflowRecords(result, strategy.records?.find.exists);
  if (!Array.isArray(items)) throw new Error("workflow returned no records");
  return { items, pages: 1, truncated: false };
}

/** The records a workflow returned: an array, {records}, a run record, or its last step. */
function workflowRecords(value: unknown, keys?: string[]): unknown[] {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== "object") return [];
  const record = value as Record<string, unknown>;
  if (Array.isArray(record.records)) return record.records;
  if (record.value !== undefined && record.value !== value)
    return workflowRecords(record.value, keys);
  const last = lastStepResult(record);
  if (last !== undefined) return workflowRecords(last, keys);
  if (keys?.length) return findRecords(value, keys);
  return [];
}

/** The result of the last step of a run record, if this is one. */
function lastStepResult(record: Record<string, unknown>): unknown {
  if (!Array.isArray(record.steps) || !record.steps.length) return undefined;
  const last = record.steps[record.steps.length - 1] as Record<string, unknown> | undefined;
  return last?.result ?? last;
}

async function collectRows(
  strategy: Extract<RecipeStrategy, { kind: "collect" }>,
  inputs: Record<string, unknown>,
  host: RecipeHost,
  wanted = Infinity,
): Promise<Collected> {
  if (!host.collect) throw new RecipeSkip("No browser is attached for a collect strategy");
  const url = strategy.collect.url === undefined ? undefined : fill(strategy.collect.url, inputs);
  // Rows past the wanted count are never read, so per-row detail work stops there too.
  const max = Number.isFinite(wanted)
    ? Math.min(strategy.collect.max ?? wanted, wanted)
    : undefined;
  const items = await host.collect({
    ...strategy.collect,
    ...(url ? { url } : {}),
    ...(max ? { max } : {}),
  });
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

/** The real operation id, after opening the page an API call must come from. */
async function prepareApi(
  strategy: Extract<RecipeStrategy, { kind: "api" }>,
  inputs: Record<string, unknown>,
  host: RecipeHost,
): Promise<string> {
  const operation = host.resolveOperation
    ? host.resolveOperation(strategy.operation)
    : strategy.operation;
  if (!operation)
    throw new RecipeSkip(`Site has no operation matching ${JSON.stringify(strategy.operation)}`);
  if (strategy.open && host.open) {
    // The page supplies the session and the signing hooks; a call that works without it survives.
    await host.open(fill(strategy.open, inputs)).catch(() => undefined);
  }
  return operation;
}

async function collectApi(
  strategy: Extract<RecipeStrategy, { kind: "api" }>,
  inputs: Record<string, unknown>,
  host: RecipeHost,
  maxPages: number,
  wanted = Infinity,
): Promise<Collected> {
  const operation = await prepareApi(strategy, inputs, host);
  const params = apiParams(strategy, inputs);
  const pagination = strategy.pagination;
  const items: unknown[] = [];
  let pages = 0;
  let cursor: unknown;
  while (pages < maxPages && items.length < wanted) {
    const page = await host.call(operation, params);
    pages += 1;
    items.push(...itemsOf(page, pagination, strategy.records?.find.exists));
    const next = pagination ? advanceCursor(page, pagination, cursor) : undefined;
    if (next === undefined || !pagination) break;
    cursor = next;
    setParam(params, pagination.param, next);
    if (pagination.limitParam && pagination.pageSize)
      setParam(params, pagination.limitParam, pagination.pageSize);
  }
  return { items, pages, truncated: pages >= maxPages && items.length < wanted };
}

/** "variables.cursor" sets a nested request parameter. */
function setParam(params: Record<string, unknown>, path: string, value: unknown): void {
  if (!path.includes(".")) {
    params[path] = value;
    return;
  }
  const parts = path.split(".");
  let current = params;
  for (const part of parts.slice(0, -1)) {
    const next = current[part];
    if (!next || typeof next !== "object" || Array.isArray(next)) current[part] = {};
    current = current[part] as Record<string, unknown>;
  }
  current[parts[parts.length - 1] ?? ""] = value;
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

function itemsOf(
  page: unknown,
  pagination: RecipePagination | undefined,
  find?: string[],
): unknown[] {
  if (find?.length) return findRecords(page, find);
  const explicit = pagination?.items ? walk(page, pagination.items) : undefined;
  const found = explicit ?? biggestList(page);
  if (Array.isArray(found)) return found;
  if (found === undefined) return Array.isArray(page) ? page : [];
  return [found];
}

/** Every object in a tree that carries all of these keys, in document order. */
function findRecords(value: unknown, keys: string[], depth = 0, found: unknown[] = []): unknown[] {
  if (found.length >= 5000 || depth > 24 || !value || typeof value !== "object") return found;
  if (Array.isArray(value)) {
    for (const item of value) findRecords(item, keys, depth + 1, found);
    return found;
  }
  const record = value as Record<string, unknown>;
  if (keys.every((key) => pickPath(record, key) != null)) found.push(record);
  for (const child of Object.values(record)) findRecords(child, keys, depth + 1, found);
  return found;
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

function cursorValue(page: unknown, next: string | CursorSelector): unknown {
  if (typeof next !== "string") {
    const target = findWhere(page, next.where.field, next.where.equals);
    return target === undefined ? undefined : pick(target, next.path);
  }
  const value = walk(page, next);
  if (value && typeof value === "object" && "value" in (value as Record<string, unknown>))
    return (value as Record<string, unknown>).value;
  return value;
}

/** The first object anywhere in a response whose field equals a value. */
function findWhere(value: unknown, field: string, expected: unknown, depth = 0): unknown {
  if (!value || typeof value !== "object" || depth > 24) return undefined;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findWhere(item, field, expected, depth + 1);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (JSON.stringify(record[field]) === JSON.stringify(expected)) return record;
  for (const child of Object.values(record)) {
    const found = findWhere(child, field, expected, depth + 1);
    if (found !== undefined) return found;
  }
  return undefined;
}

function finish(
  items: unknown[],
  recipe: SiteRecipe,
  limit: number,
  inputs: Record<string, unknown>,
): Record<string, unknown>[] {
  const mapped = mapRecords(items, recipe.map);
  const filtered = mapped.filter((record) => matchesFilters(record, recipe.filter));
  const threaded = recipe.thread ? threadOnly(filtered, recipe, inputs) : filtered;
  const seen = new Set<string>();
  const unique: Record<string, unknown>[] = [];
  for (const record of threaded) {
    const key = recordKey(record, recipe.key);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(record);
    if (unique.length >= limit) break;
  }
  return recipe.kind === "single" ? unique.slice(0, 1) : unique;
}

/**
 * Keeps a thread to the posts of the author who opened it, in page order, with the opening post
 * first. Without the filter a thread reader returns every reply in the DOM.
 */
function threadOnly(
  records: Record<string, unknown>[],
  recipe: SiteRecipe,
  inputs: Record<string, unknown>,
): Record<string, unknown>[] {
  if (!records.length) return records;
  const field = recipe.thread?.authorField ?? "author";
  const root = openingRecord(records, inputs.id);
  const author = authorOf(root ?? records[0], field);
  if (!author) return records;
  const mine = records.filter((record) => authorOf(record, field) === author);
  return orderThread(root, mine, recipe.thread?.rootFirst !== false);
}

function openingRecord(
  records: Record<string, unknown>[],
  id: unknown,
): Record<string, unknown> | undefined {
  if (id === undefined || id === null) return undefined;
  return records.find((record) => String(record.id) === String(id));
}

function authorOf(record: Record<string, unknown> | undefined, field: string): string {
  return String(record?.[field] ?? "")
    .trim()
    .toLowerCase();
}

function orderThread(
  root: Record<string, unknown> | undefined,
  records: Record<string, unknown>[],
  rootFirst: boolean,
): Record<string, unknown>[] {
  if (!root || !rootFirst) return records;
  return [root, ...records.filter((record) => record !== root)];
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
  const blocks = result.records.map((record, index) => renderRecord(record, index, render));
  const markdown = `# ${options.recipe.description ?? options.recipe.name} (${result.count})\n\n${blocks.join("\n\n")}\n`;
  return {
    ...result,
    markdown,
    jsonl: result.records.map((record) => JSON.stringify(record)).join("\n"),
  };
}

function renderRecord(
  record: Record<string, unknown>,
  index: number,
  render: NonNullable<SiteRecipe["render"]>,
): string {
  const author = text(record, render.author);
  const date = text(record, render.date);
  const title = text(record, render.title) ?? author ?? `#${index + 1}`;
  const body = text(record, render.text) ?? "";
  const url = text(record, render.url);
  const meta = [author ? `@${author.replace(/^@/, "")}` : undefined, date]
    .filter(Boolean)
    .join(" · ");
  const quote = render.quote ? record[render.quote] : undefined;
  const images = render.media ? list(record[render.media]) : [];
  return [
    `## ${title}${meta ? `\n${meta}` : ""}`,
    body,
    quoteBlock(quote),
    images.map((image) => `![](${image})`).join(" "),
    url,
  ]
    .filter((part): part is string => typeof part === "string" && part.length > 0)
    .join("\n\n");
}

function quoteBlock(quote: unknown): string {
  if (!quote || typeof quote !== "object") return "";
  const record = quote as Record<string, unknown>;
  const text = typeof record.text === "string" ? record.text : "";
  const author = typeof record.author === "string" ? record.author : "";
  if (!text) return "";
  return [text, author ? `— @${author.replace(/^@/, "")}` : ""]
    .filter(Boolean)
    .map((line) => `> ${line}`)
    .join("\n");
}

function list(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((item) => String(item)).filter(Boolean);
  if (typeof value === "string" && value) return [value];
  return [];
}

function text(record: Record<string, unknown>, field: string | undefined): string | undefined {
  if (!field) return undefined;
  const value = record[field];
  if (value === undefined || value === null || value === "") return undefined;
  return String(value);
}
