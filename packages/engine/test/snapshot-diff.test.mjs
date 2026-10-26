import assert from "node:assert/strict";
import test from "node:test";
import { compareTree } from "../dist/native-browser-observation.js";

const node = (id, name, checked = false) => ({
  backendNodeId: id,
  role: "checkbox",
  name,
  checked,
});

test("a tree diff reports added, changed and removed nodes", () => {
  const key = "tab:diff-test";
  const first = compareTree(key, 1, [node(1, "one"), node(2, "two")]);
  assert.equal(first.reset, true);
  const second = compareTree(key, 1, [node(1, "one", true), node(3, "three")]);
  assert.deepEqual(second.changed, [1]);
  assert.deepEqual(second.removed, [2]);
  assert.deepEqual(second.added, [3]);
  const third = compareTree(key, 1, [node(1, "one", true), node(3, "three")]);
  assert.deepEqual(third, { added: [], removed: [], changed: [], unchanged: 2 });
});

test("a new document resets the diff", () => {
  const key = "tab:diff-reset";
  compareTree(key, 1, [node(1, "one")]);
  assert.equal(compareTree(key, 2, [node(1, "one")]).reset, true);
});
