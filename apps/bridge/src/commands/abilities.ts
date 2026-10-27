import {
  browserRecipeHost,
  listAbilities,
  listSites,
  readAbility,
  runAbility,
  siteName,
  trashAbility,
  migrateAllAbilities,
  type AbilityVia,
} from "@browserkit/tools/site-to-api";
import { flag, has, jsonValue, type Args } from "../args.js";
import { out, printJson } from "../output.js";
import type { Command } from "../usage.js";
import { join } from "node:path";
import { dataDirectory } from "../paths.js";

// One named thing a site can do: list, inspect, run, retire, or migrate the old stores once.
async function abilities(args: Args): Promise<number> {
  const action = args.positional[0] ?? "list";
  if (action === "migrate") return migrate(args);
  if (action === "list") return list(args);
  if (action === "show") return show(args);
  if (action === "run") return run(args);
  if (action === "delete") return remove(args);
  throw new Error("Usage: browserkit abilities <list|show|run|delete|migrate>");
}

async function list(args: Args): Promise<number> {
  const site = args.positional[1];
  const rows = site
    ? (await listAbilities(siteName(site))).map((ability) => ({
        ...ability,
        site: siteName(site),
      }))
    : (
        await Promise.all(
          (await listSites()).map(async (item) =>
            (await listAbilities(item.site)).map((ability) => ({ ...ability, site: item.site })),
          ),
        )
      ).flat();
  if (has(args, "json")) {
    printJson(rows);
    return 0;
  }
  if (!rows.length) {
    out(site ? `${siteName(site)} has no abilities.` : "No abilities yet.");
    return 0;
  }
  for (const ability of rows)
    out(
      `${ability.site}\t${ability.kind}\t${ability.ways.map((way) => way.kind).join("+")}\t${ability.name}\t${ability.description ?? ""}`,
    );
  return 0;
}

async function show(args: Args): Promise<number> {
  const site = args.positional[1];
  const name = args.positional[2];
  if (!site || !name) throw new Error("Usage: browserkit abilities show <site> <name>");
  const ability = await readAbility(siteName(site), name);
  if (!ability) throw new Error(`No ability ${JSON.stringify(name)} on ${siteName(site)}`);
  if (has(args, "json")) printJson(ability);
  else {
    out(`${ability.name} (${ability.kind}) on ${ability.site}`);
    if (ability.description) out(ability.description);
    out(`ways: ${ability.ways.map((way) => way.kind).join(", ")}`);
    out(
      `runs: ${ability.stats.runs}, failures: ${ability.stats.failures}${ability.stats.lastOkAt ? `, last ok: ${ability.stats.lastOkAt}` : ""}`,
    );
  }
  return 0;
}

async function run(args: Args): Promise<number> {
  const site = args.positional[1];
  const name = args.positional[2];
  if (!site || !name)
    throw new Error("Usage: browserkit abilities run <site> <name> [--inputs <json>]");
  const raw = flag(args, "inputs") ?? flag(args, "params");
  const inputs = raw ? jsonValue(raw) : {};
  const via = flag(args, "via") as AbilityVia | undefined;
  const recipe = await browserRecipeHost(siteName(site));
  const answer = await runAbility(siteName(site), name, inputs as Record<string, unknown>, {
    ...(via ? { via } : {}),
    host: {
      call: recipe.call,
      ...(recipe.write ? { write: recipe.write } : {}),
      ...(recipe.open ? { open: recipe.open } : {}),
      ...(recipe.collect ? { collect: recipe.collect } : {}),
      ...(recipe.script ? { script: recipe.script } : {}),
      ...(recipe.resolveOperation ? { resolveOperation: recipe.resolveOperation } : {}),
    },
  });
  if (has(args, "json")) printJson(answer);
  else printJson(answer.result);
  return 0;
}

async function remove(args: Args): Promise<number> {
  const site = args.positional[1];
  const name = args.positional[2];
  if (!site || !name) throw new Error("Usage: browserkit abilities delete <site> <name>");
  const removed = await trashAbility(siteName(site), name, "cli");
  if (!removed) throw new Error(`No ability ${JSON.stringify(name)} on ${siteName(site)}`);
  out(`Moved ${name} to ${siteName(site)}'s trash.`);
  return 0;
}

async function migrate(args: Args): Promise<number> {
  const report = await migrateAllAbilities({
    dryRun: has(args, "dry-run"),
    skillsDirectory: join(dataDirectory(), "site-skills"),
  });
  if (has(args, "json")) {
    printJson(report);
    return 0;
  }
  out(
    `${report.dryRun ? "Would migrate" : "Migrated"} ${report.sites.length} site(s); ${Object.entries(
      report.totals,
    )
      .map(([kind, count]) => `${kind} ${count}`)
      .join(", ")}`,
  );
  for (const site of report.sites)
    out(
      `${site.site}: ${site.abilities.length} abilities${site.skipped ? " (already migrated)" : ""}${
        site.unmigrated.length ? `, ${site.unmigrated.length} unmigrated` : ""
      }`,
    );
  return 0;
}

export const abilitiesCommand: Command = {
  name: "abilities",
  group: "Use a site",
  summary:
    "one named thing a site can do, and its one-time migration from recipes, actions, workflows, skills and tools",
  help: `Usage: browserkit abilities <list|show|run|delete|migrate> [site] [name]

  list [site] [--json]          abilities, with kind, ways and description
  show <site> <name> [--json]   full definition and run stats
  run <site> <name> [--inputs '<json>'] [--via api|steps|script|page] [--json]
  delete <site> <name>          move it to trash/ instead of hard-deleting
  migrate [--dry-run] [--json]  convert every old site store into abilities + notes

Old recipe/action/workflow/site-tools names remain as hidden aliases for one release.`,
  run: abilities,
};
