// The browser action vocabulary a workflow step can name. Each action compiles to one browser
// code cell and returns plain JSON, so a step's result can be templated into later steps
// ({{steps.<id>.url}}) and recorded in the run. Locator-style actions accept the same target
// shapes as the browser API: {role, name}, {text}, {label}, {placeholder} or {css}.

import type { WorkflowAction, WorkflowActions } from "./workflow.js";

export type BrowserRunner = (code: string) => Promise<unknown>;

type Args = Record<string, unknown>;

const json = (value: unknown): string => JSON.stringify(value ?? null);

/** The JS expression for a locator, or null when no target was given. */
export function locatorCode(args: Args): string | null {
  const nth = typeof args.nth === "number" ? `.nth(${args.nth})` : "";
  if (typeof args.role === "string") {
    const options: Record<string, unknown> = {};
    if (typeof args.name === "string") options.name = args.name;
    if (args.exact === true) options.exact = true;
    return `page.getByRole(${json(args.role)}, ${json(options)})${nth}`;
  }
  if (typeof args.text === "string") {
    const options = args.exact === true ? ", { exact: true }" : "";
    return `page.getByText(${json(args.text)}${options})${nth}`;
  }
  if (typeof args.label === "string") {
    const options = args.exact === true ? ", { exact: true }" : "";
    return `page.getByLabel(${json(args.label)}${options})${nth}`;
  }
  if (typeof args.placeholder === "string")
    return `page.getByPlaceholder(${json(args.placeholder)})${nth}`;
  if (typeof args.css === "string") return `page.locator(${json(args.css)})${nth}`;
  return null;
}

function need(args: Args, name: string, action: string): string {
  const value = args[name];
  if (typeof value !== "string" || !value.trim()) throw new Error(`"${action}" needs "${name}"`);
  return value;
}

function cell(body: string, dryRun: boolean): string {
  // Dry runs still evaluate reads; only actions that change the page are short-circuited by the
  // caller, before a cell is built.
  void dryRun;
  return `(async () => { ${body} })()`;
}

/** Read-only and navigation actions: safe in a dry run, so a plan can still gather context. */
const SAFE = new Set([
  "goto",
  "wait",
  "read",
  "extract",
  "collect",
  "api",
  "assert",
  "save",
  "sleep",
]);

export function workflowActions(run: BrowserRunner): WorkflowActions {
  const wrap =
    (name: string, build: (args: Args) => string | Record<string, unknown>): WorkflowAction =>
    async (args, context) => {
      if (context.dryRun && !SAFE.has(name))
        return { dryRun: true, action: name, args, would: describe(name, args) };
      if (name === "sleep") {
        const ms = Number(args.ms ?? 1000);
        await new Promise((resolve) => setTimeout(resolve, Math.min(Math.max(ms, 0), 120_000)));
        return { slept: ms };
      }
      const code = build(args);
      if (typeof code !== "string") return code;
      return run(cell(code, context.dryRun));
    };
  return {
    goto: wrap("goto", (args) => {
      const url = need(args, "url", "goto");
      return `await page.goto(${json(url)}); return { url: page.url(), title: await page.title() };`;
    }),
    wait: wrap("wait", (args) => {
      if (typeof args.selector === "string")
        return `await page.waitForSelector(${json(args.selector)}, { timeout: ${Number(args.timeoutMs ?? 10000)} }); return { selector: ${json(args.selector)} };`;
      if (typeof args.text === "string")
        return `await page.getByText(${json(args.text)}).waitFor({ timeout: ${Number(args.timeoutMs ?? 10000)} }); return { text: ${json(args.text)} };`;
      const ms = Math.min(Math.max(Number(args.ms ?? 1000), 100), 120_000);
      return `await new Promise((resolve) => setTimeout(resolve, ${ms})); return { ms: ${ms} };`;
    }),
    read: wrap("read", (args) => {
      const options: Record<string, unknown> = {};
      if (typeof args.max === "number") options.max = args.max;
      if (typeof args.selector === "string") options.selector = args.selector;
      return `return await page.read(${json(options)});`;
    }),
    extract: wrap("extract", (args) => {
      const script = need(args, "script", "extract");
      const input = args.arg === undefined ? "undefined" : json(args.arg);
      return `return await (${script})(page, bu, ${input});`;
    }),
    collect: wrap("collect", (args) => {
      const options: Record<string, unknown> = {};
      if (typeof args.selector === "string") options.selector = args.selector;
      if (typeof args.max === "number") options.max = args.max;
      return `return await page.list(${json(options)});`;
    }),
    click: wrap("click", (args) => {
      const locator = locatorCode(args);
      if (!locator)
        throw new Error('"click" needs a target (role/name, text, label, placeholder or css)');
      return `const target = ${locator}; await target.click(); return { clicked: true, url: page.url() };`;
    }),
    fill: wrap("fill", (args) => {
      const locator = locatorCode(args);
      if (!locator)
        throw new Error('"fill" needs a target (role/name, text, label, placeholder or css)');
      const value = String(args.value ?? "");
      const enter = args.enter === true ? " await target.press('Enter');" : "";
      return `const target = ${locator}; await target.fill(${json(value)});${enter} return { filled: true };`;
    }),
    press: wrap("press", (args) => {
      const key = need(args, "key", "press");
      const locator = locatorCode(args);
      return locator
        ? `await (${locator}).press(${json(key)}); return { pressed: ${json(key)} };`
        : `await page.keyboard.press(${json(key)}); return { pressed: ${json(key)} };`;
    }),
    api: wrap("api", (args) => {
      const site = need(args, "site", "api");
      const operation = need(args, "operation", "api");
      const params = args.params && typeof args.params === "object" ? args.params : {};
      return `return await siteMapper.call(${json(site)}, ${json(operation)}, ${json(params)});`;
    }),
    assert: wrap("assert", (args) => {
      const value = args.value;
      if ("equals" in args && JSON.stringify(value) !== JSON.stringify(args.equals))
        throw new Error(`assert: ${json(value)} does not equal ${json(args.equals)}`);
      if (typeof args.contains === "string" && !asText(value).includes(args.contains))
        throw new Error(
          `assert: ${asText(value).slice(0, 200)} does not contain ${json(args.contains)}`,
        );
      if (args.truthy === true && !value) throw new Error("assert: value is empty");
      return { asserted: true, value };
    }),
    save: wrap("save", (args) => {
      const name = need(args, "name", "save");
      return `return await artifact(${json(name)}, ${json(args.data ?? null)});`;
    }),
    sleep: wrap("sleep", () => ""),
  };
}

function asText(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return String(value);
  }
}

function describe(action: string, args: Args): string {
  const target =
    (args.role as string | undefined) ??
    (args.text as string | undefined) ??
    (args.css as string | undefined) ??
    (args.url as string | undefined);
  return target ? `${action} ${target}` : action;
}
