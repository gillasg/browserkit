// One answer for "what can be done on this site", merging the stores that already exist. Reads
// come first so a model reaching for a site sees search/list/detail before writes.
import { capabilityIndex } from "./infer/capabilities.js";
import { inputParams } from "./params.js";
import { listRecipes } from "./recipes.js";
import { listFlows, loadModel } from "./registry.js";
import { listSiteTools } from "./site-tools.js";
import { learnedHint, readLearned } from "./learned.js";
import { siteName } from "./registry.js";

export type CapabilityKind =
  "operation" | "recipe" | "workflow" | "tool" | "pageTool" | "skill" | "webmcp";

export interface SiteCapabilityItem {
  kind: CapabilityKind;
  name: string;
  title: string;
  does: "read" | "write";
  inputs: string[];
  how: "api" | "page" | "script";
  source: string;
  /** Operation roles such as search/list/detail/price/availability. */
  capabilities?: string[];
}

export interface SiteCapabilities {
  site: string;
  items: SiteCapabilityItem[];
  notes: string[];
}

type Model = NonNullable<Awaited<ReturnType<typeof loadModel>>>;
type Tools = Awaited<ReturnType<typeof listSiteTools>>;
type Recipe = Awaited<ReturnType<typeof listRecipes>>[number];
type Flow = Awaited<ReturnType<typeof listFlows>>[number];

function writeNamed(value: string): boolean {
  return /\b(write|create|add|send|post|delete|remove|update|edit|checkout|purchase|buy|book|pay|save|submit)\b/i.test(
    value,
  );
}

function does(name: string, description?: string): "read" | "write" {
  return writeNamed(`${name} ${description ?? ""}`) ? "write" : "read";
}

function operationItems(operations: Model["operations"]): SiteCapabilityItem[] {
  const roles = new Map<string, string[]>();
  for (const [capability, ids] of Object.entries(capabilityIndex(operations)))
    for (const id of ids ?? []) roles.set(id, [...(roles.get(id) ?? []), capability]);
  return operations.map((operation) => {
    const tags = roles.get(operation.id);
    return {
      kind: "operation",
      name: operation.id,
      title: operation.summary ?? operation.id,
      does: operation.role === "read" ? "read" : "write",
      inputs: inputParams(operation).map((param) => param.name),
      how: "api",
      source: "site-mapper",
      ...(tags?.length ? { capabilities: tags } : {}),
    };
  });
}

const recipeItem = (recipe: Recipe): SiteCapabilityItem => ({
  kind: "recipe",
  name: recipe.name,
  title: recipe.description ?? recipe.name,
  does: does(recipe.name, recipe.description),
  inputs: recipe.params,
  how: recipe.strategies.includes("page") ? "page" : "api",
  source: "recipe",
});

const flowItem = (flow: Flow): SiteCapabilityItem => ({
  kind: "workflow",
  name: flow.meta.name,
  title: flow.meta.description ?? flow.meta.name,
  does: "read",
  inputs: [],
  how: "script",
  source: "flow",
});

function toolItems(tools: Tools): SiteCapabilityItem[] {
  const one = (tool: Tools["tools"][number], kind: "tool" | "pageTool"): SiteCapabilityItem => ({
    kind,
    name: tool.name,
    title: tool.description ?? tool.name,
    does: does(tool.name, tool.description),
    inputs: tool.params.map((param) => param.name),
    how: kind === "tool" ? "script" : "page",
    source: "site-tool",
  });
  return [
    ...tools.tools.filter((tool) => tool.enabled).map((tool) => one(tool, "tool")),
    ...tools.pageTools.filter((tool) => tool.enabled).map((tool) => one(tool, "pageTool")),
  ];
}

function sortItems(items: SiteCapabilityItem[]): SiteCapabilityItem[] {
  return items.sort(
    (left, right) =>
      Number(left.does === "write") - Number(right.does === "write") ||
      left.kind.localeCompare(right.kind) ||
      left.name.localeCompare(right.name),
  );
}

/** The merged inventory for a site. Missing stores simply contribute nothing. */
export async function siteCapabilities(site: string): Promise<SiteCapabilities> {
  const host = siteName(site);
  const [model, recipes, flows, tools, learned] = await Promise.all([
    loadModel(host).catch(() => undefined),
    listRecipes(host).catch(() => []),
    listFlows(host).catch(() => []),
    listSiteTools(host).catch(() => ({ tools: [], pageTools: [] })),
    readLearned(host).catch(() => undefined),
  ]);
  const items = [
    ...operationItems(model?.operations ?? []),
    ...recipes.map(recipeItem),
    ...flows.map(flowItem),
    ...toolItems(tools as Tools),
  ];
  const hint = learnedHint(learned);
  return { site: host, items: sortItems(items), notes: hint ? [hint] : [] };
}

/** Merge Aeon's skills and the page's WebMCP tools into the same answer. */
export function mergeSiteCapabilities(
  base: SiteCapabilities,
  extra: { items?: SiteCapabilityItem[]; notes?: string[] } = {},
): SiteCapabilities {
  return {
    site: base.site,
    items: sortItems([...base.items, ...(extra.items ?? [])]),
    notes: [...new Set([...base.notes, ...(extra.notes ?? [])])],
  };
}
