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
import { collectExpression, normaliseCollectField } from "../dist/runtime/collect.js";

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

test("the X pack installs a thread and a feed recipe", async (t) => {
  const { site } = await tempSite(t, "x.com");
  assert.deepEqual(
    builtinRecipes("x.com").map((item) => item.name),
    ["thread", "feed"],
  );
  const installed = await installBuiltinRecipes("x.com");
  assert.equal(installed.length, 2);
  assert.equal((await listRecipes(site)).length, 2);

  const thread = await readRecipe(site, "thread");
  assert.deepEqual(thread.thread, { authorField: "author", rootFirst: true });
  assert.equal(thread.derive.id.from, "url");
  assert.equal(thread.strategies[1].kind, "collect");
  assert.equal(thread.strategies[1].collect.url, "{{url}}");
  assert.equal(thread.strategies[0].kind, "api");
  assert.equal(thread.strategies[0].open, "{{url}}");
});

test("the X thread keeps the author's posts, in order, with quote, media and full text", async (t) => {
  const { site } = await tempSite(t, "x.com");
  await installBuiltinRecipes("x.com");
  const long = `Root post. ${"A long explanation that only fits after Show more. ".repeat(40)}`;
  const rows = [
    {
      id: "101",
      author: "ada",
      name: "Ada",
      time: "2026-10-24T10:00:00.000Z",
      text: "root post",
    },
    {
      id: "102",
      author: "bob",
      name: "Bob",
      time: "2026-10-24T10:01:00.000Z",
      text: "a reply from someone else",
    },
    {
      id: "103",
      author: "ada",
      name: "Ada",
      time: "2026-10-24T10:02:00.000Z",
      text: long,
      replyTo: "101",
      media: ["https://pbs.twimg.com/media/one.jpg", "https://pbs.twimg.com/media/two.jpg"],
      quoted: {
        id: "55",
        author: "carol",
        name: "Carol",
        time: "2026-10-23T09:00:00.000Z",
        text: "the quoted post",
        media: ["https://pbs.twimg.com/media/q.jpg"],
      },
    },
    {
      id: "104",
      author: "dave",
      name: "Dave",
      time: "2026-10-24T10:03:00.000Z",
      text: "another stranger",
    },
  ];
  const result = await runRecipe({
    site,
    recipe: await readRecipe(site, "thread"),
    // The URL names the middle post: the root is put first even though the page lists it second.
    inputs: { url: "https://x.com/ada/status/103" },
    trackHealth: false,
    host: {
      resolveOperation: () => undefined,
      call: async () => {
        throw new Error("x.com is not mapped");
      },
      collect: async (input) => {
        assert.equal(input.url, "https://x.com/ada/status/103");
        assert.equal(input.row, 'article[data-testid="tweet"]');
        return rows;
      },
    },
  });
  assert.deepEqual(
    result.records.map((record) => record.id),
    ["103", "101"],
    "only the opening author, opening post first, then page order",
  );
  const [root, first] = result.records;
  assert.equal(root.text, long, "full long text is kept");
  assert.equal(root.replyTo, "101");
  assert.deepEqual(root.media, [
    "https://pbs.twimg.com/media/one.jpg",
    "https://pbs.twimg.com/media/two.jpg",
  ]);
  assert.deepEqual(root.quoted, {
    id: "55",
    author: "carol",
    name: "Carol",
    time: "2026-10-23T09:00:00.000Z",
    text: "the quoted post",
    media: ["https://pbs.twimg.com/media/q.jpg"],
  });
  assert.equal(root.url, "https://x.com/ada/status/103");
  assert.equal(root.name, "Ada");
  assert.equal(root.time, "2026-10-24T10:02:00.000Z");
  assert.equal(first.id, "101");
});

const xTweet = (id, handle, name, text, extra = {}) => ({
  rest_id: id,
  core: { user_results: { result: { core: { screen_name: handle, name } } } },
  legacy: { full_text: text, created_at: "Sat Oct 24 10:00:00 +0000 2026", ...extra },
});

test("the X thread API path passes the URL and reads posts from the GraphQL tree", async (t) => {
  const { site } = await tempSite(t, "x.com");
  await installBuiltinRecipes("x.com");
  const tweet = xTweet;
  const quoted = tweet("900", "carol", "Carol", "quoted text");
  const page = {
    data: {
      threaded_conversation_with_injections_v2: {
        instructions: [
          {
            type: "TimelineAddEntries",
            entries: [
              {
                content: {
                  itemContent: {
                    tweet_results: { result: tweet("201", "ada", "Ada", "short version") },
                  },
                },
              },
              {
                content: {
                  itemContent: {
                    tweet_results: { result: tweet("202", "bob", "Bob", "stranger") },
                  },
                },
              },
              {
                content: {
                  itemContent: {
                    tweet_results: {
                      result: {
                        ...tweet("203", "ada", "Ada", "truncated", {
                          in_reply_to_status_id_str: "201",
                          extended_entities: {
                            media: [
                              { media_url_https: "https://pbs.twimg.com/media/a.jpg" },
                              { media_url_https: "https://pbs.twimg.com/media/b.jpg" },
                            ],
                          },
                        }),
                        note_tweet: {
                          note_tweet_results: { result: { text: "the full long text" } },
                        },
                        quoted_status_result: { result: { tweet: quoted } },
                      },
                    },
                  },
                },
              },
            ],
          },
          { content: { cursorType: "Bottom", value: "CURSOR-2" } },
        ],
      },
    },
  };
  const calls = [];
  const opened = [];
  const result = await runRecipe({
    site,
    recipe: await readRecipe(site, "thread"),
    inputs: { url: "https://x.com/ada/status/203" },
    trackHealth: false,
    host: {
      resolveOperation: (wanted) => (wanted === "TweetDetail" ? "op-tweet-detail" : undefined),
      open: async (url) => opened.push(url),
      call: async (operation, params) => {
        calls.push({ operation, params: { ...params } });
        if (params.cursor === "CURSOR-2") return { data: { instructions: [] } };
        return page;
      },
    },
  });
  assert.deepEqual(opened, ["https://x.com/ada/status/203"]);
  assert.equal(calls[0].operation, "op-tweet-detail");
  assert.equal(calls[0].params.url, "https://x.com/ada/status/203");
  assert.equal(calls[0].params.focalTweetId, "203");
  assert.equal(calls[0].params.id, "203");
  assert.equal(calls[1].params.cursor, "CURSOR-2", "the bottom cursor is followed");

  assert.deepEqual(
    result.records.map((record) => record.id),
    ["203", "201"],
  );
  const [root] = result.records;
  assert.equal(root.text, "the full long text");
  assert.equal(root.replyTo, "201");
  assert.deepEqual(root.media, [
    "https://pbs.twimg.com/media/a.jpg",
    "https://pbs.twimg.com/media/b.jpg",
  ]);
  assert.equal(root.quoted.text, "quoted text");
  assert.equal(root.quoted.author, "carol");
  assert.equal(root.url, "https://x.com/ada/status/203");
  assert.equal(root.time, "2026-10-24T10:00:00.000Z");
});

test("the X feed opens its URL and keeps every author", async (t) => {
  const { site } = await tempSite(t, "x.com");
  await installBuiltinRecipes("x.com");
  const feed = await readRecipe(site, "feed");
  const seen = [];
  const result = await runRecipe({
    site,
    recipe: feed,
    inputs: { url: "https://x.com/home?filter=following" },
    trackHealth: false,
    host: {
      resolveOperation: () => undefined,
      call: async () => {
        throw new Error("not mapped");
      },
      collect: async (input) => {
        seen.push(input.url);
        return [
          { id: "1", author: "ada", name: "Ada", text: "one" },
          { id: "2", author: "bob", name: "Bob", text: "two" },
        ];
      },
    },
  });
  assert.deepEqual(seen, ["https://x.com/home?filter=following"]);
  assert.deepEqual(
    result.records.map((record) => record.author),
    ["ada", "bob"].map((author) => author),
    "a feed is not filtered to one author",
  );

  const defaulted = [];
  await runRecipe({
    site,
    recipe: feed,
    inputs: {},
    trackHealth: false,
    host: {
      resolveOperation: () => undefined,
      call: async () => ({}),
      collect: async (input) => {
        defaulted.push(input.url);
        return [];
      },
    },
  }).catch(() => undefined);
  assert.deepEqual(defaulted, ["https://x.com/home"]);
});

test("mapping handles wildcards, indexes, nested records, dotted keys and templates", () => {
  const mapped = mapRecords(
    [
      {
        id: 7,
        media: [{ url: "a" }, { url: "b" }],
        items: [{ t: 1 }, { t: 2 }],
        author: { name: "Ada" },
        text: "hello",
      },
    ],
    {
      id: "id",
      urls: "media[*].url",
      second: { path: "items[*].t", index: 1 },
      author: { path: "author", fields: { name: "name" } },
      "quoted.text": "text",
      url: { template: "https://x.com/{{author.name}}/status/{{id}}" },
    },
  )[0];
  assert.deepEqual(mapped.urls, ["a", "b"]);
  assert.equal(mapped.second, 2);
  assert.deepEqual(mapped.author, { name: "Ada" });
  assert.deepEqual(mapped.quoted, { text: "hello" });
  assert.equal(mapped.url, "https://x.com/Ada/status/7");
});

test("collect field strings become specs", () => {
  assert.deepEqual(normaliseCollectField("h2"), { selector: "h2" });
  assert.deepEqual(normaliseCollectField("a@href"), { selector: "a", attr: "href" });
  assert.deepEqual(normaliseCollectField("img@src[]"), {
    selector: "img",
    attr: "src",
    all: true,
  });
  assert.deepEqual(normaliseCollectField("?h2?"), { selector: "h2" });
  const expression = collectExpression({
    url: "https://x.com/ada/status/1",
    row: "article",
    fields: { title: "h2", links: "a@href[]" },
  });
  assert.match(expression, /https:\/\/x\.com\/ada\/status\/1/);
  assert.match(expression, /"title":\{"selector":"h2"\}/);
  assert.match(expression, /"links":\{"selector":"a","attr":"href","all":true\}/);
});

test("a feed renders media and quoted posts", async (t) => {
  const { site } = await tempSite(t);
  const result = await readFeed({
    site,
    trackHealth: false,
    recipe: recipe({
      map: {
        id: "id",
        author: "author",
        time: "time",
        text: "text",
        url: "url",
        media: "media",
        quoted: "quoted",
      },
      render: {
        title: "author",
        author: "author",
        date: "time",
        text: "text",
        url: "url",
        media: "media",
        quote: "quoted",
      },
    }),
    host: {
      call: async () => [
        {
          id: 1,
          author: "ada",
          time: "2026-10-24T10:00:00.000Z",
          text: "the post",
          url: "https://x.com/ada/status/1",
          media: ["https://pbs.twimg.com/media/a.jpg"],
          quoted: { author: "carol", text: "the quoted post" },
        },
      ],
    },
  });
  assert.match(result.markdown, /## ada/);
  assert.match(result.markdown, /> the quoted post/);
  assert.match(result.markdown, /> — @carol/);
  assert.match(result.markdown, /!\[\]\(https:\/\/pbs\.twimg\.com\/media\/a\.jpg\)/);
  assert.match(result.markdown, /https:\/\/x\.com\/ada\/status\/1/);
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
