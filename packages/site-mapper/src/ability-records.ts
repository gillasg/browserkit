// Reads that return records. A read ability whose ways page an API, find records in a tree or map
// fields runs through the recipe runtime, so everything a migrated recipe could do (cursor paging,
// record mapping, filters, threads, derived inputs) still works. Every list read also gets one
// caller contract: limit/cursor in, items/next_cursor/has_more out, with a cursor that survives
// rows being added or removed between calls, and declared checks that fail loudly when the site
// ignored an input.

import type { Ability, AbilityHost, AbilityWay, AbilityWayApi } from "./abilities.js";
import { recordKey } from "./recipe-map.js";
import type { RecipeStrategy, SiteRecipe } from "./recipes.js";
import { runRecipe } from "./runtime/recipe.js";

/** A rule a returned record must satisfy whenever the caller passed `input`. */
export interface AbilityCheck {
  input: string;
  /** Record field (dot path) the input should constrain. */
  field: string;
  op: "eq" | "lt" | "lte" | "gt" | "gte" | "contains";
}

export interface AbilityPage {
  items: unknown[];
  next_cursor: string | null;
  has_more: boolean;
}

/** Keys of the last rows returned, remembered so the next page finds its place again. */
const SEEN = 16;

/** True when a read ability needs the recipe runtime: paging, record search or mapping. */
export function usesRecordRuntime(ability: Ability): boolean {
  if (ability.kind !== "read") return false;
  if (ability.options.recordMapping || ability.options.paging) return true;
  return ability.ways.some((way) => way.kind === "api" && (way.paging || way.records));
}

/** The recipe this ability was (or would have been), so the recipe runtime can run it. */
export function recipeFromAbility(ability: Ability): SiteRecipe {
  const mapping = (ability.options.recordMapping ?? {}) as Partial<SiteRecipe> & {
    resultKind?: SiteRecipe["kind"];
  };
  return {
    version: 1,
    name: ability.name,
    site: ability.site,
    ...(ability.description ? { description: ability.description } : {}),
    ...(mapping.resultKind ? { kind: mapping.resultKind } : {}),
    strategies: ability.ways.flatMap((way) => strategyFromWay(way, ability)),
    ...(mapping.map ? { map: mapping.map } : {}),
    ...(mapping.key ? { key: mapping.key } : {}),
    ...(mapping.filter ? { filter: mapping.filter } : {}),
    ...(mapping.limit ? { limit: mapping.limit } : {}),
    ...(mapping.thread ? { thread: mapping.thread } : {}),
    ...(mapping.derive ? { derive: mapping.derive } : {}),
    createdAt: ability.createdAt,
    updatedAt: ability.updatedAt,
  };
}

function apiStrategy(way: AbilityWayApi, ability: Ability): RecipeStrategy[] {
  const operation = way.operation ?? way.operations?.[0]?.operation;
  if (!operation) return [];
  const pagination = way.paging ?? ability.options.paging;
  return [
    {
      kind: "api",
      operation,
      ...(way.open ? { open: way.open } : {}),
      ...(way.params ? { params: way.params as never } : {}),
      ...(pagination ? { pagination } : {}),
      ...(way.records ? { records: way.records } : {}),
    },
  ];
}

function strategyFromWay(way: AbilityWay, ability: Ability): RecipeStrategy[] {
  if (way.kind === "api") return apiStrategy(way, ability);
  if (way.kind === "page")
    return [{ kind: "collect", collect: way.collect ?? { row: "body", fields: {} } }];
  if (way.kind === "steps")
    return [
      {
        kind: "workflow",
        ...(way.name ? { name: way.name } : {}),
        ...(way.workflow ? { workflow: way.workflow } : {}),
        ...(way.params ? { params: way.params as never } : {}),
      },
    ];
  return way.runtime === "page" ? [{ kind: "script", code: way.code }] : [];
}

/** Runs a record read through the recipe runtime; `wanted` stops paging once enough rows exist. */
export async function readRecords(
  ability: Ability,
  inputs: Record<string, unknown>,
  host: AbilityHost,
  wanted?: number,
): Promise<{ result: unknown[]; via: "api" | "page" | "steps" | "script" }> {
  const call = host.call;
  if (!call) throw new Error("No site API transport");
  const run = await runRecipe({
    site: ability.site,
    recipe: recipeFromAbility(ability),
    inputs,
    host: { ...host, call },
    ...(wanted ? { limit: wanted } : {}),
    trackHealth: false,
  });
  const via = { api: "api", collect: "page", workflow: "steps", script: "script" } as const;
  return {
    result: run.records,
    via: via[(run.strategy ?? "api") as keyof typeof via] ?? "api",
  };
}

/** The list inside a result: an array, or {items|records|results|data}. */
export function rowsOf(value: unknown): unknown[] | undefined {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== "object") return undefined;
  for (const key of ["items", "records", "results", "data"]) {
    const rows = (value as Record<string, unknown>)[key];
    if (Array.isArray(rows)) return rows;
  }
  return undefined;
}

interface Cursor {
  /** Rows returned so far. */
  o: number;
  /** Keys of the last rows returned. */
  k: string[];
}

function keyOf(row: unknown, field?: string): string {
  return row && typeof row === "object"
    ? recordKey(row as Record<string, unknown>, field)
    : JSON.stringify(row);
}

function decode(cursor: string): Cursor {
  try {
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as Cursor;
    if (typeof value.o === "number" && Array.isArray(value.k)) return value;
  } catch {
    // Falls through to the error below.
  }
  throw new Error("ABILITY_BAD_CURSOR: pass back next_cursor exactly as returned");
}

/**
 * One page of rows. The cursor finds the last row it returned in the fresh list and continues
 * after it, so rows inserted or removed above it neither repeat nor go missing; when that row is
 * gone it falls back to the offset and still drops rows it already returned.
 */
export function pageRows(
  rows: unknown[],
  options: { limit?: number; cursor?: string; key?: string },
): AbilityPage {
  const limit = Math.max(1, Math.floor(options.limit ?? 50));
  const cursor = options.cursor ? decode(options.cursor) : { o: 0, k: [] };
  const keys = rows.map((row) => keyOf(row, options.key));
  // The most recent returned row still in the list marks the place; the offset is the fallback.
  let found = -1;
  for (let index = cursor.k.length - 1; index >= 0 && found < 0; index--)
    found = keys.lastIndexOf(cursor.k[index] ?? "");
  const start = found >= 0 ? found + 1 : Math.min(cursor.o, rows.length);
  const seen = new Set(cursor.k);
  const items: unknown[] = [];
  let index = start;
  for (; index < rows.length && items.length < limit; index++)
    if (!seen.has(keys[index] ?? "")) items.push(rows[index]);
  const has_more = index < rows.length;
  const returned = [...cursor.k, ...items.map((row) => keyOf(row, options.key))].slice(-SEEN);
  const next: Cursor = { o: cursor.o + items.length, k: returned };
  return {
    items,
    next_cursor: has_more ? Buffer.from(JSON.stringify(next)).toString("base64url") : null,
    has_more,
  };
}

function valueAt(row: unknown, path: string): unknown {
  let value = row;
  for (const key of path.split(".")) value = (value as Record<string, unknown> | undefined)?.[key];
  return value;
}

function holds(value: unknown, wanted: unknown, op: AbilityCheck["op"]): boolean {
  if (value === undefined || value === null) return true;
  if (op === "contains") return String(value).toLowerCase().includes(String(wanted).toLowerCase());
  if (op === "eq") return String(value).toLowerCase() === String(wanted).toLowerCase();
  const left = Number(String(value).replace(/[^0-9.-]/g, ""));
  const right = Number(wanted);
  if (!Number.isFinite(left) || !Number.isFinite(right)) return true;
  return { lt: left < right, lte: left <= right, gt: left > right, gte: left >= right }[op];
}

/**
 * Throws INPUT_NOT_APPLIED when the caller passed an input a check covers and returned rows break
 * it: the site ignored a filter, so the rows answer a different question than the one asked.
 */
export function assertInputsApplied(
  ability: Ability,
  inputs: Record<string, unknown>,
  result: unknown,
): void {
  const checks = (ability.options.checks ?? []) as AbilityCheck[];
  const rows = rowsOf(result) ?? (result && typeof result === "object" ? [result] : []);
  for (const check of checks) {
    const wanted = inputs[check.input];
    if (wanted === undefined || wanted === null || wanted === "") continue;
    const broken = rows.filter((row) => !holds(valueAt(row, check.field), wanted, check.op));
    if (broken.length)
      throw new Error(
        `INPUT_NOT_APPLIED: ${ability.site} ${ability.name} ignored ${check.input}=${JSON.stringify(wanted)}: ` +
          `${broken.length} of ${rows.length} rows have ${check.field} not ${check.op} it ` +
          JSON.stringify({
            code: "input_not_applied",
            field: check.input,
            requested: wanted,
            retry: "same_key",
          }),
      );
  }
}
