import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { siteCapabilities } from "../dist/site-capabilities.js";

async function writeFixture(root, site) {
  const dir = join(root, "sites", site);
  await mkdir(join(dir, "abilities"), { recursive: true });
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
    join(dir, "abilities", "products.json"),
    JSON.stringify({
      name: "products",
      site,
      description: "List products",
      kind: "read",
      inputs: { type: "object", properties: { page: { type: "number" } } },
      ways: [{ kind: "api", operation: "searchProducts" }],
      options: {},
      stats: { runs: 3, failures: 0, lastOkAt: new Date().toISOString() },
      createdBy: "user",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }),
  );
  await writeFile(join(dir, "notes.md"), "# Site\n\ngate needs Accept\n");
}

test("capabilities merge abilities, operations and notes", async () => {
  const root = await mkdtemp(join(tmpdir(), "bue-caps-"));
  const old = process.env.SITE_TO_API_HOME;
  process.env.SITE_TO_API_HOME = root;
  const site = "shop.example";
  await writeFixture(root, site);
  try {
    const answer = await siteCapabilities(site);
    assert.equal(answer.site, site);
    assert.deepEqual(
      answer.abilities.map((ability) => ability.name),
      ["products"],
    );
    assert.deepEqual(answer.abilities[0].ways, ["api"]);
    assert.equal(answer.abilities[0].stats.runs, 3);
    assert.deepEqual(
      answer.operations.map((operation) => operation.name),
      ["searchProducts", "createOrder"],
    );
    assert.deepEqual(answer.operations[0].capabilities, ["search"]);
    assert.match(answer.notes, /gate needs Accept/);
  } finally {
    if (old === undefined) delete process.env.SITE_TO_API_HOME;
    else process.env.SITE_TO_API_HOME = old;
    await rm(root, { recursive: true, force: true });
  }
});
