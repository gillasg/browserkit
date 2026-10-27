import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { checkSites, crawl, findList, mapSite, scrape, search, type Format } from "browser-crawl";
import {
  checkCaptures,
  code as readSiteCode,
  explore,
  importCaptures,
  isSiteToolAction,
  listSites,
  loadModel,
  rebuild,
  runSiteToolAction,
  siteMapper,
  siteName,
  SITE_TOOL_ACTIONS,
  watch,
} from "@browserkit/site-mapper";

// The crawl and site_mapper tools as data. Every host (browserkit's bridge/MCP/CLI and Aeon)
// builds its own exposure from this file: same actions, same parameters, same handlers. A host
// chooses an allow-list of actions and may wrap the result (workspace files, bounded text).

// What every agent host exposes, so browserkit's MCP and Aeon's tools offer the same actions.
// Add or drop an action here, never in a host.
export const AGENT_CRAWL_ACTIONS = ["scrape", "crawl", "map", "search", "find", "check"] as const;
export const AGENT_SITE_MAPPER_ACTIONS = [
  "sites",
  "code",
  "operations",
  "call",
  "watch",
  "learn",
  "import",
  "explore",
  ...SITE_TOOL_ACTIONS,
] as const;

export interface JsonObjectSchema {
  type: "object";
  properties: Record<string, unknown>;
  required?: string[];
  additionalProperties: false;
}

export interface AgentToolAction {
  name: string;
  /** Parameter names this action reads. Used to build a host's filtered schema. */
  params: readonly string[];
}

export interface AgentToolContext {
  /** Files and exports are relative to this folder when the host has one. */
  workspace?: string;
  /** find, explore, edit, name and describe need a model; the host supplies its own. */
  model?: () => Promise<unknown>;
}

export interface AgentToolDefinition<Input extends Record<string, unknown>> {
  name: string;
  description: string;
  actions: readonly AgentToolAction[];
  parameters: JsonObjectSchema;
  run(input: Input, context: AgentToolContext): Promise<unknown>;
}

const FORMATS: Format[] = [
  "markdown",
  "fitMarkdown",
  "text",
  "links",
  "metadata",
  "tables",
  "pageData",
  "product",
];

export const CRAWL_TOOL_ACTIONS = ["scrape", "crawl", "map", "search", "find", "check"] as const;
export type CrawlToolInput = {
  action: (typeof CRAWL_TOOL_ACTIONS)[number];
  columns?: Record<string, string>;
  criteria?: string;
  url?: string;
  urls?: string[];
  file?: string;
  query?: string;
  limit?: number;
  maxDepth?: number;
  include?: string[];
  exclude?: string[];
  formats?: Format[];
  render?: "auto" | "static" | "browser";
  via?: "auto" | "http";
  paths?: string[];
  expect?: string;
  /** Also open each site and report typed readiness (ready, empty, loading, login, challenge, not-found, error). */
  readiness?: boolean;
  api?: { site: string; operation: string; params?: Record<string, unknown>; maxItems?: number };
};

const strings = { type: "array", items: { type: "string" }, maxItems: 20 };
const crawlParameters: JsonObjectSchema = {
  type: "object",
  properties: {
    action: { type: "string", enum: [...CRAWL_TOOL_ACTIONS] },
    columns: {
      type: "object",
      additionalProperties: { type: "string" },
      description: "For find: column name -> what to fill in.",
    },
    criteria: { type: "string", maxLength: 1000, description: "For find: what every row must be." },
    url: { type: "string", maxLength: 2000 },
    urls: {
      type: "array",
      items: { type: "string", maxLength: 2000 },
      maxItems: 5000,
      description: "For check: hosts or URLs.",
    },
    file: {
      type: "string",
      maxLength: 500,
      description: "For check: a workspace file listing hosts or URLs.",
    },
    query: {
      type: "string",
      maxLength: 500,
      description: "Search terms, or what to look for: ranks pages and keeps relevant parts.",
    },
    limit: { type: "integer", minimum: 1, maximum: 1000 },
    maxDepth: { type: "integer", minimum: 0, maximum: 20 },
    include: { ...strings, description: "Only URLs matching these patterns." },
    exclude: { ...strings, description: "Never these URL patterns." },
    formats: {
      type: "array",
      items: { type: "string", enum: FORMATS },
      maxItems: 8,
    },
    render: { type: "string", enum: ["auto", "static", "browser"] },
    via: {
      type: "string",
      enum: ["auto", "http"],
      description: "For check: http never starts Chrome.",
    },
    paths: {
      type: "array",
      items: { type: "string", maxLength: 500 },
      maxItems: 20,
      description: 'For check: paths to probe on every host, e.g. ["/api/x"].',
    },
    expect: {
      type: "string",
      maxLength: 60,
      description:
        "For check: what those paths should answer (json, html, m3u8, xml, text or a content type); the body's real shape is checked.",
    },
    readiness: {
      type: "boolean",
      description:
        "For check: open each site and report typed readiness (ready, empty, loading, login, challenge, not-found, error) with evidence.",
    },
    api: {
      type: "object",
      description: "For crawl: read a mapped site operation instead of crawling pages.",
      properties: {
        site: { type: "string" },
        operation: { type: "string" },
        params: { type: "object" },
        maxItems: { type: "integer", minimum: 1 },
      },
      required: ["site", "operation"],
    },
  },
  required: ["action"],
  additionalProperties: false,
};

export const crawlTool: AgentToolDefinition<CrawlToolInput> = {
  name: "crawl",
  description:
    "Read web pages as Markdown and data: scrape a URL, crawl a site or section, map a site's URLs, check which of many sites load, or search Google. Uses plain HTTP first and the user's browser (with their logins) when needed.",
  actions: [
    { name: "scrape", params: ["url", "query", "formats", "render"] },
    {
      name: "crawl",
      params: [
        "url",
        "query",
        "limit",
        "maxDepth",
        "include",
        "exclude",
        "formats",
        "render",
        "api",
      ],
    },
    { name: "map", params: ["url", "query", "limit"] },
    { name: "search", params: ["query", "limit"] },
    { name: "find", params: ["query", "criteria", "columns", "limit"] },
    { name: "check", params: ["urls", "file", "limit", "via", "paths", "expect", "readiness"] },
  ],
  parameters: crawlParameters,
  async run(input, context) {
    const formats =
      input.formats ?? (input.query ? ["fitMarkdown", "metadata"] : ["markdown", "metadata"]);
    const render = input.render ?? "auto";
    if (input.action === "check") {
      const urls = [...(input.urls ?? []), ...(await urlsFromFile(input.file, context.workspace))];
      if (!urls.length)
        throw new Error("Give urls (hosts or URLs) or a workspace file listing them");
      return checkSites(urls.slice(0, 5000), {
        via: input.via ?? "auto",
        ...(input.paths?.length ? { paths: input.paths.slice(0, 20) } : {}),
        ...(input.expect ? { expect: input.expect } : {}),
        ...(input.readiness === true ? { readiness: true } : {}),
      });
    }
    if (input.action === "find")
      return findList(require(input.query, "query"), {
        columns: input.columns ?? { name: "name" },
        ...(input.criteria ? { criteria: input.criteria } : {}),
        perQuery: input.limit ?? 10,
        ...(context.model ? { model: (await context.model()) as never } : {}),
      });
    if (input.action === "search")
      return search(require(input.query, "query"), { limit: input.limit ?? 10 });
    const url = require(input.url, "url");
    if (input.action === "scrape")
      return scrape(url, {
        formats,
        render,
        ...(input.query ? { query: input.query } : {}),
      });
    if (input.action === "map")
      return mapSite(url, {
        limit: input.limit ?? 500,
        ...(input.query ? { search: input.query } : {}),
      });
    return crawl({
      url,
      limit: input.limit ?? 25,
      formats,
      render,
      ...(input.maxDepth !== undefined ? { maxDepth: input.maxDepth } : {}),
      ...(input.include ? { include: input.include } : {}),
      ...(input.exclude ? { exclude: input.exclude } : {}),
      ...(input.query ? { query: input.query, strategy: "best" as const } : {}),
      ...(input.api ? { api: input.api } : {}),
    });
  },
};

export const SITE_MAPPER_TOOL_ACTIONS = [
  "sites",
  "code",
  "operations",
  "call",
  "watch",
  "learn",
  "import",
  "explore",
  "docs",
  "actions",
  "action",
  "recipe",
  "channel",
  "session",
  "export",
  "heal",
  "coverage",
  "edit",
  "name",
  "describe",
  "signing",
] as const;
export type SiteMapperToolInput = {
  action: (typeof SITE_MAPPER_TOOL_ACTIONS)[number];
  name?: string;
  steps?: string[];
  description?: string;
  change?: string;
  flow?: string;
  url?: string;
  folder?: string;
  repair?: boolean;
  actions?: boolean;
  site?: string;
  sites?: string[];
  goal?: string;
  operation?: string;
  params?: Record<string, unknown>;
  transport?: "auto" | "page" | "direct";
  files?: string[];
  key?: string;
  grep?: string | string[];
  maxFiles?: number;
  maxBytes?: number;
};

export const HOW_TO_CALL =
  "Pass params flat: path and query parameters and top-level body fields by name. Every required parameter must be passed; nothing is filled from the recording. Use body: {...} for deeper body fields.";

const siteMapperParameters: JsonObjectSchema = {
  type: "object",
  properties: {
    action: { type: "string", enum: [...SITE_MAPPER_TOOL_ACTIONS] },
    name: { type: "string", maxLength: 200, description: "For action and channel: its name." },
    steps: {
      ...strings,
      maxItems: 20,
      description: "For actions: operation ids in order, to save an action.",
    },
    description: { type: "string", maxLength: 1000 },
    change: {
      type: "string",
      maxLength: 4000,
      description: "For edit: the change in plain English.",
    },
    flow: { type: "string", maxLength: 4000, description: "For describe: the flow to perform." },
    url: { type: "string", maxLength: 2000, description: "For describe: the page to start at." },
    folder: {
      type: "string",
      maxLength: 500,
      description: "For export: the folder to write into.",
    },
    repair: { type: "boolean", description: "For heal: re-record failing operations." },
    actions: { type: "boolean", description: "For explore: also map actions in dry run." },
    site: { type: "string", maxLength: 200 },
    sites: {
      type: "array",
      items: { type: "string", maxLength: 500 },
      maxItems: 10,
      description: "For explore: site names or URLs to map.",
    },
    goal: { type: "string", maxLength: 2000, description: "For explore: extra things to do." },
    operation: { type: "string", maxLength: 200 },
    params: { type: "object" },
    transport: { type: "string", enum: ["auto", "page", "direct"] },
    files: {
      type: "array",
      items: { type: "string", maxLength: 500 },
      maxItems: 20,
      description: "For learn/import: capture files in the workspace.",
    },
    key: { type: "string", maxLength: 100, description: "For watch: the item identifier." },
    grep: {
      oneOf: [{ type: "string" }, { type: "array", items: { type: "string" }, maxItems: 20 }],
      description: "For code: a string or regex to match in chunks and manifests.",
    },
    maxFiles: { type: "integer", minimum: 1, maximum: 200 },
    maxBytes: { type: "integer", minimum: 10000, maximum: 8000000 },
  },
  required: ["action"],
  additionalProperties: false,
};

export const siteMapperTool: AgentToolDefinition<SiteMapperToolInput> = {
  name: "site_mapper",
  description:
    "Call the API a site learned while you used it (actions: code, sites, operations, call, watch, action, recipe, channel), see its published docs, keep it working (heal, coverage, edit, name, describe, signing, session, export), or map sites you haven't used: by name (explore) or from capture files (import). recipe lists or runs the site's named recipes (API first, then the page). code reads routes, chunks, source maps, robots and sitemap before guessing URLs. Calls use the user's logins.",
  actions: [
    { name: "sites", params: [] },
    { name: "code", params: ["url", "grep", "maxFiles", "maxBytes"] },
    { name: "operations", params: ["site"] },
    { name: "call", params: ["site", "operation", "params", "transport"] },
    { name: "watch", params: ["site", "operation", "params", "transport", "key"] },
    { name: "learn", params: ["site", "files"] },
    { name: "import", params: ["site", "files"] },
    { name: "explore", params: ["site", "sites", "goal", "actions"] },
    { name: "docs", params: ["site"] },
    { name: "actions", params: ["site", "name", "steps", "description"] },
    { name: "action", params: ["site", "name", "params"] },
    { name: "recipe", params: ["site", "name", "params"] },
    { name: "channel", params: ["site", "name", "params"] },
    { name: "session", params: ["site"] },
    { name: "export", params: ["site", "folder"] },
    { name: "heal", params: ["site", "repair"] },
    { name: "coverage", params: ["site"] },
    { name: "edit", params: ["site", "change"] },
    { name: "name", params: ["site"] },
    { name: "describe", params: ["site", "flow", "url", "change"] },
    { name: "signing", params: ["site", "operation", "name"] },
  ],
  parameters: siteMapperParameters,
  async run(input, context) {
    if (input.action === "sites") return { sites: await listSites() };
    if (input.action === "code")
      return readSiteCode(input.url ?? input.site ?? "", {
        ...(input.grep ? { grep: input.grep } : {}),
        ...(input.maxFiles ? { maxFiles: input.maxFiles } : {}),
        ...(input.maxBytes ? { maxBytes: input.maxBytes } : {}),
      });
    if (input.action === "explore") {
      const sites = input.sites?.length ? input.sites : input.site ? [input.site] : [];
      if (!sites.length) throw new Error("Give sites: the names or URLs of the sites to map");
      return {
        howToCall: HOW_TO_CALL,
        results: await explore(sites, {
          ...(input.goal ? { goal: input.goal } : {}),
          ...(input.actions === true ? { actions: true } : {}),
          ...(context.model ? { model: (await context.model()) as never } : {}),
        }),
      };
    }
    if (input.action === "learn" || input.action === "import")
      return learnCaptures(input, context.workspace);
    const site = normalizeSite(input);
    if (input.action === "operations") return describeOperations(site);
    if (input.action === "call") {
      if (!input.operation) throw new Error("Give the operation id (see the operations action)");
      const api = await siteMapper(site, { transport: input.transport ?? "auto" });
      return api.call(input.operation, (input.params ?? {}) as never);
    }
    if (input.action === "watch") {
      if (!input.operation)
        throw new Error("Give the operation id to watch (see the operations action)");
      return watch(site, input.operation, (input.params ?? {}) as never, {
        transport: input.transport ?? "auto",
        ...(input.key ? { key: input.key } : {}),
      });
    }
    if (isSiteToolAction(input.action))
      return runSiteToolAction(input.action, {
        ...(input as unknown as Record<string, never>),
        site,
        ...(context.model ? { model: () => context.model!().then((model) => model as never) } : {}),
        ...(input.folder && context.workspace
          ? { folder: resolve(context.workspace, input.folder) }
          : {}),
      });
    throw new Error(`Unsupported site_mapper action ${input.action}`);
  },
};

async function learnCaptures(input: SiteMapperToolInput, workspace?: string): Promise<unknown> {
  const site = normalizeSite(input);
  if (!workspace) throw new Error("This tool needs a workspace for capture files");
  if (!input.files?.length)
    throw new Error(
      "learn/import needs capture files in the workspace (a HAR export or mitmproxy flows).",
    );
  const root = resolve(workspace);
  const paths = input.files.map((file) => resolve(root, file));
  if (paths.some((path) => !path.startsWith(root)))
    throw new Error("Capture files must be inside the workspace");
  await checkCaptures(paths);
  await importCaptures(site, paths);
  const result = await rebuild(site);
  return {
    site,
    howToCall: HOW_TO_CALL,
    version: result.version,
    changed: result.changed,
    operations: result.model.operations.map(describeOperation),
  };
}

async function describeOperations(site: string): Promise<unknown> {
  const model = await loadModel(site);
  if (!model)
    throw new Error(
      `${site} has no API yet. Use the site in browser_code: its requests are learned as you go.`,
    );
  return { site, howToCall: HOW_TO_CALL, operations: model.operations.map(describeOperation) };
}

type SiteOperation = NonNullable<Awaited<ReturnType<typeof loadModel>>>["operations"][number];

function bodyFields(op: SiteOperation): Record<string, unknown> | undefined {
  const properties = Object.keys(
    (op.requestBody?.schema.properties as Record<string, unknown> | undefined) ?? {},
  );
  if (!properties.length) return undefined;
  let sample: Record<string, unknown> = {};
  try {
    sample = JSON.parse(op.samples.at(-1)?.requestBody ?? "{}") as Record<string, unknown>;
  } catch {
    // a form or text body: names only
  }
  return Object.fromEntries(
    properties.slice(0, 25).map((name) => {
      const value = JSON.stringify(sample[name] ?? null);
      return [name, value.length > 60 ? value.slice(0, 60) + "." : JSON.parse(value)];
    }),
  );
}

function describeOperation(op: SiteOperation): Record<string, unknown> {
  const body = bodyFields(op);
  return {
    id: op.id,
    what: op.summary,
    method: op.method,
    path: op.path,
    role: op.role,
    params: op.params
      .filter((param) => !param.constant && !param.generated)
      .map((param) => `${param.name}${param.required ? "" : "?"}`),
    ...(body ? { bodyFields: body } : {}),
    ...(op.pagination ? { paginated: true } : {}),
  };
}

function normalizeSite(input: SiteMapperToolInput): string {
  const value = input.site ?? (input.action !== "name" ? input.name : undefined);
  if (!value) throw new Error("Give the site, for example shop.example.com");
  const site = siteName(value);
  if (!site) throw new Error(`Give the site, for example shop.example.com, not ${value}`);
  return site;
}

function require(value: string | undefined, what: string): string {
  if (!value) throw new Error(`Give the ${what}`);
  return value;
}

async function urlsFromFile(file: string | undefined, workspace?: string): Promise<string[]> {
  if (!file) return [];
  const path = workspace ? resolve(workspace, file) : resolve(file);
  if (workspace && !path.startsWith(resolve(workspace)))
    throw new Error("The file must be in this chat's workspace");
  const text = await readFile(path, "utf8");
  try {
    const value = JSON.parse(text) as unknown;
    const items = Array.isArray(value) ? value : Object.values(value as object).flat();
    return items.map((item) =>
      typeof item === "string"
        ? item
        : String((item as { url?: string }).url ?? (item as { host?: string }).host ?? ""),
    );
  } catch {
    return text.split(/\s+/);
  }
}

/** Builds the JSON schema a host exposes: only allowed actions and their fields. */
export function toolSchema<Input extends Record<string, unknown>>(
  definition: AgentToolDefinition<Input>,
  allowed: readonly string[],
  omit: readonly string[] = [],
): JsonObjectSchema {
  const actions = new Map(definition.actions.map((action) => [action.name, action]));
  const names = new Set(["action"]);
  for (const name of allowed) {
    const action = actions.get(name);
    if (!action) throw new Error(`${definition.name} has no action ${name}`);
    for (const param of action.params) if (!omit.includes(param)) names.add(param);
  }
  const properties = Object.fromEntries(
    Object.entries(definition.parameters.properties).filter(([name]) => names.has(name)),
  );
  properties.action = {
    ...(properties.action as Record<string, unknown>),
    enum: [...allowed],
  };
  return { ...definition.parameters, properties };
}
