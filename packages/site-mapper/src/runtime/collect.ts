// The page half of a collect strategy: one browser cell that opens the page, clicks "show more"
// controls, scrolls until the list stops growing, and reads the requested fields from every row.
// Returned rows are plain JSON, so the recipe runtime can map them like API records.

import type { CollectRecipe } from "../recipes.js";

export interface CollectInput extends CollectRecipe {
  url?: string;
}

/**
 * Builds the cell. Field selectors accept an `@attr` suffix to read an attribute, and a leading
 * `?` (or trailing `?`) marks the field optional: a missing nested element yields null instead
 * of failing the whole row.
 */
export function collectExpression(input: CollectInput): string {
  const spec = {
    url: input.url ?? null,
    row: input.row,
    fields: input.fields,
    scroll: input.scroll === true,
    expand: input.expand ?? [],
    max: Math.min(Math.max(input.max ?? 200, 1), 2000),
    idleRounds: Math.min(Math.max(input.idleRounds ?? 3, 1), 20),
  };
  return `(async () => {
  const spec = ${JSON.stringify(spec)};
  if (spec.url) await page.goto(spec.url);
  const readRow = (el) => {
    const row = {};
    for (const [name, raw] of Object.entries(spec.fields)) {
      const optional = raw.startsWith("?") || raw.endsWith("?");
      const selector = raw.replace(/^\\?/, "").replace(/\\?$/, "");
      const [css, attr] = selector.split("@");
      let value = null;
      try {
        const node = css ? el.querySelector(css) : el;
        if (node) value = attr ? node.getAttribute(attr) : (node.innerText ?? node.textContent ?? "").trim();
      } catch { value = null; }
      if ((value === null || value === "") && !optional) value = value ?? "";
      row[name] = value;
    }
    return row;
  };
  const read = () => [...document.querySelectorAll(spec.row)].slice(0, spec.max).map(readRow);
  if (!spec.scroll) return { rows: read(), complete: true };
  const clicked = new Set();
  for (const label of spec.expand) {
    for (const node of document.querySelectorAll("button, a, [role='button']")) {
      const text = (node.innerText ?? "").trim().toLowerCase();
      if (!text || !text.includes(String(label).toLowerCase()) || clicked.has(node)) continue;
      clicked.add(node);
      try { node.click(); await new Promise((done) => setTimeout(done, 150)); } catch {}
    }
  }
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
