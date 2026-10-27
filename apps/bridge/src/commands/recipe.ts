import { resolve } from "node:path";
import {
  browserRecipeHost,
  builtinRecipes,
  deleteRecipe,
  draftRecipeFromModel,
  exportRecipes,
  importRecipes,
  installBuiltinRecipes,
  listRecipes,
  listSites,
  loadModel,
  readFeed,
  readRecipe,
  readSitePack,
  runRecipe,
  saveRecipe,
  siteName,
  validateRecipe,
  type SiteRecipe,
} from "@browserkit/tools/site-to-api";
import { runWorkflow, validateWorkflow } from "@browserkit/tools/workflow";
import { workflowActions } from "@browserkit/tools/workflow-actions";
import { resolveWorkflow } from "@browserkit/tools/workflow-store";
import { flag, has, jsonValue, type Args } from "../args.js";
import { BridgeClient } from "../client.js";
import { printJson } from "../output.js";
import { dataDirectory } from "../paths.js";
import type { Command } from "../usage.js";

// Site recipes: the named, reusable way to read one site. A recipe lives in the site's pack and
// is tried in order: its captured API with cursor paging, then the page, then a script. Records
// are mapped, de-duplicated, optionally rendered as a feed, and written recipes keep receipts.

const SESSION = "browserkit-cli";

async function runCell(code: string): Promise<unknown> {
  const bridge = await BridgeClient.connect();
  try {
    const reply = await bridge.request("run", { code, session: SESSION });
    if (reply.error) throw new Error(String(reply.error));
    return reply.value;
  } finally {
    bridge.close();
  }
}

/**
 * The recipe host, plus the workflow engine: a recipe's workflow strategy and a workflow's
 * recipe action are the two directions of one system, so both resolve names the same way.
 */
async function recipeHost(site: string) {
  const host = await browserRecipeHost(site, { session: SESSION });
  return {
    ...host,
    workflow: async (request: {
      name?: string;
      workflow?: unknown;
      inputs: Record<string, unknown>;
    }) => {
      const resolved = request.name
        ? await resolveWorkflow(dataDirectory(), request.name, { site: siteName(site) })
        : undefined;
      const definition = request.workflow
        ? validateWorkflow(request.workflow)
        : resolved?.definition;
      if (!definition)
        throw new Error(`No workflow ${JSON.stringify(request.name ?? "")} for ${siteName(site)}`);
      const record = await runWorkflow(definition, {
        inputs: request.inputs,
        actions: workflowActions(runCell),
      });
      const last = record.steps[record.steps.length - 1];
      return last?.result ?? record;
    },
  };
}

function inputsFrom(args: Args): Record<string, unknown> {
  const raw = flag(args, "inputs");
  if (!raw) return {};
  const parsed = jsonValue(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error(
      '--inputs takes a JSON object, e.g. --inputs \'{"url":"https://x.com/a/status/1"}\'',
    );
  return parsed as Record<string, unknown>;
}

async function listCommand(args: Args): Promise<number> {
  const wanted = args.positional[1];
  const sites = wanted ? [siteName(wanted)] : (await listSites()).map((site) => site.site);
  const rows: {
    site: string;
    name: string;
    kind: string;
    strategies: string[];
    description?: string;
  }[] = [];
  for (const site of sites)
    for (const recipe of await listRecipes(site))
      rows.push({
        site,
        name: recipe.name,
        kind: recipe.kind,
        strategies: recipe.strategies,
        ...(recipe.description ? { description: recipe.description } : {}),
      });
  if (has(args, "json")) {
    printJson(rows);
    return 0;
  }
  if (!rows.length) {
    process.stdout.write(
      "No recipes yet. Install the built-in pack (browserkit recipe install x.com) or draft one from a mapped site.\n",
    );
    return 0;
  }
  for (const row of rows)
    process.stdout.write(
      `${row.site}  ${row.name.padEnd(24)} ${row.kind.padEnd(6)} ${row.strategies.join(" -> ")}` +
        `${row.description ? `  ${row.description}` : ""}\n`,
    );
  return 0;
}

async function show(args: Args): Promise<number> {
  const [site, name] = args.positional.slice(1);
  if (!site || !name) throw new Error("Usage: browserkit recipe show <site> <name> [--json]");
  const recipe = await readRecipe(site, name);
  if (!recipe) throw new Error(`No recipe ${JSON.stringify(name)} for ${site}`);
  if (has(args, "json")) {
    printJson(recipe);
    return 0;
  }
  process.stdout.write(`${recipe.name}${recipe.description ? ` — ${recipe.description}` : ""}\n`);
  process.stdout.write(`  site: ${recipe.site ?? siteName(site)}\n`);
  process.stdout.write(`  kind: ${recipe.kind ?? "items"}\n`);
  const params = Object.entries(recipe.params ?? {});
  if (params.length)
    process.stdout.write(
      `  inputs: ${params.map(([key, spec]) => `${key}${spec.required ? "*" : ""}`).join(", ")}\n`,
    );
  recipe.strategies.forEach((strategy, index) => {
    const detail =
      strategy.kind === "api"
        ? strategy.operation
        : strategy.kind === "collect"
          ? strategy.collect.row
          : "script";
    process.stdout.write(`  ${index + 1}. ${strategy.kind}: ${detail}\n`);
  });
  if (recipe.map) process.stdout.write(`  fields: ${Object.keys(recipe.map).join(", ")}\n`);
  if (recipe.health) {
    process.stdout.write(
      `  health: ${recipe.health.ok === true ? "ok" : recipe.health.ok === false ? "failing" : "unknown"}` +
        `${recipe.health.strategy ? ` via ${recipe.health.strategy}` : ""}` +
        `${recipe.health.failures ? ` (${recipe.health.failures} failures)` : ""}\n`,
    );
  }
  return 0;
}

async function run(args: Args): Promise<number> {
  const [site, name] = args.positional.slice(1);
  if (!site || !name)
    throw new Error(
      "Usage: browserkit recipe run <site> <name> [--inputs <json>] [--feed] [--limit n] [--out file] [--json]",
    );
  const recipe = await readRecipe(site, name);
  if (!recipe) throw new Error(`No recipe ${JSON.stringify(name)} for ${site}`);
  const host = await recipeHost(site);
  const inputs = inputsFrom(args);
  const limit = flag(args, "limit") ? Number(flag(args, "limit")) : undefined;
  const result = has(args, "feed")
    ? await readFeed({
        site: siteName(site),
        recipe,
        inputs,
        host,
        ...(limit === undefined ? {} : { limit }),
      })
    : await runRecipe({
        site: siteName(site),
        recipe,
        inputs,
        host,
        ...(limit === undefined ? {} : { limit }),
      });
  const out = flag(args, "out");
  if (out) {
    const { writeFile } = await import("node:fs/promises");
    const body = (
      has(args, "feed") && "markdown" in result
        ? result.markdown
        : JSON.stringify(result.records, null, 2)
    ) as string;
    await writeFile(resolve(out), body, "utf8");
  }
  if (has(args, "json")) {
    printJson(result);
    return 0;
  }
  if (has(args, "feed") && "markdown" in result) {
    process.stdout.write(result.markdown + "\n");
    return 0;
  }
  for (const record of result.records) process.stdout.write(JSON.stringify(record) + "\n");
  process.stderr.write(
    `${result.count} records via ${result.strategy ?? "none"} (${result.pages} page${result.pages === 1 ? "" : "s"})${
      result.truncated ? " — truncated at the page cap" : ""
    }\n`,
  );
  return 0;
}

async function draft(args: Args): Promise<number> {
  const site = args.positional[1];
  if (!site)
    throw new Error("Usage: browserkit recipe draft <site> [--operation id] [--name n] [--save]");
  const model = await loadModel(site);
  if (!model) throw new Error(`No mapped site ${site}. Map it first (browserkit map).`);
  const name = flag(args, "name");
  const recipe = draftRecipeFromModel(model, {
    ...(flag(args, "operation") ? { operation: flag(args, "operation") as string } : {}),
    ...(name ? { name } : {}),
  });
  if (has(args, "save")) {
    const saved = await saveRecipe(recipe);
    if (has(args, "json")) printJson({ ...recipe, saved });
    else process.stdout.write(`Saved recipe ${recipe.name} for ${saved.site}.\n`);
    return 0;
  }
  printJson(recipe);
  return 0;
}

async function save(args: Args): Promise<number> {
  const file = args.positional[1];
  if (!file) throw new Error("Usage: browserkit recipe save <file.json>");
  const parsed = JSON.parse(
    await (await import("node:fs/promises")).readFile(resolve(file), "utf8"),
  ) as SiteRecipe | { recipes: SiteRecipe[] };
  const recipes = "recipes" in parsed ? parsed.recipes : [parsed];
  const saved: { site: string; name: string }[] = [];
  for (const recipe of recipes) {
    const checked = validateRecipe(recipe);
    const written = await saveRecipe(checked);
    saved.push({ site: written.site, name: checked.name });
  }
  if (has(args, "json")) printJson(saved);
  else for (const entry of saved) process.stdout.write(`Saved ${entry.name} for ${entry.site}.\n`);
  return 0;
}

async function exportCommand(args: Args): Promise<number> {
  const site = args.positional[1];
  if (!site) throw new Error("Usage: browserkit recipe export <site> --out <file.json>");
  const out = flag(args, "out") ?? `${site}-recipes.json`;
  const written = await exportRecipes(site, resolve(out));
  if (has(args, "json")) printJson(written);
  else
    process.stdout.write(
      `Exported ${written.count} recipes for ${written.site} to ${written.out}.\n`,
    );
  return 0;
}

async function importCommand(args: Args): Promise<number> {
  const file = args.positional[1];
  if (!file) throw new Error("Usage: browserkit recipe import <file.json> [--site <site>]");
  const site = flag(args, "site");
  const imported = await importRecipes(resolve(file), site ? { site } : {});
  if (has(args, "json"))
    printJson(imported.map((recipe) => ({ site: recipe.site, name: recipe.name })));
  else
    for (const recipe of imported)
      process.stdout.write(`Imported ${recipe.name} for ${recipe.site}.\n`);
  return 0;
}

async function install(args: Args): Promise<number> {
  const site = args.positional[1];
  if (!site) throw new Error("Usage: browserkit recipe install <site>");
  const available = builtinRecipes(site);
  if (!available.length) throw new Error(`No built-in recipes for ${site}`);
  const installed = await installBuiltinRecipes(site);
  if (has(args, "json")) printJson(installed.map((recipe) => recipe.name));
  else if (installed.length)
    process.stdout.write(
      `Installed ${installed.map((recipe) => recipe.name).join(", ")} for ${siteName(site)}.\n`,
    );
  else process.stdout.write(`Built-in recipes for ${siteName(site)} are already installed.\n`);
  return 0;
}

async function remove(args: Args): Promise<number> {
  const [site, name] = args.positional.slice(1);
  if (!site || !name) throw new Error("Usage: browserkit recipe delete <site> <name>");
  const removed = await deleteRecipe(site, name);
  if (!removed) throw new Error(`No recipe ${JSON.stringify(name)} for ${site}`);
  process.stdout.write(`Deleted recipe ${name} from ${siteName(site)}.\n`);
  return 0;
}

async function packRecipes(args: Args): Promise<number> {
  // Reading a pack lists what recipes it carries without installing it.
  const file = args.positional[1];
  if (!file) throw new Error("Usage: browserkit recipe pack <file.zip>");
  const pack = await readSitePack(file);
  const recipes = pack.files.get("recipes.json");
  printJson(recipes ? JSON.parse(recipes) : { version: 1, recipes: [] });
  return 0;
}

async function recipe(args: Args): Promise<number> {
  const action = args.positional[0] ?? "list";
  if (action === "list") return listCommand(args);
  if (action === "show") return show(args);
  if (action === "run") return run(args);
  if (action === "draft") return draft(args);
  if (action === "save") return save(args);
  if (action === "export") return exportCommand(args);
  if (action === "import") return importCommand(args);
  if (action === "install") return install(args);
  if (action === "delete" || action === "rm") return remove(args);
  if (action === "pack") return packRecipes(args);
  throw new Error(
    "Usage: browserkit recipe list [site] | show <site> <name> | run <site> <name> | draft <site> | save <file> | export <site> --out f | import <file> [--site] | install <site> | delete <site> <name>",
  );
}

export const recipeCommand: Command = {
  name: "recipe",
  group: "Use sites",
  hidden: true,
  summary: "list, draft and run a site's named recipes",
  help: `Usage: browserkit recipe list [site] [--json]
       browserkit recipe show <site> <name> [--json]
       browserkit recipe run <site> <name> [--inputs <json>] [--feed] [--limit n] [--out f] [--json]
       browserkit recipe draft <site> [--operation id] [--name n] [--save]
       browserkit recipe save <file.json>
       browserkit recipe export <site> --out <file.json>
       browserkit recipe import <file.json> [--site <site>]
       browserkit recipe install <site>
       browserkit recipe delete <site> <name>

A strategy can be a workflow: {"kind": "workflow", "name": "shop-search"} (found in the site's
pack first, then the host's workflows) or an inline definition. A workflow step can call a recipe
with its "recipe" action. One store, one name lookup, both commands.
       browserkit recipe pack <file.zip>

A recipe is one named way to read (or write) a site, stored in the site's pack. Strategies run
in order: the captured API with cursor paging, then the page, then a script. Records are mapped,
filtered and de-duplicated; a write recipe records a receipt so a repeat is skipped. --feed
renders the records as Markdown (the built-in X pack ships thread and feed recipes). Install a
built-in pack with "recipe install x.com"; draft one from a mapped site's operation with
"recipe draft <site>"; then run it with inputs.`,
  run: recipe,
};
