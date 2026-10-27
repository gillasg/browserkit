// One-time conversion of every old per-site store into abilities + notes. Old files are copied
// to backup-abilities-<timestamp>/ and never deleted; a version file makes this run once.

import { cp, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  abilityDirectory,
  createAbility,
  maintainAbilities,
  writeSiteNotes,
  type Ability,
} from "./abilities.js";
import { readLearned, learnedHint } from "./learned.js";
import { registryRoot, siteDir, siteName } from "./registry.js";
import { type RecipeParam, type SiteRecipe } from "./recipes.js";
import { readSiteTools, type SiteTool } from "./site-tools.js";
import type { SiteAction } from "./runtime/actions.js";

export interface MigrationSkill {
  name: string;
  domains?: string[];
  description?: string;
  examples?: string;
  code?: string;
}

export interface Unmigrated {
  kind: string;
  name?: string;
  reason: string;
}

export interface SiteMigrationReport {
  site: string;
  dryRun: boolean;
  skipped?: boolean;
  backup?: string;
  counts: Record<string, number>;
  abilities: string[];
  notes: boolean;
  unmigrated: Unmigrated[];
}

export interface MigrationOptions {
  dryRun?: boolean;
  force?: boolean;
  sourceKind?: string;
  skills?: MigrationSkill[];
  skillsDirectory?: string;
}

export interface MigrationReport {
  at: string;
  dryRun: boolean;
  sites: SiteMigrationReport[];
  totals: Record<string, number>;
  unmigrated: Unmigrated[];
}

type AbilityDraft = Omit<
  Ability,
  "name" | "site" | "stats" | "createdAt" | "updatedAt" | "createdBy"
>;

const VERSION = 1;
const VERSION_FILE = "migration.json";
const REPORT_FILE = "migration-report.json";
const BACKUP_PREFIX = "backup-abilities-";
const STORE_FILES = [
  "recipes.json",
  "overrides.json",
  "tools.json",
  "learned.json",
  "actions.json",
];
const STORE_FOLDERS = ["workflows"];

export async function migrateAllAbilities(
  options: MigrationOptions = {},
): Promise<MigrationReport> {
  const names = await siteNames();
  const skills = options.skills ?? (await readSkills(options.skillsDirectory));
  const sites: SiteMigrationReport[] = [];
  for (const site of names) sites.push(await migrateSiteAbilities(site, { ...options, skills }));
  if (!options.dryRun)
    for (const site of names) await maintainAbilities(site).catch(() => undefined);
  const totals: Record<string, number> = {};
  for (const report of sites)
    for (const [kind, count] of Object.entries(report.counts))
      totals[kind] = (totals[kind] ?? 0) + count;
  return {
    at: new Date().toISOString(),
    dryRun: options.dryRun === true,
    sites,
    totals,
    unmigrated: sites.flatMap((report) => report.unmigrated),
  };
}

export async function migrateSiteAbilities(
  site: string,
  options: MigrationOptions = {},
): Promise<SiteMigrationReport> {
  const host = siteName(site);
  const folder = siteDir(host);
  const versionPath = join(abilityDirectory(host), VERSION_FILE);
  const report: SiteMigrationReport = {
    site: host,
    dryRun: options.dryRun === true,
    counts: {},
    abilities: [],
    notes: false,
    unmigrated: [],
  };
  if (!options.force && !options.dryRun && (await exists(versionPath))) {
    return { ...report, skipped: true };
  }

  const backup = options.dryRun
    ? undefined
    : await backupStores(host, options.skillsDirectory, options.skills);
  if (backup) report.backup = backup;

  const add = async (kind: string, name: string, ability: AbilityDraft): Promise<void> => {
    report.counts[kind] = (report.counts[kind] ?? 0) + 1;
    if (options.dryRun) {
      report.abilities.push(`${name} (${kind})`);
      return;
    }
    try {
      const saved = await createAbility({
        ...ability,
        name,
        site: host,
        createdBy: options.sourceKind === "pack" ? "import" : "user",
      });
      report.abilities.push(saved.ability.name);
    } catch (error) {
      report.unmigrated.push({
        kind,
        name,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  };

  await migrateRecipes(folder, host, options, report, add);
  await migrateActions(folder, host, options, report, add);
  await migrateWorkflows(folder, host, options, report, add);
  await migrateTools(host, options, report, add);
  await migrateNotes(host, options, report, add);
  if (!options.dryRun) {
    await mkdir(abilityDirectory(host), { recursive: true });
    await writeFile(
      versionPath,
      JSON.stringify({ version: VERSION, at: new Date().toISOString() }, null, 2) + "\n",
    );
    await writeFile(
      join(abilityDirectory(host), REPORT_FILE),
      JSON.stringify(report, null, 2) + "\n",
    );
  }
  return report;
}

type AddAbility = (kind: string, name: string, ability: AbilityDraft) => Promise<void>;

async function migrateRecipes(
  folder: string,
  host: string,
  options: MigrationOptions,
  report: SiteMigrationReport,
  add: AddAbility,
): Promise<void> {
  const recipes = await readJson(join(folder, "recipes.json"));
  if (recipes?.error) report.unmigrated.push({ kind: "recipes", reason: recipes.error });
  for (const recipe of recipeItems(recipes?.value)) {
    if (!validRecipe(recipe)) {
      report.unmigrated.push({
        kind: "recipe",
        name: String((recipe as { name?: unknown } | undefined)?.name ?? ""),
        reason: "bad recipe",
      });
      continue;
    }
    await add("recipe", recipe.name, abilityFromRecipe(host, recipe, options.sourceKind));
  }
}

function recipeItems(value: unknown): unknown[] {
  const recipes = (value as { recipes?: unknown } | undefined)?.recipes;
  return Array.isArray(recipes) ? recipes : [];
}

function validRecipe(recipe: unknown): recipe is SiteRecipe {
  const item = recipe as SiteRecipe | undefined;
  return Boolean(item?.name && Array.isArray(item.strategies));
}

async function migrateActions(
  folder: string,
  host: string,
  options: MigrationOptions,
  report: SiteMigrationReport,
  add: AddAbility,
): Promise<void> {
  const overrides = await readJson(join(folder, "overrides.json"));
  if (overrides?.error) report.unmigrated.push({ kind: "overrides", reason: overrides.error });
  const actions = (overrides?.value as { actions?: Record<string, SiteAction> } | undefined)
    ?.actions;
  for (const [name, action] of Object.entries(actions ?? {})) {
    if (!action || !Array.isArray(action.steps)) {
      report.unmigrated.push({ kind: "action", name, reason: "bad action" });
      continue;
    }
    await add("action", name, abilityFromAction(host, name, action, options.sourceKind));
  }
}

async function migrateWorkflows(
  folder: string,
  host: string,
  options: MigrationOptions,
  report: SiteMigrationReport,
  add: AddAbility,
): Promise<void> {
  const files = await readdir(join(folder, "workflows")).catch(() => [] as string[]);
  for (const file of files.filter((name) => name.endsWith(".json"))) {
    const read = await readJson(join(folder, "workflows", file));
    const workflow = read?.value as { name?: string; steps?: unknown[]; description?: string };
    if (read?.error || !workflow?.name || !Array.isArray(workflow.steps)) {
      report.unmigrated.push({
        kind: "workflow",
        name: file,
        reason: read?.error ?? "bad workflow",
      });
      continue;
    }
    await add("workflow", workflow.name, abilityFromWorkflow(host, workflow, options.sourceKind));
  }
}

async function migrateTools(
  host: string,
  options: MigrationOptions,
  report: SiteMigrationReport,
  add: AddAbility,
): Promise<void> {
  const tools = await readSiteTools(host).catch(() => undefined);
  for (const [kind, list] of [
    ["tool", tools?.tools ?? []],
    ["pageTool", tools?.pageTools ?? []],
  ] as const)
    for (const tool of list)
      await add(
        kind,
        tool.name,
        abilityFromTool(host, tool, kind === "pageTool", options.sourceKind),
      );
}

async function migrateNotes(
  host: string,
  options: MigrationOptions,
  report: SiteMigrationReport,
  add: AddAbility,
): Promise<void> {
  const learned = await readLearned(host);
  const notes: string[] = [];
  if (learned) {
    report.counts.learnedNote = 1;
    notes.push(`# ${host}`, "", learnedHint(learned));
    if (learned.note) notes.push("", learned.note);
  }
  for (const skill of (options.skills ?? []).filter((item) => skillMatches(item, host))) {
    const skillNotes = skillToNotes(skill);
    if (skillNotes) notes.push("", skillNotes);
    if (skill.code?.trim())
      await add("skill", skill.name, abilityFromSkill(host, skill, options.sourceKind));
  }
  if (!notes.filter(Boolean).length) return;
  report.notes = true;
  if (!options.dryRun)
    await writeSiteNotes(host, notes.join("\n"), { append: true }).catch(() => undefined);
}

/** An old site pack imports through the same converter (pack files are already installed). */
export async function importPackAbilities(
  site: string,
  skills: MigrationSkill[] = [],
): Promise<SiteMigrationReport> {
  return migrateSiteAbilities(site, { force: true, sourceKind: "pack", skills });
}

export function abilityFromRecipe(
  site: string,
  recipe: SiteRecipe,
  sourceKind = "recipe",
): AbilityDraft {
  const ways = recipe.strategies.map((strategy) => {
    if (strategy.kind === "api")
      return {
        kind: "api" as const,
        operation: strategy.operation,
        ...(strategy.open ? { open: strategy.open } : {}),
        ...(strategy.params ? { params: strategy.params } : {}),
        ...(strategy.pagination ? { paging: strategy.pagination } : {}),
        ...(strategy.records ? { records: strategy.records } : {}),
      };
    if (strategy.kind === "collect") return { kind: "page" as const, collect: strategy.collect };
    if (strategy.kind === "workflow")
      return {
        kind: "steps" as const,
        ...(strategy.name ? { name: strategy.name } : {}),
        ...(strategy.workflow ? { workflow: strategy.workflow } : {}),
        ...(strategy.params ? { params: strategy.params } : {}),
      };
    return { kind: "script" as const, code: strategy.code, runtime: "page" as const };
  });
  return {
    description: recipe.description,
    kind:
      recipe.write || writeName(`${recipe.name} ${recipe.description ?? ""}`) ? "write" : "read",
    inputs: inputsFromRecipeParams(recipe.params),
    ways,
    options: {
      ...(recipe.strategies.find((strategy) => strategy.kind === "api")?.pagination
        ? { paging: recipe.strategies.find((strategy) => strategy.kind === "api")?.pagination }
        : {}),
      recordMapping: {
        map: recipe.map,
        key: recipe.key,
        filter: recipe.filter,
        limit: recipe.limit,
        render: recipe.render,
        thread: recipe.thread,
        derive: recipe.derive,
        resultKind: recipe.kind,
      },
      ...(recipe.write ? { write: recipe.write } : {}),
      ...(recipe.source ? { source: recipe.source } : {}),
      ...(recipe.health ? { health: recipe.health } : {}),
    },
    sourceKind,
  };
}

export function abilityFromAction(
  site: string,
  name: string,
  action: SiteAction,
  sourceKind = "action",
): AbilityDraft {
  return {
    description: action.description,
    kind: writeName(`${name} ${action.description ?? ""}`) ? "write" : "read",
    inputs: {},
    ways: [
      {
        kind: "api",
        operations: action.steps.map((step) => ({
          operation: step.operation,
          ...(step.params ? { params: step.params } : {}),
        })),
      },
    ],
    options: {},
    sourceKind,
  };
}

export function abilityFromWorkflow(
  site: string,
  workflow: { name?: string; description?: string; steps?: unknown[]; inputs?: unknown },
  sourceKind = "workflow",
): AbilityDraft {
  return {
    description: workflow.description,
    kind: writeName(`${workflow.name ?? ""} ${workflow.description ?? ""}`) ? "write" : "read",
    inputs: inputsFromWorkflow(workflow.inputs),
    ways: [{ kind: "steps", workflow }],
    options: {},
    sourceKind,
  };
}

export function abilityFromTool(
  site: string,
  tool: SiteTool,
  page = false,
  sourceKind = page ? "pageTool" : "tool",
): AbilityDraft {
  const code = page
    ? `async (page, bu, inputs) => { const args = inputs; ${tool.code}\n }`
    : tool.code;
  return {
    description: tool.description,
    kind: writeName(`${tool.name} ${tool.description ?? ""}`) ? "write" : "read",
    inputs: inputsFromToolParams(tool.params),
    ways: [{ kind: "script", code, runtime: page ? "page" : "node" }],
    options: {},
    sourceKind,
  };
}

export function abilityFromSkill(
  site: string,
  skill: MigrationSkill,
  sourceKind = "skill",
): AbilityDraft {
  return {
    description: skill.description,
    kind: "read",
    inputs: {},
    ways: [
      {
        kind: "script",
        code: `async (page, bu, inputs) => { ${skill.code ?? ""}\n return inputs; }`,
        runtime: "page",
      },
    ],
    options: { examples: skill.examples },
    sourceKind,
  };
}

function inputsFromRecipeParams(
  params: Record<string, RecipeParam> | undefined,
): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const [name, param] of Object.entries(params ?? {})) {
    properties[name] = {
      type: param.type ?? "string",
      ...(param.description ? { description: param.description } : {}),
      ...(param.default !== undefined ? { default: param.default } : {}),
    };
    if (param.required) required.push(name);
  }
  return { type: "object", properties, ...(required.length ? { required } : {}) };
}

function inputsFromToolParams(params: SiteTool["params"]): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const param of params ?? []) {
    properties[param.name] = {
      type: param.type,
      ...(param.default !== undefined ? { default: param.default } : {}),
    };
    if (param.required) required.push(param.name);
  }
  return { type: "object", properties, ...(required.length ? { required } : {}) };
}

function inputsFromWorkflow(inputs: unknown): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  if (inputs && typeof inputs === "object")
    for (const [name, spec] of Object.entries(inputs as Record<string, unknown>)) {
      const item = (spec ?? {}) as { description?: string; type?: string; default?: unknown };
      properties[name] = {
        type: item.type ?? "string",
        ...(item.description ? { description: item.description } : {}),
        ...(item.default !== undefined ? { default: item.default } : {}),
      };
      if ((spec as { required?: boolean } | undefined)?.required) required.push(name);
    }
  return { type: "object", properties, ...(required.length ? { required } : {}) };
}

function skillToNotes(skill: MigrationSkill): string {
  const lines = [`## Skill: ${skill.name}`];
  if (skill.description) lines.push("", skill.description);
  if (skill.examples) lines.push("", skill.examples);
  if (skill.code?.trim()) lines.push("", "```js", skill.code.trim(), "```");
  return lines.join("\n");
}

function skillMatches(skill: MigrationSkill, host: string): boolean {
  return (skill.domains ?? []).some((domain) => {
    const clean = String(domain).toLowerCase();
    return clean.startsWith("*.")
      ? host === clean.slice(2) || host.endsWith(clean.slice(1))
      : host === clean || host.endsWith("." + clean);
  });
}

function writeName(text: string): boolean {
  return /\b(write|create|add|send|post|delete|remove|update|edit|checkout|purchase|buy|book|pay|save|submit|like|follow|comment|reply)\b/i.test(
    text,
  );
}

async function siteNames(): Promise<string[]> {
  const root = join(registryRoot(), "sites");
  const names = await readdir(root).catch(() => [] as string[]);
  const sites: string[] = [];
  for (const folder of names) {
    const model = await readJson(join(root, folder, "model.json"));
    const site = (model?.value as { site?: string } | undefined)?.site;
    if (site) sites.push(siteName(site));
    else if (!model?.error) sites.push(siteName(folder.replace(/_/g, ":")));
  }
  return [...new Set(sites)];
}

async function readSkills(directory: string | undefined): Promise<MigrationSkill[]> {
  if (!directory) return [];
  const files = (await readdir(directory).catch(() => [] as string[])).filter((file) =>
    file.endsWith(".json"),
  );
  const skills = await Promise.all(files.map((file) => readJson(join(directory, file))));
  return skills
    .map((item) => item?.value as MigrationSkill | undefined)
    .filter((item): item is MigrationSkill => !!item?.name);
}

async function backupStores(
  site: string,
  skillsDirectory: string | undefined,
  skills: MigrationSkill[] | undefined,
): Promise<string | undefined> {
  const folder = siteDir(site);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backup = join(folder, BACKUP_PREFIX + stamp);
  await mkdir(join(backup, "site"), { recursive: true });
  let copied = false;
  for (const name of STORE_FILES) {
    if (await exists(join(folder, name))) {
      await cp(join(folder, name), join(backup, "site", name));
      copied = true;
    }
  }
  for (const name of STORE_FOLDERS) {
    if (await exists(join(folder, name))) {
      await cp(join(folder, name), join(backup, "site", name), { recursive: true });
      copied = true;
    }
  }
  if (skillsDirectory && (await exists(skillsDirectory))) {
    await cp(skillsDirectory, join(backup, "skills"), { recursive: true });
    copied = true;
  } else if (skills?.length) {
    await mkdir(join(backup, "skills"), { recursive: true });
    for (const skill of skills)
      await writeFile(
        join(backup, "skills", `${skill.name}.json`),
        JSON.stringify(skill, null, 2) + "\n",
      );
    copied = true;
  }
  if (!copied) {
    await rm(backup, { recursive: true, force: true });
    return undefined;
  }
  return backup;
}

async function readJson(path: string): Promise<{ value?: unknown; error?: string }> {
  try {
    return { value: JSON.parse(await readFile(path, "utf8")) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return /ENOENT/.test(message) ? {} : { error: message };
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
