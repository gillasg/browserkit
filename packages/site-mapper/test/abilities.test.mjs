import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createAbility,
  listAbilities,
  maintainAbilities,
  readAbility,
  runAbility,
  saveAbility,
  writeSiteNotes,
} from "../dist/abilities.js";
import {
  abilityFromAction,
  abilityFromRecipe,
  abilityFromSkill,
  abilityFromTool,
  abilityFromWorkflow,
} from "../dist/abilities-migrate.js";

async function withHome(run) {
  const root = await mkdtemp(join(tmpdir(), "abilities-"));
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

function base(overrides = {}) {
  return {
    name: "search",
    site: "example.com",
    kind: "read",
    inputs: { type: "object", properties: { q: { type: "string" } } },
    ways: [{ kind: "api", operation: "search" }],
    options: {},
    stats: { runs: 0, failures: 0 },
    createdBy: "agent",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

test("converters keep every old kind in a way", () => {
  const recipe = abilityFromRecipe("example.com", {
    version: 1,
    name: "products",
    description: "List products",
    params: { page: { type: "number", required: true } },
    strategies: [
      { kind: "api", operation: "search", pagination: { param: "cursor", next: "/next" } },
      { kind: "collect", collect: { row: "li", fields: { title: "a" } } },
      { kind: "workflow", name: "checkout" },
      { kind: "script", code: "() => 1" },
    ],
    map: { title: "name" },
    key: "title",
    write: { operation: "order" },
    createdAt: "",
    updatedAt: "",
  });
  assert.equal(recipe.kind, "write");
  assert.deepEqual(
    recipe.ways.map((way) => way.kind),
    ["api", "page", "steps", "script"],
  );
  assert.equal(recipe.options.recordMapping.map.title, "name");
  assert.equal(recipe.options.paging.param, "cursor");
  assert.equal(recipe.options.write.operation, "order");
  assert.equal(recipe.inputs.required[0], "page");

  const action = abilityFromAction("example.com", "book", {
    description: "Book a slot",
    steps: [{ operation: "hold" }, { operation: "confirm", params: { id: "{{steps.0.id}}" } }],
  });
  assert.equal(action.kind, "write");
  assert.deepEqual(
    action.ways[0].operations.map((step) => step.operation),
    ["hold", "confirm"],
  );

  const workflow = abilityFromWorkflow("example.com", {
    name: "Daily check",
    steps: [{ do: "goto", with: { url: "https://example.com" } }],
    inputs: { day: { type: "string", required: true } },
  });
  assert.equal(workflow.ways[0].kind, "steps");
  assert.equal(workflow.inputs.required[0], "day");

  const tool = abilityFromTool("example.com", {
    name: "lookup",
    description: "Look something up",
    params: [{ name: "id", type: "string", required: true }],
    code: "return siteMapper.call('detail', inputs)",
    enabled: false,
    updatedAt: "",
  });
  assert.equal(tool.ways[0].runtime, "node");
  assert.equal(tool.inputs.required[0], "id");

  const pageTool = abilityFromTool(
    "example.com",
    { name: "readTitle", code: "return document.title", params: [], enabled: true, updatedAt: "" },
    true,
  );
  assert.equal(pageTool.ways[0].runtime, "page");

  const skill = abilityFromSkill("example.com", {
    name: "helper",
    description: "A helper",
    code: "function helper() {}",
  });
  assert.equal(skill.ways[0].runtime, "page");
});

test("runner tries ways in order, honors via, and records stats", async () => {
  await withHome(async () => {
    await saveAbility(
      base({
        ways: [
          { kind: "api", operation: "search" },
          { kind: "script", code: "return 'from script'", runtime: "node" },
        ],
      }),
    );
    const failed = await runAbility(
      "example.com",
      "search",
      {},
      {
        host: {
          call: async () => {
            throw new Error("api down");
          },
        },
      },
    );
    assert.equal(failed.via, "script");
    assert.equal(failed.result, "from script");
    assert.equal(failed.tried[0].via, "api");

    const direct = await runAbility(
      "example.com",
      "search",
      {},
      {
        via: "script",
        host: { call: async () => "unused" },
      },
    );
    assert.equal(direct.via, "script");
    assert.deepEqual(direct.tried, []);

    const ability = await readAbility("example.com", "search");
    assert.equal(ability.stats.runs, 2);
    assert.equal(ability.stats.failures, 0);
    assert.ok(ability.stats.lastOkAt);
  });
});

test("maintenance trashes failing and unused abilities", async () => {
  await withHome(async () => {
    const old = new Date(Date.now() - 61 * 86_400_000).toISOString();
    await saveAbility(
      base({
        name: "failing",
        stats: { runs: 5, failures: 5, lastOkAt: old, lastUsedAt: new Date().toISOString() },
      }),
    );
    await saveAbility(
      base({
        name: "unused",
        createdAt: old,
        stats: { runs: 0, failures: 0, lastUsedAt: old },
      }),
    );
    await saveAbility(base({ name: "healthy" }));
    const { trashed } = await maintainAbilities("example.com");
    assert.deepEqual(trashed.sort(), ["failing", "unused"]);
    assert.deepEqual(
      (await listAbilities("example.com")).map((item) => item.name),
      ["healthy"],
    );
  });
});

test("collisions suffix and notes append", async () => {
  await withHome(async () => {
    const first = await createAbility(base());
    const second = await createAbility(base());
    assert.equal(first.ability.name, "search");
    assert.equal(second.ability.name, "search-2");
    await writeSiteNotes("example.com", "# Site\n\nfirst");
    await writeSiteNotes("example.com", "second", { append: true });
    const notes = await readFile(
      join(process.env.SITE_TO_API_HOME, "sites/example.com/notes.md"),
      "utf8",
    );
    assert.match(notes, /first/);
    assert.match(notes, /second/);
  });
});
