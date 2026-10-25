// The page half of a collect strategy: one browser cell that opens the page, clicks "show more"
// controls, scrolls until the list stops growing, and reads the requested fields from every row.
// Fields may be plain selectors ("h2", "a@href", "img@src[]") or specs with a property, a regex,
// a text filter or every match. Dotted names ("quoted.text") build nested records.

import type { CollectFieldSpec, CollectRecipe } from "../recipes.js";

export type CollectInput = CollectRecipe;

/** "h2", "a@href", "img@src[]" → a spec the page code reads without parsing. */
export function normaliseCollectField(raw: string | CollectFieldSpec): CollectFieldSpec {
  if (typeof raw !== "string") return raw;
  let selector = raw.trim();
  const all = /\[\]$/.test(selector);
  selector = selector.replace(/\[\]$/, "").replace(/^\?/, "").replace(/\?$/, "");
  const at = selector.lastIndexOf("@");
  const base =
    at > 0 ? { selector: selector.slice(0, at), attr: selector.slice(at + 1) } : { selector };
  return all ? { ...base, all: true } : base;
}

/**
 * Builds the cell. A string selector may carry `@attr` and a trailing `[]` for every match; a
 * `?` marks it optional (the default behaviour: a missing element yields null).
 */
export function collectExpression(input: CollectInput): string {
  const fields = Object.fromEntries(
    Object.entries(input.fields).map(([name, field]) => [name, normaliseCollectField(field)]),
  );
  const spec = {
    url: input.url ?? null,
    row: input.row,
    fields,
    scroll: input.scroll === true,
    expand: input.expand ?? [],
    max: Math.min(Math.max(input.max ?? 200, 1), 2000),
    idleRounds: Math.min(Math.max(input.idleRounds ?? 3, 1), 20),
  };
  return `(async () => {
  const spec = ${JSON.stringify(spec)};
  const textOf = (node) => (node.innerText ?? node.textContent ?? "").trim();
  const readField = (el, field) => {
    let nodes = [];
    try { nodes = [...el.querySelectorAll(field.selector)]; } catch { nodes = []; }
    if (field.contains) nodes = nodes.filter((node) => textOf(node).includes(field.contains));
    const picked = field.all ? nodes : nodes.slice(0, 1);
    const values = picked.map((node) => {
      let value = field.property ? node[field.property] : field.attr ? node.getAttribute(field.attr) : textOf(node);
      if (typeof value === "string") {
        value = value.trim();
        if (field.match) {
          const match = new RegExp(field.match, field.flags || "").exec(value);
          value = match ? (match[field.group ?? 1] ?? match[0]) : null;
        }
        if (typeof value === "string" && field.strip) value = value.split(field.strip).join("").trim();
        if (value === "") value = null;
      }
      return value;
    });
    if (field.all) return values.filter((value) => value !== null);
    return values[0] ?? (field.default ?? null);
  };
  const setNested = (target, path, value) => {
    const parts = String(path).split(".");
    let current = target;
    for (const part of parts.slice(0, -1)) {
      if (!current[part] || typeof current[part] !== "object") current[part] = {};
      current = current[part];
    }
    current[parts[parts.length - 1]] = value;
  };
  const readRow = (el) => {
    const row = {};
    for (const [name, field] of Object.entries(spec.fields)) setNested(row, name, readField(el, field));
    return row;
  };
  const read = () => [...document.querySelectorAll(spec.row)].slice(0, spec.max).map(readRow);
  if (spec.url) await page.goto(spec.url);
  for (const entry of spec.expand) {
    const bySelector = /^[\\[#.]/.test(entry);
    const targets = bySelector ? [...document.querySelectorAll(entry)] : [...document.querySelectorAll("button, a, [role='button']")].filter((node) => textOf(node).toLowerCase().includes(String(entry).toLowerCase()));
    for (const node of targets.slice(0, 40)) {
      try { node.click(); await new Promise((done) => setTimeout(done, 120)); } catch {}
    }
  }
  if (!spec.scroll) return { rows: read(), complete: true };
  let seen = 0;
  let idle = 0;
  for (let round = 0; round < 200; round++) {
    const rows = document.querySelectorAll(spec.row);
    if (rows.length >= spec.max) break;
    if (rows.length === seen) idle += 1;
    else { idle = 0; seen = rows.length; }
    if (idle >= spec.idleRounds) break;
    const before = window.scrollY;
    window.scrollTo(0, document.body.scrollHeight);
    await new Promise((done) => setTimeout(done, 350));
    if (window.scrollY === before && idle > 0) break;
  }
  const rows = read();
  return { rows, complete: rows.length < spec.max };
})()`;
}
