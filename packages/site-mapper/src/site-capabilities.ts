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

function writeNamed(value: string): boolean {
  return /\b(write|create|add|send|post|delete|remove|update|edit|checkout|purchase|buy|book|pay|save|submit)\b/i.test(
    value,
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
  const items: SiteCapabilityItem[] = [];
  const operations = model?.operations ?? [];
  const index = capabilityIndex(operations);
  const roles = new Map<string, string[]>();
  for (const [capability, ids] of Object.entries(index))
    for (const id of ids ?? []) roles.set(id, [...(roles.get(id) ?? []), capability]);
  for (const operation of operations) {
    const does = operation.role === "read" ? "read" : "write";
    items.push({
      kind: "operation",
      name: operation.id,
      title: operation.summary ?? operation.id,
      does,
      inputs: inputParams(operation).map((param) => param.name),
      how: "api",
      source: "site-mapper",
      ...(roles.get(operation.id)?.length ? { capabilities: roles.get(operation.id) } : {}),
    });
  }
  for (const recipe of recipes)
    items.push({
      kind: "recipe",
      name: recipe.name,
      title: recipe.description ?? recipe.name,
      does: writeNamed(`${recipe.name} ${recipe.description ?? ""}`) ? "write" : "read",
      inputs: recipe.params,
      how: recipe.strategies.includes("page") ? "page" : "api",
      source: "recipe",
    });
  for (const flow of flows)
    items.push({
      kind: "workflow",
      name: flow.meta.name,
      title: flow.meta.description ?? flow.meta.name,
      does: "read",
      inputs: [],
      how: "script",
      source: "flow",
    });
  for (const tool of tools.tools)
    if (tool.enabled)
      items.push({
        kind: "tool",
        name: tool.name,
        title: tool.description ?? tool.name,
        does: writeNamed(`${tool.name} ${tool.description ?? ""}`) ? "write" : "read",
        inputs: tool.params.map((param) => param.name),
        how: "script",
        source: "site-tool",
      });
  for (const tool of tools.pageTools)
    if (tool.enabled)
      items.push({
        kind: "pageTool",
        name: tool.name,
        title: tool.description ?? tool.name,
        does: writeNamed(`${tool.name} ${tool.description ?? ""}`) ? "write" : "read",
        inputs: tool.params.map((param) => param.name),
        how: "page",
        source: "site-tool",
      });
  items.sort(
    (left, right) =>
      Number(left.does === "write") - Number(right.does === "write") ||
      left.kind.localeCompare(right.kind) ||
      left.name.localeCompare(right.name),
  );
  return {
    site: host,
    items,
    notes: learnedHint(learned) ? [learnedHint(learned)] : [],
  };
}

/** Merge Aeon's skills and the page's WebMCP tools into the same answer. */
export function mergeSiteCapabilities(
  base: SiteCapabilities,
  extra: { items?: SiteCapabilityItem[]; notes?: string[] } = {},
): SiteCapabilities {
  const items = [...base.items, ...(extra.items ?? [])].sort(
    (left, right) =>
      Number(left.does === "write") - Number(right.does === "write") ||
      left.kind.localeCompare(right.kind) ||
      left.name.localeCompare(right.name),
  );
  return {
    site: base.site,
    items,
    notes: [...new Set([...base.notes, ...(extra.notes ?? [])])],
  };
}
