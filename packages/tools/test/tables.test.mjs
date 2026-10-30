import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { handleTableRequest } from "../dist/tables.js";

test("tables keep rows by key and report what changed", async () => {
  const home = await mkdtemp(join(tmpdir(), "tables-"));
  const opened = await handleTableRequest(
    { table: "open", name: "Founders", columns: { name: "founder", funding: "latest round" } },
    home,
  );
  assert.equal(opened.key, "name");
  const first = await handleTableRequest(
    { table: "upsert", name: "Founders", rows: [{ name: "Ada" }, { name: "Grace" }] },
    home,
  );
  assert.equal(first.added, 2);
  const second = await handleTableRequest(
    {
      table: "upsert",
      name: "Founders",
      rows: [{ name: "Ada", funding: "Seed $2M" }, { name: "Grace" }],
    },
    home,
  );
  assert.deepEqual(second.changed, [{ key: "Ada", columns: ["funding"] }]);
  const rows = await handleTableRequest(
    { table: "rows", name: "Founders", where: { funding: "Seed $2M" } },
    home,
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, "Ada");
  assert.deepEqual(
    await handleTableRequest({ table: "list" }, home).then((list) => list.map((t) => t.rows)),
    [2],
  );
});
