import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { listAbilities, readSiteNotes } from "../dist/abilities.js";
import { migrateAllAbilities, migrateSiteAbilities } from "../dist/abilities-migrate.js";

async function withHome(run) {
  const root = await mkdtemp(join(tmpdir(), "abilities-migrate-"));
  const previous = process.env.SITE_TO_API_HOME;
  process.env.SITE_TO_API_HOME = root;
  try {
    return await run(root);
  } finally {
    if (previous === undefined) delete process.env.SITE_TO_API_HOME;
    else process.env.SITE_TO_API_HOME = previous;
    await rm(root, { recursive: true, force: true });
  }
}

async function fixture(root) {
  const site = join(root, "sites", "example.com");
  const skills = join(root, "site-skills");
  await mkdir(join(site, "workflows"), { recursive: true });
  await mkdir(skills, { recursive: true });
  await writeFile(
    join(site, "recipes.json"),
    JSON.stringify({
      version: 1,
      recipes: [
        {
          version: 1,
          name: "search",
          description: "Search the site",
          params: { q: { type: "string", required: true } },
          strategies: [{ kind: "api", operation: "searchProducts" }],
          createdAt: "",
          updatedAt: "",
        },
        {
          version: 1,
          name: "search",
          description: "A second search",
          strategies: [{ kind: "collect", collect: { row: "li", fields: { title: "a" } } }],
          createdAt: "",
          updatedAt: "",
        },
        { name: "broken" },
      ],
    }),
  );
  await writeFile(
    join(site, "overrides.json"),
    JSON.stringify({
      actions: {
        book: {
          description: "Book a slot",
          steps: [{ operation: "hold" }, { operation: "confirm" }],
        },
      },
    }),
  );
  await writeFile(
    join(site, "workflows", "daily.json"),
    JSON.stringify({
      name: "Daily check",
      steps: [{ do: "goto", with: { url: "https://example.com" } }],
      inputs: { day: { type: "string", required: true } },
    }),
  );
  await writeFile(
    join(site, "tools.json"),
    JSON.stringify({
      version: 1,
      tools: [
        {
          version: 1,
          name: "lookup",
          description: "Look up an id",
          params: [{ name: "id", type: "string", required: true }],
          code: "return siteMapper.call('detail', inputs)",
          enabled: false,
          updatedAt: "",
        },
      ],
      pageTools: [],
    }),
  );
  await writeFile(
    join(site, "learned.json"),
    JSON.stringify({ site: "example.com", gate: "age", clicked: "Enter", runs: 2, updatedAt: "" }),
  );
  await writeFile(
    join(skills, "helper.json"),
    JSON.stringify({
      name: "helper",
      domains: ["example.com"],
      description: "A helper for the site",
      examples: "helper()",
      code: "function helper() { return 1 }",
      enabled: false,
      updatedAt: 0,
    }),
  );
  return { site, skills };
}

test("migration backs up, converts every kind, and is idempotent", async () => {
  await withHome(async (root) => {
    const { site, skills } = await fixture(root);
    const first = await migrateAllAbilities({ skillsDirectory: skills });
    assert.equal(first.sites.length, 1);
    const report = first.sites[0];
    assert.equal(report.counts.recipe, 2);
    assert.equal(report.counts.action, 1);
    assert.equal(report.counts.workflow, 1);
    assert.equal(report.counts.tool, 1);
    assert.equal(report.counts.skill, 1);
    assert.equal(report.counts.learnedNote, 1);
    assert.ok(report.backup);
    await stat(report.backup);
    const abilities = await listAbilities("example.com");
    assert.deepEqual(
      abilities.map((ability) => ability.name).sort(),
      ["Daily check", "book", "helper", "lookup", "search", "search-2"].sort(),
    );
    assert.equal(abilities.find((ability) => ability.name === "search-2").ways[0].kind, "page");
    assert.match(await readSiteNotes("example.com"), /gate: age/);
    assert.match(await readSiteNotes("example.com"), /Skill: helper/);
    assert.equal(report.unmigrated[0].kind, "recipe");

    const second = await migrateAllAbilities({ skillsDirectory: skills });
    assert.equal(second.sites[0].skipped, true);
    assert.equal((await listAbilities("example.com")).length, abilities.length);
    const version = JSON.parse(await readFile(join(site, "abilities", "migration.json"), "utf8"));
    assert.equal(version.version, 1);
  });
});

test("dry-run previews without writing abilities", async () => {
  await withHome(async (root) => {
    const { site, skills } = await fixture(root);
    const report = await migrateAllAbilities({ dryRun: true, skillsDirectory: skills });
    assert.equal(report.dryRun, true);
    assert.ok(report.sites[0].abilities.length > 0);
    assert.equal((await listAbilities("example.com")).length, 0);
    await assert.rejects(stat(join(site, "abilities", "migration.json")));
  });
});

test("a bad store is reported and left in place", async () => {
  await withHome(async (root) => {
    const site = join(root, "sites", "example.com");
    await mkdir(site, { recursive: true });
    await writeFile(join(site, "overrides.json"), "{ not json");
    const report = await migrateSiteAbilities("example.com");
    assert.equal(report.unmigrated[0].kind, "overrides");
    assert.match(report.unmigrated[0].reason, /JSON|Unexpected|position/i);
    await stat(join(site, "overrides.json"));
  });
});
