import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { siteCapabilities } from "../dist/site-capabilities.js";

async function writeFixture(root, site) {
  const dir = join(root, "sites", site);
  await mkdir(join(dir, "flows"), { recursive: true });
  await writeFile(
    join(dir, "model.json"),
    JSON.stringify({
      site,
      generatedAt: new Date().toISOString(),
      operations: [
        {
          id: "searchProducts",
          summary: "Search products",
          path: "/search",
          method: "GET",
          role: "read",
          capabilities: ["search"],
          params: [{ name: "q", in: "query" }],
          responses: { 200: { mime: "application/json", schema: { type: "object" } } },
        },
        {
          id: "createOrder",
          summary: "Create order",
          path: "/orders",
          method: "POST",
          role: "action",
          params: [{ name: "item", in: "body" }],
          responses: { 201: { mime: "application/json", schema: { type: "object" } } },
        },
      ],
    }),
  );
  await writeFile(
    join(dir, "recipes.json"),
    JSON.stringify({
      version: 1,
      recipes: [
        {
          version: 1,
          name: "products",
          site,
          description: "List products",
          strategies: [{ kind: "api" }],
          params: { page: { type: "number" } },
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ],
    }),
  );
  await writeFile(
    join(dir, "flows", "checkout.json"),
    JSON.stringify({
      name: "checkout",
      file: "checkout.har",
      recordedAt: new Date().toISOString(),
    }),
  );
  await writeFile(join(dir, "flows", "checkout.har"), "{}");
  await writeFile(
    join(dir, "tools.json"),
    JSON.stringify({
      version: 1,
      tools: [
        {
          name: "track",
          description: "Track an order",
          code: "return 1",
          params: [],
          enabled: true,
        },
      ],
      pageTools: [],
    }),
  );
  await writeFile(
    join(dir, "learned.json"),
    JSON.stringify({
      site,
      note: "gate needs Accept",
      runs: 1,
      updatedAt: new Date().toISOString(),
    }),
  );
}

test("capabilities merge operations, recipes, flows, tools and learned notes", async () => {
  const root = await mkdtemp(join(tmpdir(), "bue-caps-"));
  const old = process.env.SITE_TO_API_HOME;
  process.env.SITE_TO_API_HOME = root;
  const site = "shop.example";
  await writeFixture(root, site);
  try {
    const answer = await siteCapabilities(site);
    assert.equal(answer.site, site);
    assert.deepEqual(
      answer.items.map((item) => item.kind),
      ["operation", "recipe", "tool", "workflow", "operation"],
    );
    assert.equal(answer.items[0].does, "read");
    assert.equal(answer.items.at(-1).does, "write");
    assert.deepEqual(answer.items[0].capabilities, ["search"]);
    assert.match(answer.notes[0], /gate needs Accept/);
  } finally {
    if (old === undefined) delete process.env.SITE_TO_API_HOME;
    else process.env.SITE_TO_API_HOME = old;
    await rm(root, { recursive: true, force: true });
  }
});
