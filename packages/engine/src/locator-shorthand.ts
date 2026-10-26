// CSS/Playwright locator shorthands used by browser code. The same function is injected into the
// page-side API source, so it must stay self-contained: no imports, no outer references.
export interface Shorthand {
  spec: Record<string, unknown>;
  index?: number;
}

/** Parse `>>` chains, role/text/xpath shorthand, :has-text(...) and nth=N. */
export function parseLocatorShorthand(selector: string): Shorthand {
  const unquote = (value: string): string => {
    const text = value.trim();
    if (
      (text.startsWith('"') && text.endsWith('"')) ||
      (text.startsWith("'") && text.endsWith("'"))
    )
      return text.slice(1, -1).replace(/\\(["'\\])/g, "$1");
    return text;
  };
  const splitTop = (value: string, separator: string): string[] => {
    const parts: string[] = [];
    let start = 0;
    let quote = "";
    let depth = 0;
    for (let index = 0; index < value.length; index++) {
      const char = value[index] as string;
      if (quote) {
        if (char === "\\") index++;
        else if (char === quote) quote = "";
        continue;
      }
      if (char === '"' || char === "'") quote = char;
      else if (char === "[" || char === "(") depth++;
      else if (char === "]" || char === ")") depth = Math.max(0, depth - 1);
      else if (depth === 0 && value.startsWith(separator, index)) {
        parts.push(value.slice(start, index));
        index += separator.length - 1;
        start = index + 1;
      }
    }
    parts.push(value.slice(start));
    return parts;
  };
  const findHasText = (text: string): number => {
    let quote = "";
    for (let index = 0; index < text.length; index++) {
      const char = text[index];
      if (quote) {
        if (char === "\\") index++;
        else if (char === quote) quote = "";
        continue;
      }
      if (char === '"' || char === "'") quote = char;
      else if (text.startsWith(":has-text(", index)) return index;
    }
    return -1;
  };
  const matchingParen = (text: string, open: number): number => {
    let quote = "";
    let depth = 0;
    for (let index = open; index < text.length; index++) {
      const char = text[index];
      if (quote) {
        if (char === "\\") index++;
        else if (char === quote) quote = "";
        continue;
      }
      if (char === '"' || char === "'") quote = char;
      else if (char === "(") depth++;
      else if (char === ")" && --depth === 0) return index;
    }
    return -1;
  };
  const hasText = (segment: string): { base: string; values: string[] } => {
    const values: string[] = [];
    let base = segment;
    for (;;) {
      const at = findHasText(base);
      if (at < 0) break;
      const open = base.indexOf("(", at);
      const close = matchingParen(base, open);
      if (open < 0 || close < 0) break;
      values.push(unquote(base.slice(open + 1, close)));
      base = base.slice(0, at) + base.slice(close + 1);
    }
    return { base, values };
  };
  const roleSegment = (value: string): Record<string, unknown> => {
    const open = value.indexOf("[");
    const role = (open < 0 ? value : value.slice(0, open)).trim();
    const spec: Record<string, unknown> = { kind: "locator", role, name: "", exact: true };
    if (open >= 0) {
      const attrs = value.slice(open);
      const name = /\[\s*name\s*=\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^\]]+?)\s*\]/.exec(attrs);
      if (name?.[1]) spec.name = unquote(name[1]);
    }
    return spec;
  };
  const oneSegment = (value: string): Record<string, unknown> => {
    const segment = value.trim();
    if (!segment || segment.startsWith(":has-text("))
      return { kind: "query", by: "css", value: "*" };
    if (segment.startsWith("text="))
      return { kind: "query", by: "text", value: unquote(segment.slice(5)) };
    if (segment.startsWith("xpath="))
      return { kind: "query", by: "xpath", value: segment.slice(6) };
    if (segment.startsWith("role=")) return roleSegment(segment.slice(5));
    return { kind: "query", by: "css", value: segment };
  };
  const parts = splitTop(selector, ">>");
  let spec: Record<string, unknown> | undefined;
  let index: number | undefined;
  for (const raw of parts) {
    const part = raw.trim();
    if (!part) continue;
    if (/^nth\s*=\s*-?\d+$/.test(part)) {
      index = Number(part.split("=")[1]);
      continue;
    }
    const parsed = hasText(part);
    let next = oneSegment(parsed.base);
    if (parsed.values.length)
      next = {
        ...next,
        filters: parsed.values.map((hasTextValue) => ({ hasText: hasTextValue })),
      };
    if (!spec) spec = next;
    else if (spec.kind === "query" && spec.by === "css" && !spec.filters) next.scope = spec.value;
    else next.scopeSpec = spec;
    spec = next;
  }
  return {
    spec: spec ?? { kind: "query", by: "css", value: "" },
    ...(index === undefined ? {} : { index }),
  };
}

export const locatorShorthandSource = `var __parseSelector = ${parseLocatorShorthand.toString()};`;
