import assert from "node:assert/strict";
import test from "node:test";
import { prefersGoogle, search } from "../dist/index.js";

test("auto search sends local, live and personal queries to Google", () => {
  for (const query of ["pizza near me", "lakers score tonight", "price of rtx 5090", "my orders"])
    assert.equal(prefersGoogle(query), true, query);
  for (const query of ["rust borrow checker explained", "pnpm workspace protocol docs"])
    assert.equal(prefersGoogle(query), false, query);
});

test("google results come from the user's browser and say so", async () => {
  const bridge = async () => ({
    run: async (code) => {
      assert.match(code, /google\.search\("pizza near me"/);
      return [{ title: "Pizza", url: "https://pizza.example/" }];
    },
  });
  const results = await search("pizza near me", { bridge });
  assert.deepEqual(results, [{ title: "Pizza", url: "https://pizza.example/", source: "google" }]);
});
