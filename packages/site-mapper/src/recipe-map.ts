// Field mapping for recipes: turn one raw record (an API row, a collected row, a script's output)
// into the shape a recipe promises. Paths are JSON pointers or dotted paths, tolerate arrays of
// candidate paths, and support the transforms a feed needs (text, numbers, timestamps, regex
// capture). Everything here is pure so mappings can be tested without a browser or network.

import type { Json } from "./types.js";

export type FieldTransform =
  "string" | "number" | "boolean" | "trim" | "lower" | "upper" | "iso" | "unix-ms" | "unix-s";

export interface FieldRule {
  /** One path, or several tried in order (API shape first, page shape second). */
  path?: string | string[];
  /** Template over the raw record: "{{author.name}} ({{author.handle}})". */
  template?: string;
  transform?: FieldTransform;
  /** Regex applied to the resolved text; group 1 (or `group`) is the value. */
  pattern?: string;
  flags?: string;
  group?: number;
  /** Join a list with this separator instead of returning an array. */
  join?: string;
  /** Used when the path is missing or resolves to null. */
  default?: Json;
  required?: boolean;
}

export type FieldMapping = string | FieldRule;
export type RecipeMapping = Record<string, FieldMapping>;

export interface RecipeFilter {
  field: string;
  op?: "equals" | "notEquals" | "contains" | "regex" | "exists" | "gt" | "lt";
  value?: Json;
}

/** Reads a JSON pointer ("/a/0/b") or a dotted path ("a.0.b"). */
export function pickPath(source: unknown, path: string): unknown {
  if (!path) return source;
  const parts = path.startsWith("/")
    ? path
        .slice(1)
        .split("/")
        .map((part) => part.replace(/~1/g, "/").replace(/~0/g, "~"))
    : path.split(".");
  let current: unknown = source;
  for (const part of parts) {
    if (current == null) return undefined;
    if (Array.isArray(current)) {
      const index = Number(part);
      if (!Number.isInteger(index)) return undefined;
      current = current[index];
      continue;
    }
    if (typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function firstPath(source: unknown, paths: string | string[]): unknown {
  for (const path of Array.isArray(paths) ? paths : [paths]) {
    const value = pickPath(source, path);
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
}

const TEMPLATE = /\{\{\s*([^{}]+?)\s*\}\}/g;

function template(text: string, record: unknown): string {
  return text.replace(TEMPLATE, (_, path: string) =>
    textOf(firstPath(record, String(path).trim())),
  );
}

export function textOf(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return "";
  }
}

function asNumber(value: unknown): unknown {
  const number = Number(typeof value === "string" ? value.replace(/[^0-9.eE+-]/g, "") : value);
  return Number.isFinite(number) ? number : undefined;
}

function asIso(value: unknown): unknown {
  if (typeof value === "number") return new Date(value).toISOString();
  if (typeof value !== "string") return undefined;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? value : new Date(parsed).toISOString();
}

const TRANSFORMS: Record<FieldTransform, (value: unknown) => unknown> = {
  string: (value) => textOf(value),
  number: asNumber,
  boolean: (value) => value === true || value === "true" || value === 1 || value === "1",
  trim: (value) => (typeof value === "string" ? value.trim() : value),
  lower: (value) => (typeof value === "string" ? value.toLowerCase() : value),
  upper: (value) => (typeof value === "string" ? value.toUpperCase() : value),
  iso: asIso,
  "unix-ms": (value) =>
    Number.isFinite(Number(value)) ? new Date(Number(value)).toISOString() : undefined,
  "unix-s": (value) =>
    Number.isFinite(Number(value)) ? new Date(Number(value) * 1000).toISOString() : undefined,
};

export function applyTransform(value: unknown, transform?: FieldTransform): unknown {
  return transform ? TRANSFORMS[transform](value) : value;
}

/** Raw value of a rule, before regex and transforms. */
function rawValue(record: unknown, rule: FieldRule): unknown {
  if (rule.template !== undefined) return template(rule.template, record);
  if (rule.path !== undefined) return firstPath(record, rule.path);
  return undefined;
}

function applyPattern(value: unknown, rule: FieldRule): unknown {
  if (typeof value !== "string" || !rule.pattern) return value;
  const match = new RegExp(rule.pattern, rule.flags ?? "").exec(value);
  return match ? (match[rule.group ?? 1] ?? match[0]) : undefined;
}

export function resolveField(record: unknown, mapping: FieldMapping): unknown {
  if (typeof mapping === "string") return firstPath(record, mapping);
  const value = normalise(
    applyTransform(applyPattern(rawValue(record, mapping), mapping), mapping.transform),
  );
  if (value !== undefined && value !== null)
    return mapping.join && Array.isArray(value) ? value.map(textOf).join(mapping.join) : value;
  if (mapping.required)
    throw new Error(
      "missing required field: " + JSON.stringify(mapping.path ?? mapping.template ?? mapping),
    );
  return normalise(mapping.default);
}

function normalise(value: unknown): unknown {
  return value as Json;
}

/** Applies a mapping to every raw record. */
export function mapRecords(
  records: unknown[],
  mapping: RecipeMapping | undefined,
): Record<string, unknown>[] {
  return records.map((record, index) => {
    if (!mapping) return { ...(record as Record<string, unknown>), index };
    const mapped: Record<string, unknown> = {};
    for (const [field, rule] of Object.entries(mapping)) mapped[field] = resolveField(record, rule);
    return mapped;
  });
}

function matchesFilter(record: Record<string, unknown>, filter: RecipeFilter): boolean {
  const value = record[filter.field];
  const expected = filter.value;
  switch (filter.op ?? "equals") {
    case "exists":
      return (value !== undefined) === (expected !== false);
    case "equals":
      return JSON.stringify(value) === JSON.stringify(expected);
    case "notEquals":
      return JSON.stringify(value) !== JSON.stringify(expected);
    case "contains":
      return textOf(value).includes(textOf(expected));
    case "regex":
      return new RegExp(textOf(expected)).test(textOf(value));
    case "gt":
      return Number(value) > Number(expected);
    case "lt":
      return Number(value) < Number(expected);
  }
}

export function matchesFilters(
  record: Record<string, unknown>,
  filters: RecipeFilter[] | undefined,
): boolean {
  return (filters ?? []).every((filter) => matchesFilter(record, filter));
}

/** A stable key for de-duplication: asked-for field, else id/url, else the record's JSON. */
export function recordKey(record: Record<string, unknown>, keyField?: string): string {
  if (keyField) {
    const value = record[keyField];
    if (value !== undefined && value !== null) return textOf(value);
  }
  for (const field of ["id", "key", "url", "href"]) {
    const value = record[field];
    if (value !== undefined && value !== null) return textOf(value);
  }
  try {
    return JSON.stringify(record);
  } catch {
    return String(record);
  }
}

/** Half of a record: used to build a short summary for a run. */
export function summarise(
  record: Record<string, unknown>,
  fields: string[],
): Record<string, string> {
  const summary: Record<string, string> = {};
  for (const field of fields) {
    const value = record[field];
    if (value === undefined || value === null) continue;
    summary[field] = textOf(value).slice(0, 300);
  }
  return summary;
}
