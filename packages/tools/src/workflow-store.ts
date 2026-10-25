// Where workflows and their runs live: plain JSON files under the host's data folder, so a
// workflow can be edited by hand, exported, imported into another machine, and read by the UI
// without a database. Runs are pruned per workflow so the folder cannot grow without bound.

import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { validateWorkflow, type WorkflowDefinition, type WorkflowRunRecord } from "./workflow.js";

export interface WorkflowSummary {
  name: string;
  slug: string;
  description?: string;
  steps: number;
  inputs: string[];
  updatedAt: string;
}

export interface WorkflowStoreOptions {
  /** Defaults to <directory>/workflows. */
  workflows?: string;
  /** Defaults to <directory>/workflow-runs. */
  runs?: string;
  /** Runs kept per workflow. Defaults to 50. */
  keepRuns?: number;
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

export async function listWorkflows(
  directory: string,
  options: WorkflowStoreOptions = {},
): Promise<WorkflowSummary[]> {
  const folder = paths(directory, options).workflows;
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
      ...(definition.description ? { description: definition.description } : {}),
    });
  }
  return summaries;
}

/** Finds a workflow by name or slug. */
export async function readWorkflow(
  directory: string,
  name: string,
  options: WorkflowStoreOptions = {},
): Promise<WorkflowDefinition | undefined> {
  const slug = workflowSlug(name);
  const direct = await readWorkflowFile(fileFor(directory, slug, options));
  if (direct) return direct;
  for (const summary of await listWorkflows(directory, options))
    if (summary.name === name) return readWorkflowFile(fileFor(directory, summary.slug, options));
  return undefined;
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
  const folder = paths(directory, options).workflows;
  await mkdir(folder, { recursive: true });
  const path = fileFor(directory, slug, options);
  await writeFile(path, JSON.stringify(checked, null, 2) + "\n", "utf8");
  return { slug, path };
}

export async function deleteWorkflow(
  directory: string,
  name: string,
  options: WorkflowStoreOptions = {},
): Promise<boolean> {
  const definition = await readWorkflow(directory, name, options);
  if (!definition) return false;
  await rm(fileFor(directory, workflowSlug(definition.name), options), { force: true });
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
