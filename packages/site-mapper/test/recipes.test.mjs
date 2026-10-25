import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  builtinRecipes,
  deleteRecipe,
  draftRecipeFromModel,
  exportRecipes,
  importRecipes,
  installBuiltinRecipes,
  listRecipes,
  readFeed,
  readRecipe,
  RecipeError,
  runRecipe,
  saveRecipe,
  siteDir,
  siteName,
  validateRecipe,
} from "../dist/index.js";
import { applyTransform, mapRecords, matchesFilters, pickPath } from "../dist/recipe-map.js";

const now = "2026-10-25T00:00:00.000Z";

async function tempSite(t, site = "example.com") {
  const home = await mkdtemp(join(tmpdir(), "browserkit-recipes-"));
  const previous = process.env.SITE_TO_API_HOME;
  process.env.SITE_TO_API_HOME = home;
  t.after(async () => {
    if (previous === undefined) delete process.env.SITE_TO_API_HOME;
    else process.env.SITE_TO_API_HOME = previous;
    await rm(home, { recursive: true, force: true });
  });
  return { home, site: siteName(site), dir: siteDir(site) };
}

function recipe(extra = {}) {
  return validateRecipe({
    name: "items",
    site: "example.com",
    params: { page: { default: 1 }, q: {} },
    strategies: [{ kind: "api", operation: "List", params: { q: "{{q}}" } }],
    map: { id: "id", title: { path: ["title", "name"] } },
    key: "id",
    createdAt: now,
    ...extra,
  });
}

test("mapping reads pointers, transforms values and filters", () => {
  assert.equal(pickPath({ a: { b: [0, { c: 2 }] } }, "a.b.1.c"), 2);
  assert.equal(pickPath({ a: { b: 1 } }, "/a/b"), 1);
  assert.equal(applyTransform(" 12 kg ", "number"), 12);
  assert.equal(applyTransform("2026-01-02", "iso"), "2026-01-02T00:00:00.000Z");
  const mapped = mapRecords([{ name: "A", when: "2026-01-02", url: "https://x.com/a/status/42" }], {
    title: { path: ["title", "name"] },
    id: { path: "url", pattern: "/status/(\\d+)", group: 1 },
    date: { path: "when", transform: "iso" },
    missing: { path: "nope", default: "fallback" },
  });
  assert.deepEqual(mapped[0], {
    title: "A",
    id: "42",
    date: "2026-01-02T00:00:00.000Z",
    missing: "fallback",
  });
  assert.equal(matchesFilters({ n: 5, s: "abc" }, [{ field: "n", op: "gt", value: 2 }]), true);
  assert.equal(matchesFilters({ n: 5 }, [{ field: "n", op: "lt", value: 2 }]), false);
  assert.equal(matchesFilters({ s: "abc" }, [{ field: "s", op: "regex", value: "^a" }]), true);
});

test("recipes save, list, read, export, import and delete", async (t) => {
  const { site, dir } = await tempSite(t);
  const saved = await saveRecipe(recipe());
  assert.equal(saved.site, "example.com");
  assert.equal((await listRecipes(site))[0].name, "items");
  assert.equal((await readRecipe(site, "items")).key, "id");

  const out = join(dir, "recipes-out.json");
  await exportRecipes(site, out);
  const imported = await importRecipes(out, { site: "other.com" });
  assert.equal(imported[0].site, "other.com");

  assert.equal(await deleteRecipe(site, "items"), true);
  assert.equal((await listRecipes(site)).length, 0);
  assert.throws(() => validateRecipe({ name: "x", strategies: [] }), /at least one strategy/);
});

test("an api recipe pages a cursor, maps, de-duplicates and limits", async (t) => {
  const { site } = await tempSite(t);
  const pages = {
    1: {
      next: "b",
      rows: [
        { id: 1, title: "one" },
        { id: 2, title: "two" },
      ],
    },
    b: {
      next: "c",
      rows: [
        { id: 2, title: "two again" },
        { id: 3, title: "three" },
      ],
    },
    c: { rows: [{ id: 4, title: "four" }] },
  };
  const calls = [];
  const result = await runRecipe({
    site,
    trackHealth: false,
    recipe: recipe({
      strategies: [
        {
          kind: "api",
          operation: "List",
          params: { q: "{{q}}" },
          pagination: { param: "after", next: "/next", items: "/rows" },
        },
      ],
    }),
    inputs: { q: "hello" },
    host: {
      call: async (operation, params) => {
        calls.push({ operation, params: { ...params } });
        return pages[params.after ?? 1];
      },
    },
  });
  assert.equal(result.count, 4);
  assert.equal(result.pages, 3);
  assert.equal(calls[0].params.q, "hello");
  assert.equal(calls[1].params.after, "b");
  assert.deepEqual(
    result.records.map((item) => item.title),
    ["one", "two", "three", "four"],
  );
});

test("when the API strategy fails the collect fallback runs and is reported", async (t) => {
  const { site } = await tempSite(t);
  const result = await runRecipe({
    site,
    trackHealth: false,
    recipe: recipe({
      strategies: [
        { kind: "api", operation: "List" },
        {
          kind: "collect",
          collect: { row: "article", fields: { title: "h2" }, max: 2 },
        },
      ],
    }),
    host: {
      call: async () => {
        throw new Error("signed out");
      },
      collect: async () => [{ id: 7, title: "from the page" }],
    },
  });
  assert.equal(result.strategy, "collect");
  assert.equal(result.records[0].title, "from the page");
  assert.equal(result.attempts[0].strategy, "api");
  assert.match(result.attempts[0].error, /signed out/);
});

test("an operation the site does not have is skipped, not failed", async (t) => {
  const { site } = await tempSite(t);
  const result = await runRecipe({
    site,
    trackHealth: false,
    recipe: recipe({
      strategies: [
        { kind: "api", operation: "HomeTimeline" },
        { kind: "collect", collect: { row: "article", fields: { title: "h2" } } },
      ],
    }),
    host: {
      resolveOperation: () => undefined,
      call: async () => {
        throw new Error("should not be called");
      },
      collect: async () => [{ id: 1, title: "page" }],
    },
  });
  assert.equal(result.strategy, "collect");
  assert.equal(result.attempts[0].skipped, true);
});

test("a script strategy can return the records", async (t) => {
  const { site } = await tempSite(t);
  const result = await runRecipe({
    site,
    trackHealth: false,
    recipe: recipe({ strategies: [{ kind: "script", code: "async () => []" }] }),
    host: {
      call: async () => ({}),
      script: async () => [{ id: 9, title: "script" }],
    },
  });
  assert.equal(result.records[0].title, "script");
});

test("a recipe that cannot run says which strategies failed", async (t) => {
  const { site } = await tempSite(t);
  await assert.rejects(
    runRecipe({
      site,
      trackHealth: false,
      recipe: recipe({ strategies: [{ kind: "api", operation: "List" }] }),
      host: {
        call: async () => {
          throw new Error("nope");
        },
      },
    }),
    (error) => {
      assert.ok(error instanceof RecipeError);
      assert.match(error.message, /api: nope/);
      return true;
    },
  );
});

test("a write recipe records a receipt and a repeat is skipped", async (t) => {
  const { site } = await tempSite(t);
  const written = [];
  const definition = recipe({
    name: "save-item",
    strategies: [{ kind: "api", operation: "Save" }],
    write: { operation: "Save", receipt: "params" },
  });
  const host = {
    call: async () => ({}),
    write: async (operation, params) => {
      written.push({ operation, params });
      return { ok: true };
    },
  };
  const first = await runRecipe({
    site,
    recipe: definition,
    inputs: { id: 5 },
    host,
    trackHealth: false,
  });
  assert.equal(first.count, 0);
  assert.equal(written.length, 1);
  const second = await runRecipe({
    site,
    recipe: definition,
    inputs: { id: 5 },
    host,
    trackHealth: false,
  });
  assert.equal(second.receipt?.skipped, true);
  assert.equal(written.length, 1);
});

test("a feed renders records as Markdown and JSONL", async (t) => {
  const { site } = await tempSite(t);
  const result = await readFeed({
    site,
    trackHealth: false,
    recipe: recipe({
      render: { title: "title", text: "title", url: "title" },
    }),
    host: {
      call: async () => [
        { id: 1, title: "First" },
        { id: 2, title: "Second" },
      ],
    },
  });
  assert.match(result.markdown, /## First/);
  assert.equal(result.jsonl.split("\n").length, 2);
});

test("the X pack installs a thread and a feed recipe and the thread reads rows", async (t) => {
  const { site } = await tempSite(t, "x.com");
  assert.deepEqual(
    builtinRecipes("x.com").map((item) => item.name),
    ["thread", "feed"],
  );
  const installed = await installBuiltinRecipes("x.com");
  assert.equal(installed.length, 2);
  assert.equal((await listRecipes(site)).length, 2);

  const thread = await readRecipe(site, "thread");
  const result = await runRecipe({
    site,
    recipe: thread,
    inputs: { url: "https://x.com/a/status/1" },
    trackHealth: false,
    host: {
      resolveOperation: () => undefined,
      call: async () => {
        throw new Error("not mapped");
      },
      collect: async (input) => {
        assert.equal(input.row, 'article[data-testid="tweet"]');
        return [
          {
            url: "https://x.com/a/status/42",
            author: "Ada",
            text: "first post",
            time: "2026-10-24T10:00:00.000Z",
          },
          {
            url: "https://x.com/a/status/43",
            author: "Ada",
            text: "second post",
            time: "2026-10-24T10:01:00.000Z",
          },
        ];
      },
    },
  });
  assert.equal(result.count, 2);
  assert.deepEqual(
    result.records.map((item) => item.id),
    ["42", "43"],
  );
  assert.equal(result.records[0].author, "Ada");
});

test("a recipe can be drafted from a mapped operation's sample", () => {
  const body = {
    data: {
      items: [
        { id: 1, name: "one", author: { handle: "a" } },
        { id: 2, name: "two", author: { handle: "b" } },
      ],
      nextCursor: "abc",
    },
  };
  const model = {
    version: 1,
    site: "shop.example",
    title: "Shop",
    generatedAt: now,
    origins: ["https://shop.example"],
    security: [],
    operations: [
      {
        id: "list-products",
        summary: "List products",
        method: "GET",
        origin: "https://shop.example",
        path: "/api/products",
        kind: "rest",
        params: [],
        responses: { 200: { mime: "application/json" } },
        role: "read",
        security: [],
        pagination: {
          style: "cursor",
          param: "cursor",
          nextPointer: "/data/nextCursor",
          itemsPointer: "/data/items",
        },
        dependencies: [],
        capabilities: ["list"],
        confidence: 1,
        bucket: "high",
        flags: [],
        sampleCount: 1,
        sources: [],
        pageUrls: [],
        samples: [
          {
            url: "https://shop.example/api/products",
            method: "GET",
            status: 200,
            requestHeaders: {},
            responseBody: JSON.stringify(body),
          },
        ],
      },
    ],
    pages: [],
    channels: [],
    components: {},
    noise: [],
    stats: { exchanges: 1, kept: 1, captures: [] },
  };
  const draft = draftRecipeFromModel(model, { operation: "list-products" });
  assert.equal(draft.strategies[0].kind, "api");
  assert.equal(draft.strategies[0].pagination.next, "/data/nextCursor");
  assert.equal(draft.strategies[0].pagination.items, "/data/items");
  assert.equal(draft.map.name, "name");
  assert.equal(draft.map.author_handle, "author.handle");
  assert.equal(draft.source.kind, "activity");
});
