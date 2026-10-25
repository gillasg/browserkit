// Where workflows and their runs live: plain JSON files under the host's data folder, so a
// workflow can be edited by hand, exported, imported into another machine, and read by the UI
// without a database. Runs are pruned per workflow so the folder cannot grow without bound.

import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { registryRoot, siteDir } from "@browserkit/site-mapper";
import { validateWorkflow, type WorkflowDefinition, type WorkflowRunRecord } from "./workflow.js";

export interface WorkflowSummary {
  name: string;
  slug: string;
  description?: string;
  /** The site whose pack holds this workflow; absent for a host-level workflow. */
  site?: string;
  steps: number;
  inputs: string[];
  updatedAt: string;
}

export interface ResolvedWorkflow {
  definition: WorkflowDefinition;
  /** The site pack it came from, when it lives next to that site's recipes. */
  site?: string;
  path: string;
}

export interface WorkflowStoreOptions {
  /** Defaults to <directory>/workflows. */
  workflows?: string;
  /** Defaults to <directory>/workflow-runs. */
  runs?: string;
  /** Runs kept per workflow. Defaults to 50. */
  keepRuns?: number;
  /** Look in this site's pack first. */
  site?: string;
}

const KEEP_RUNS = 50;

function paths(directory: string, options: WorkflowStoreOptions = {}) {
  return {
    workflows: options.workflows ?? join(directory, "workflows"),
    runs: options.runs ?? join(directory, "workflow-runs"),
    keepRuns: options.keepRuns ?? KEEP_RUNS,
  };
}

export function workflowSlug(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function fileFor(directory: string, slug: string, options: WorkflowStoreOptions): string {
  return join(paths(directory, options).workflows, `${slug}.json`);
}

/** Workflows that belong to a site live in that site's pack, next to its recipes. */
async function siteWorkflowFolders(): Promise<{ site?: string; folder: string }[]> {
  // Every pack folder, not only mapped sites: a workflow can be recorded before its model.
  const root = join(registryRoot(), "sites");
  const names = await readdir(root).catch(() => [] as string[]);
  return names.map((name) => ({ folder: join(root, name, "workflows") }));
}

async function summariesIn(folder: string, site?: string): Promise<WorkflowSummary[]> {
  const files = await readdir(folder).catch(() => [] as string[]);
  const summaries: WorkflowSummary[] = [];
  for (const file of files.filter((name) => name.endsWith(".json")).sort()) {
    const definition = await readWorkflowFile(join(folder, file));
    if (!definition) continue;
    summaries.push({
      name: definition.name,
      slug: workflowSlug(definition.name),
      steps: definition.steps.length,
      inputs: Object.keys(definition.inputs ?? {}),
      updatedAt: await modifiedAt(join(folder, file)),
      ...((site ?? definition.site) ? { site: site ?? definition.site } : {}),
      ...(definition.description ? { description: definition.description } : {}),
    });
  }
  return summaries;
}

export async function listWorkflows(
  directory: string,
  options: WorkflowStoreOptions = {},
): Promise<WorkflowSummary[]> {
  const byName = new Map<string, WorkflowSummary>();
  // A site's own workflow wins over a host-level one with the same name.
  for (const { folder } of await siteWorkflowFolders())
    for (const summary of await summariesIn(folder))
      if (!byName.has(summary.name)) byName.set(summary.name, summary);
  for (const summary of await summariesIn(paths(directory, options).workflows))
    if (!byName.has(summary.name)) byName.set(summary.name, summary);
  return [...byName.values()];
}

/**
 * Finds a workflow by name or slug across one system: the named site's pack first, then the
 * host's own folder, then any other site pack. This is the level order hosts show.
 */
export async function resolveWorkflow(
  directory: string,
  name: string,
  options: WorkflowStoreOptions = {},
): Promise<ResolvedWorkflow | undefined> {
  const slug = workflowSlug(name);
  const candidates: { path: string; site?: string }[] = [];
  if (options.site)
    candidates.push({
      path: join(siteDir(options.site), "workflows", `${slug}.json`),
      site: options.site,
    });
  candidates.push({ path: fileFor(directory, slug, options) });
  for (const { folder } of await siteWorkflowFolders())
    candidates.push({ path: join(folder, `${slug}.json`) });
  for (const candidate of candidates) {
    const definition = await readWorkflowFile(candidate.path);
    if (definition)
      return {
        definition,
        path: candidate.path,
        ...((candidate.site ?? definition.site) ? { site: candidate.site ?? definition.site } : {}),
      };
  }
  for (const summary of await listWorkflows(directory, options)) {
    if (summary.name !== name && summary.slug !== slug) continue;
    const folder = summary.site
      ? join(siteDir(summary.site), "workflows")
      : paths(directory, options).workflows;
    const definition = await readWorkflowFile(join(folder, `${summary.slug}.json`));
    if (definition)
      return {
        definition,
        path: join(folder, `${summary.slug}.json`),
        ...(summary.site ? { site: summary.site } : {}),
      };
  }
  return undefined;
}

/** Finds a workflow by name or slug. */
export async function readWorkflow(
  directory: string,
  name: string,
  options: WorkflowStoreOptions = {},
): Promise<WorkflowDefinition | undefined> {
  return (await resolveWorkflow(directory, name, options))?.definition;
}

async function readWorkflowFile(path: string): Promise<WorkflowDefinition | undefined> {
  try {
    return validateWorkflow(JSON.parse(await readFile(path, "utf8")));
  } catch {
    return undefined;
  }
}

export async function saveWorkflow(
  directory: string,
  definition: WorkflowDefinition,
  options: WorkflowStoreOptions = {},
): Promise<{ slug: string; path: string }> {
  const checked = validateWorkflow(definition);
  const slug = workflowSlug(checked.name);
  if (!slug) throw new Error("A workflow name needs at least one letter or number");
  const folder = checked.site
    ? join(siteDir(checked.site), "workflows")
    : paths(directory, options).workflows;
  await mkdir(folder, { recursive: true });
  const path = join(folder, `${slug}.json`);
  await writeFile(path, JSON.stringify(checked, null, 2) + "\n", "utf8");
  return { slug, path };
}

export async function deleteWorkflow(
  directory: string,
  name: string,
  options: WorkflowStoreOptions = {},
): Promise<boolean> {
  const resolved = await resolveWorkflow(directory, name, options);
  if (!resolved) return false;
  const definition = resolved.definition;
  await rm(resolved.path, { force: true });
  await rm(join(paths(directory, options).runs, workflowSlug(definition.name)), {
    recursive: true,
    force: true,
  });
  return true;
}

/** Reads a definition from a JSON file so it can be saved or run where it came from. */
export async function importWorkflowFile(path: string): Promise<WorkflowDefinition> {
  return validateWorkflow(JSON.parse(await readFile(path, "utf8")));
}

export async function exportWorkflow(
  directory: string,
  name: string,
  out: string,
  options: WorkflowStoreOptions = {},
): Promise<{ name: string; out: string }> {
  const definition = await readWorkflow(directory, name, options);
  if (!definition) throw new Error(`No workflow ${JSON.stringify(name)}`);
  await writeFile(out, JSON.stringify(definition, null, 2) + "\n", "utf8");
  return { name: definition.name, out };
}

export async function writeRun(
  directory: string,
  record: WorkflowRunRecord,
  options: WorkflowStoreOptions = {},
): Promise<{ path: string; pruned: number }> {
  const folder = join(paths(directory, options).runs, workflowSlug(record.workflow));
  await mkdir(folder, { recursive: true });
  const path = join(folder, `${record.id}.json`);
  await writeFile(path, JSON.stringify(record, null, 2) + "\n", "utf8");
  return { path, pruned: await prune(folder, paths(directory, options).keepRuns) };
}

async function prune(folder: string, keep: number): Promise<number> {
  const files = (await readdir(folder).catch(() => [] as string[]))
    .filter((name) => name.endsWith(".json"))
    .sort();
  const extra = files.slice(0, Math.max(0, files.length - keep));
  for (const file of extra) await rm(join(folder, file), { force: true });
  return extra.length;
}

export async function listRuns(
  directory: string,
  workflow: string,
  options: WorkflowStoreOptions = {},
): Promise<WorkflowRunRecord[]> {
  const folder = join(paths(directory, options).runs, workflowSlug(workflow));
  const files = (await readdir(folder).catch(() => [] as string[]))
    .filter((name) => name.endsWith(".json"))
    .sort()
    .reverse();
  const runs: WorkflowRunRecord[] = [];
  for (const file of files) {
    try {
      runs.push(JSON.parse(await readFile(join(folder, file), "utf8")) as WorkflowRunRecord);
    } catch {
      // A half-written run is not worth failing a listing over.
    }
  }
  return runs;
}

export async function readRun(
  directory: string,
  workflow: string,
  id: string,
  options: WorkflowStoreOptions = {},
): Promise<WorkflowRunRecord | undefined> {
  const path = join(paths(directory, options).runs, workflowSlug(workflow), `${id}.json`);
  try {
    return JSON.parse(await readFile(path, "utf8")) as WorkflowRunRecord;
  } catch {
    return undefined;
  }
}

async function modifiedAt(path: string): Promise<string> {
  try {
    return (await stat(path)).mtime.toISOString();
  } catch {
    return new Date(0).toISOString();
  }
}
