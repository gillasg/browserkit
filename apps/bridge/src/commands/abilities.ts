import { migrateAllAbilities } from "@browserkit/site-mapper";
import { has, type Args } from "../args.js";
import { out, printJson } from "../output.js";
import type { Command } from "../usage.js";
import { join } from "node:path";
import { dataDirectory } from "../paths.js";

// The one-time migration from recipes/actions/workflows/skills/tools/learned notes to abilities.
// Old files stay in place; a version file makes it idempotent.
async function abilities(args: Args): Promise<number> {
  const action = args.positional[0] ?? "migrate";
  if (action !== "migrate")
    throw new Error("Usage: browserkit abilities migrate [--dry-run] [--json]");
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
    "site abilities and their one-time migration from recipes, actions, workflows, skills and tools",
  help: `Usage: browserkit abilities migrate [--dry-run] [--json]

Converts every old per-site store into abilities/*.json and notes.md. Old files are copied to a
timestamped backup-abilities-<date>/ folder and kept. A version file makes a later run a no-op.`,
  run: abilities,
};
