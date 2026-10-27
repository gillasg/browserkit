// One answer for what can be done on a site: its abilities, the mapped operations they can use,
// and the site's notes. WebMCP tools are added by the browser runtime, which can see the page.

import { listAbilities, readSiteNotes } from "./abilities.js";
import { capabilityIndex } from "./infer/capabilities.js";
import { inputParams } from "./params.js";
import { loadModel, siteName } from "./registry.js";

export interface SiteAbilitySummary {
  name: string;
  title: string;
  does: "read" | "write";
  inputs: string[];
  ways: string[];
  stats?: { runs: number; failures: number; lastOkAt?: string; lastUsedAt?: string };
}

export interface SiteOperationSummary {
  name: string;
  title: string;
  does: "read" | "write";
  inputs: string[];
  capabilities?: string[];
}

export interface SiteCapabilities {
  site: string;
  abilities: SiteAbilitySummary[];
  operations: SiteOperationSummary[];
  notes: string;
}

/** The merged inventory for a site. Missing stores simply contribute nothing. */
export async function siteCapabilities(site: string): Promise<SiteCapabilities> {
  const host = siteName(site);
  const [abilities, notes, model] = await Promise.all([
    listAbilities(host).catch(() => []),
    readSiteNotes(host).catch(() => ""),
    loadModel(host).catch(() => undefined),
  ]);
  const operations = model?.operations ?? [];
  const index = capabilityIndex(operations);
  const roles = new Map<string, string[]>();
  for (const [capability, ids] of Object.entries(index))
    for (const id of ids ?? []) roles.set(id, [...(roles.get(id) ?? []), capability]);
  return {
    site: host,
    abilities: abilities.map((ability) => ({
      name: ability.name,
      title: ability.description ?? ability.name,
      does: ability.kind,
      inputs: Object.keys((ability.inputs.properties ?? {}) as Record<string, unknown>),
      ways: ability.ways.map((way) => way.kind),
      stats: ability.stats,
    })),
    operations: operations.map((operation) => ({
      name: operation.id,
      title: operation.summary ?? operation.id,
      does: operation.role === "read" ? "read" : "write",
      inputs: inputParams(operation).map((param) => param.name),
      ...(roles.get(operation.id)?.length ? { capabilities: roles.get(operation.id) } : {}),
    })),
    notes,
  };
}

/** Merge WebMCP tools the page exposes into the same answer. */
export function withWebMcp(
  base: SiteCapabilities,
  tools: { name: string; description?: string }[],
): SiteCapabilities {
  const clean = tools.filter((tool) => tool.name);
  if (!clean.length) return base;
  return {
    ...base,
    abilities: [
      ...base.abilities,
      ...clean.map((tool) => ({
        name: tool.name,
        title: tool.description ?? tool.name,
        does: "read" as const,
        inputs: [],
        ways: ["webmcp"],
      })),
    ],
  };
}
