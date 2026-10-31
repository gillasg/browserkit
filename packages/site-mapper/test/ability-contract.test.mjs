import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runAbility, saveAbility, testAbility } from "../dist/abilities.js";
import { pageRows } from "../dist/ability-records.js";

async function withHome(run) {
  const root = await mkdtemp(join(tmpdir(), "ability-contract-"));
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

function ability(overrides = {}) {
  const now = new Date().toISOString();
  return {
    name: "search",
    site: "example.com",
    kind: "read",
    inputs: { type: "object", properties: { q: { type: "string" } } },
    ways: [{ kind: "api", operation: "search", params: { q: "{{inputs.q}}" } }],
    options: {},
    stats: { runs: 0, failures: 0 },
    createdBy: "agent",
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

const rows = (ids) => ids.map((id) => ({ id: String(id), title: `item ${id}` }));

test("a migrated read pages its API again and stops once it has enough rows", async () => {
  await withHome(async () => {
    await saveAbility(
      ability({
        name: "feed",
        inputs: {},
        ways: [
          {
            kind: "api",
            operation: "feed",
            paging: { param: "cursor", next: "/next", items: "/items" },
          },
        ],
        createdBy: "import",
      }),
    );
    const calls = [];
    const host = {
      call: async (_operation, params) => {
        calls.push(params.cursor);
        const page = Number(params.cursor ?? 0);
        return { items: rows([page * 2, page * 2 + 1]), next: page < 4 ? String(page + 1) : null };
      },
    };
    const all = await runAbility("example.com", "feed", {}, { host });
    assert.equal(all.result.length, 10, "every page is read");
    calls.length = 0;
    const first = await runAbility("example.com", "feed", {}, { host, limit: 3 });
    assert.deepEqual(
      first.result.items.map((row) => row.id),
      ["0", "1", "2"],
    );
    assert.equal(first.result.has_more, true);
    assert.equal(calls.length, 2, "paging stops once the page plus one row exists");
  });
});

test("a cursor survives rows added and removed above it", () => {
  const first = pageRows(rows([1, 2, 3, 4, 5, 6]), { limit: 2 });
  assert.deepEqual(
    first.items.map((row) => row.id),
    ["1", "2"],
  );
  const inserted = pageRows(rows([0, 1, 2, 3, 4, 5, 6]), { limit: 2, cursor: first.next_cursor });
  assert.deepEqual(
    inserted.items.map((row) => row.id),
    ["3", "4"],
    "a new row on top neither repeats nor skips",
  );
  const removed = pageRows(rows([1, 3, 4, 5, 6]), { limit: 2, cursor: first.next_cursor });
  assert.deepEqual(
    removed.items.map((row) => row.id),
    ["3", "4"],
    "a returned row that vanished falls back without repeats",
  );
  const last = pageRows(rows([1, 2, 3]), { limit: 5, cursor: first.next_cursor });
  assert.equal(last.has_more, false);
  assert.equal(last.next_cursor, null);
});

test("a write never applies twice under one key", async () => {
  await withHome(async () => {
    await saveAbility(
      ability({
        name: "order",
        kind: "write",
        inputs: { type: "object", properties: { item: { type: "string" } } },
        ways: [{ kind: "api", operation: "order", params: { item: "{{inputs.item}}" } }],
      }),
    );
    let orders = 0;
    const host = { call: async () => ({ order: ++orders }) };
    const first = await runAbility("example.com", "order", { item: "tea" }, { host, key: "k1" });
    const again = await runAbility("example.com", "order", { item: "tea" }, { host, key: "k1" });
    assert.equal(orders, 1);
    assert.equal(again.write.replayed, true);
    assert.deepEqual(again.result, first.result);
    await runAbility("example.com", "order", { item: "tea" }, { host, key: "k2" });
    assert.equal(orders, 2, "a new key is a new write");
  });
});

test("a write that may have applied stops, reports it, and refuses the same key", async () => {
  await withHome(async () => {
    await saveAbility(
      ability({
        name: "order",
        kind: "write",
        inputs: { type: "object", properties: { item: { type: "string" } } },
        ways: [
          { kind: "api", operation: "order", params: { item: "{{inputs.item}}" } },
          { kind: "script", runtime: "node", code: "return 'second way ran';" },
        ],
      }),
    );
    const host = {
      call: async () => {
        throw new Error("request timed out");
      },
    };
    const failure = await runAbility("example.com", "order", { item: "tea" }, { host, key: "k" })
      .then(() => undefined)
      .catch((error) => error);
    assert.equal(failure.outcome.write_status, "may_have_applied");
    assert.equal(failure.outcome.possible_commit, true);
    assert.equal(failure.outcome.retry, "new_key");
    assert.doesNotMatch(failure.message, /second way ran/, "no fallback after a possible commit");
    await assert.rejects(
      runAbility("example.com", "order", { item: "tea" }, { host, key: "k" }),
      /WRITE_UNCERTAIN/,
    );
  });
});

test("a refused write is not applied and may fall through to the next way", async () => {
  await withHome(async () => {
    await saveAbility(
      ability({
        name: "order",
        kind: "write",
        inputs: {},
        ways: [
          { kind: "api", operation: "order" },
          { kind: "script", runtime: "node", code: "return 'by script';" },
        ],
      }),
    );
    const host = {
      call: async () => {
        throw new Error("HTTP 422 invalid size");
      },
    };
    const answer = await runAbility("example.com", "order", {}, { host });
    assert.equal(answer.result, "by script");
    assert.equal(answer.write.write_status, "applied");
  });
});

test("a read whose site ignored a filter fails as input_not_applied", async () => {
  await withHome(async () => {
    await saveAbility(
      ability({
        name: "flights",
        inputs: { type: "object", properties: { max: { type: "number" } } },
        ways: [{ kind: "api", operation: "flights", params: { max: "{{inputs.max}}" } }],
        options: { checks: [{ input: "max", field: "price", op: "lte" }] },
      }),
    );
    const host = { call: async () => [{ price: "$250" }, { price: "$900" }] };
    await assert.rejects(
      runAbility("example.com", "flights", { max: 300 }, { host }),
      /INPUT_NOT_APPLIED.*"retry":"same_key"/,
    );
    const ok = await runAbility("example.com", "flights", {}, { host });
    assert.equal(ok.result.length, 2, "no input, no check");
  });
});

test("saving refuses unused inputs and weakened contracts", async () => {
  await withHome(async () => {
    await assert.rejects(
      saveAbility(ability({ inputs: { type: "object", properties: { sort: {} } } })),
      /ABILITY_INPUT_UNUSED: search declares sort/,
    );
    await saveAbility(
      ability({
        name: "sorted",
        inputs: {
          type: "object",
          properties: { sort: { description: "By design: the site has one order" } },
        },
      }),
    );
    const saved = await saveAbility(
      ability({ outputs: { type: "object", properties: { title: {}, price: {} } } }),
    );
    assert.ok(saved.warnings.some((warning) => warning.includes("no test cases")));
    await assert.rejects(
      saveAbility(ability({ outputs: { type: "object", properties: { title: {} } } })),
      /ABILITY_CONTRACT_WEAKENED: search: output price removed/,
    );
    await saveAbility(ability({ outputs: { type: "object", properties: { title: {} } } }), {
      breaking: true,
    });
  });
});

test("test cases catch an ability whose output ignores its inputs", async () => {
  await withHome(async () => {
    await saveAbility(
      ability({
        tests: [{ inputs: { q: "tea" } }, { inputs: { q: "coffee" } }],
      }),
    );
    const constant = await testAbility("example.com", "search", {
      host: { call: async () => [{ title: "$0" }] },
    });
    assert.equal(constant.constant, true);
    assert.equal(constant.ok, false);
    const honest = await testAbility("example.com", "search", {
      host: { call: async (_operation, params) => [{ title: params.q }] },
    });
    assert.equal(honest.ok, true);
  });
});

test("a node script's browser.fetch answers in browser code's shape", async () => {
  const { createServer } = await import("node:http");
  const server = createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ path: request.url, method: request.method }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}/books`;
  try {
    await withHome(async () => {
      await saveAbility(
        ability({
          name: "fetcher",
          inputs: { type: "object", properties: { url: { type: "string" } } },
          ways: [
            {
              kind: "script",
              runtime: "node",
              code: "const a = await browser.fetch(inputs.url); const b = await browser.fetch(inputs.url, {as: 'text'}); return {status: a.status, ok: a.ok, json: a.json, text: typeof b.text};",
            },
          ],
        }),
      );
      const answer = await runAbility("example.com", "fetcher", { url });
      // Objects built inside the vm sandbox carry its prototypes; compare them as JSON.
      assert.deepEqual(JSON.parse(JSON.stringify(answer.result)), {
        status: 200,
        ok: true,
        json: { path: "/books", method: "GET" },
        text: "string",
      });
    });
  } finally {
    server.close();
  }
});

test("a page-script ability runs in the shared browser when no host is given", async () => {
  await withHome(async () => {
    const { useBrowser } = await import("../dist/runtime/bridge.js");
    const cells = [];
    useBrowser({
      run: async (code) => {
        cells.push(code);
        return [{ title: "Sharp Objects", price: "47.82" }];
      },
      status: async () => ({ browsers: 1 }),
      close() {},
    });
    try {
      await saveAbility(
        ability({
          name: "find book",
          inputs: { type: "object", properties: { title: { type: "string" } } },
          ways: [
            {
              kind: "script",
              runtime: "page",
              code: "async (page, bu, inputs) => [{ title: inputs.title, price: '47.82' }]",
            },
          ],
          options: {},
        }),
        { check: false },
      );
      const run = await runAbility("example.com", "find book", { title: "Sharp Objects" });
      assert.equal(run.result[0].title, "Sharp Objects");
      assert.match(cells[0], /hostname\.endsWith\("example\.com"\)/);
      assert.match(cells[0], /browser\.openTab\("https:\/\/example\.com\/"/);
    } finally {
      useBrowser(undefined);
    }
  });
});
