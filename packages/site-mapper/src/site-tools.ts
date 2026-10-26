// Callable site tools: small saved functions that belong to a site pack. A `tool` runs in Node
// with only siteMapper.call and browser.fetch (no imports); a `pageTool` runs in the page with its
// arguments. Both are off until enabled, because enabling them trusts their code.

import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import vm from "node:vm";
import { handleSiteMapperRequest } from "./requests.js";
import { siteDir, siteName, writeAtomic } from "./registry.js";
import type { Json } from "./types.js";

export type SiteToolParamType = "string" | "number" | "boolean";
export interface SiteToolParam {
  name: string;
  type: SiteToolParamType;
  required?: boolean;
  default?: Json;
}
export interface SiteTool {
  version: 1;
  name: string;
  description?: string;
  params: SiteToolParam[];
  code: string;
  enabled: boolean;
  updatedAt: string;
}
export interface SiteToolFile {
  version: 1;
  tools: SiteTool[];
  pageTools: SiteTool[];
}
export interface SiteToolSummary {
  name: string;
  description?: string;
  params: SiteToolParam[];
  enabled: boolean;
}

const FILE = "tools.json";
const MAX_CODE = 200_000;
const MAX_FILE = 1_000_000;
const NAME = /^[a-z][a-z0-9_-]{0,63}$/i;

export function isSiteToolRequest(value: unknown): boolean {
  return Boolean(value && typeof (value as { siteTool?: unknown }).siteTool === "object");
}

export async function readSiteTools(site: string): Promise<SiteToolFile> {
  const path = join(siteDir(siteName(site)), FILE);
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return { version: 1, tools: [], pageTools: [] };
  }
  // One broken file must not take other sites down: keep the valid entries.
  try {
    const parsed = JSON.parse(text) as Partial<SiteToolFile>;
    return {
      version: 1,
      tools: validList(parsed.tools),
      pageTools: validList(parsed.pageTools),
    };
  } catch {
    return { version: 1, tools: [], pageTools: [] };
  }
}

export async function writeSiteTools(site: string, file: SiteToolFile): Promise<void> {
  const text =
    JSON.stringify({ ...file, version: 1, tools: file.tools, pageTools: file.pageTools }, null, 2) +
    "\n";
  if (Buffer.byteLength(text) > MAX_FILE)
    throw new Error(`SITE_TOOLS_TOO_LARGE: ${site} tools.json exceeds ${MAX_FILE} bytes`);
  for (const tool of [...file.tools, ...file.pageTools]) validateTool(tool);
  await mkdir(siteDir(siteName(site)), { recursive: true });
  await writeAtomic(join(siteDir(siteName(site)), FILE), text);
}

export async function listSiteTools(
  site: string,
): Promise<{ tools: SiteToolSummary[]; pageTools: SiteToolSummary[] }> {
  const file = await readSiteTools(site);
  return {
    tools: file.tools.map(summary),
    pageTools: file.pageTools.map(summary),
  };
}

export async function setSiteToolsEnabled(
  site: string,
  kind: "tools" | "pageTools" | "all",
  name: string | undefined,
  enabled: boolean,
): Promise<number> {
  const file = await readSiteTools(site);
  let changed = 0;
  const update = (list: SiteTool[]) => {
    for (const tool of list) {
      if (name && tool.name !== name) continue;
      tool.enabled = enabled;
      changed += 1;
    }
  };
  if (kind === "tools" || kind === "all") update(file.tools);
  if (kind === "pageTools" || kind === "all") update(file.pageTools);
  if (changed) await writeSiteTools(site, file);
  return changed;
}

export async function runSiteTool(
  site: string,
  name: string,
  args: Record<string, unknown>,
  host: {
    call?: (operation: string, params: Record<string, unknown>) => Promise<unknown>;
    fetch?: typeof fetch;
  } = {},
): Promise<unknown> {
  const file = await readSiteTools(site);
  const tool = file.tools.find((item) => item.name === name);
  if (!tool) throw new Error(`SITE_TOOL_UNKNOWN: ${site} has no tool ${name}`);
  if (!tool.enabled)
    throw new Error(
      `SITE_TOOL_DISABLED: enable ${site} tool ${name} with browserkit site tools enable ${site} ${name}`,
    );
  const inputs = applyParams(tool, args);
  const call =
    host.call ??
    ((operation, params) =>
      handleSiteMapperRequest({ siteMapper: "call", site, operation, params }));
  const fetchImpl = host.fetch ?? fetch;
  const context = vm.createContext({
    siteMapper: {
      call: (operation: string, params: Record<string, unknown> = {}) =>
        call(String(operation), params),
    },
    browser: { fetch: (url: string, options: RequestInit = {}) => fetchImpl(String(url), options) },
    args: inputs,
  });
  const wrapped = `(async () => { ${tool.code}\n })()`;
  const result = new vm.Script(wrapped, { filename: `${site}/${name}.js` }).runInContext(context, {
    timeout: 30_000,
  }) as Promise<unknown>;
  const value = await Promise.race([
    result,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`SITE_TOOL_TIMEOUT: ${name} exceeded 30s`)), 30_000),
    ),
  ]);
  return value === undefined ? null : value;
}

export async function readPageTool(
  site: string,
  name: string,
): Promise<{ code: string; params: SiteToolParam[] }> {
  const file = await readSiteTools(site);
  const tool = file.pageTools.find((item) => item.name === name);
  if (!tool) throw new Error(`SITE_PAGE_TOOL_UNKNOWN: ${site} has no page tool ${name}`);
  if (!tool.enabled)
    throw new Error(
      `SITE_TOOL_DISABLED: enable ${site} page tool ${name} with browserkit site tools enable ${site} ${name}`,
    );
  return { code: tool.code, params: tool.params };
}

/** Names and descriptions for the `here:` line and site summaries. */
export async function siteToolSummaryFor(
  site: string,
): Promise<{ tools: string[]; pageTools: string[] }> {
  const file = await readSiteTools(site);
  return {
    tools: file.tools.filter((item) => item.enabled).map((item) => item.name),
    pageTools: file.pageTools.filter((item) => item.enabled).map((item) => item.name),
  };
}

function validList(list: unknown): SiteTool[] {
  if (!Array.isArray(list)) return [];
  return list.filter((item): item is SiteTool => {
    if (!item || typeof item !== "object") return false;
    try {
      validateTool(item as SiteTool);
      return true;
    } catch {
      return false;
    }
  });
}

function validateTool(tool: SiteTool): void {
  if (!tool || typeof tool !== "object")
    throw new Error("SITE_TOOL_INVALID: a tool must be an object");
  if (!NAME.test(String(tool.name ?? "")))
    throw new Error(`SITE_TOOL_INVALID: bad name ${String(tool.name)}`);
  if (typeof tool.code !== "string" || !tool.code.trim())
    throw new Error(`SITE_TOOL_INVALID: ${tool.name} has no code`);
  if (Buffer.byteLength(tool.code) > MAX_CODE)
    throw new Error(`SITE_TOOL_INVALID: ${tool.name} code exceeds ${MAX_CODE} bytes`);
  if (tool.params !== undefined && !Array.isArray(tool.params))
    throw new Error(`SITE_TOOL_INVALID: ${tool.name} params must be an array`);
  for (const param of tool.params ?? []) validateParam(tool.name, param);
}

function validateParam(tool: string, param: SiteToolParam): void {
  if (!param || !NAME.test(String(param.name ?? "")))
    throw new Error(`SITE_TOOL_INVALID: ${tool} has a bad param name`);
  if (!["string", "number", "boolean"].includes(String(param.type)))
    throw new Error(`SITE_TOOL_INVALID: ${tool}.${String(param.name)} has a bad type`);
}

function applyParams(tool: SiteTool, args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const param of tool.params ?? []) {
    const value = args[param.name] ?? param.default;
    if (value === undefined) {
      if (param.required) throw new Error(`SITE_TOOL_PARAMS: ${tool.name} needs ${param.name}`);
      continue;
    }
    const type = typeof value;
    if (type !== param.type)
      throw new Error(`SITE_TOOL_PARAMS: ${tool.name}.${param.name} must be a ${param.type}`);
    out[param.name] = value;
  }
  for (const [key, value] of Object.entries(args)) if (!(key in out)) out[key] = value;
  return out;
}

function summary(tool: SiteTool): SiteToolSummary {
  return {
    name: tool.name,
    ...(tool.description ? { description: tool.description } : {}),
    params: tool.params ?? [],
    enabled: tool.enabled !== false,
  };
}
