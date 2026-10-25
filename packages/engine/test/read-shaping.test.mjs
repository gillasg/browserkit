import assert from "node:assert/strict";
import test from "node:test";
import { createSemanticNodes } from "../dist/native-browser-observation.js";

let nextId = 1;
function node(role, name, extra = {}) {
  const nodeId = String(nextId++);
  return {
    nodeId,
    backendDOMNodeId: Number(nodeId) + 1000,
    role: { value: role },
    name: { value: name },
    ...extra,
  };
}

function tree(count) {
  return Array.from({ length: count }, (_, index) => node("button", `Button ${index}`));
}

test("the default view keeps at most 180 nodes; all keeps more", () => {
  const many = tree(240);
  assert.equal(createSemanticNodes(many).nodes.length, 180);
  assert.equal(createSemanticNodes(many, { all: true }).nodes.length, 240);
});

test("summary leaves out body text and keeps headings and controls", () => {
  const nodes = [
    node("heading", "Welcome"),
    node("statictext", "A long paragraph of body copy"),
    node("button", "Buy"),
    node("navigation", "Main"),
  ];
  const nodesOut = createSemanticNodes(nodes, { summary: true }).nodes;
  assert.deepEqual(
    nodesOut.map((item) => item.name),
    ["Welcome", "Buy", "Main"],
  );
});

test("noText drops static text and paragraphs", () => {
  const nodes = [node("heading", "Title"), node("statictext", "Body"), node("paragraph", "More")];
  assert.deepEqual(
    createSemanticNodes(nodes, { noText: true }).nodes.map((item) => item.name),
    ["Title"],
  );
});

test("compact shortens names and leaves state properties out", () => {
  const long = "x".repeat(300);
  const nodes = [
    node("button", long, { properties: [{ name: "disabled", value: { value: true } }] }),
  ];
  const plain = createSemanticNodes(nodes).nodes[0];
  const compact = createSemanticNodes(nodes, { compact: true }).nodes[0];
  assert.equal(plain.name.length, 300);
  assert.equal(compact.name.length, 80);
  assert.equal(plain.disabled, true);
  assert.equal(compact.disabled, undefined);
  const compactState = createSemanticNodes(
    [node("checkbox", "Agree", { properties: [{ name: "checked", value: { value: true } }] })],
    { compact: true },
  ).nodes[0];
  assert.equal(compactState.checked, undefined);
});

test("maxBytes trims nodes from the end", () => {
  const many = tree(100);
  const full = createSemanticNodes(many).nodes;
  const trimmed = createSemanticNodes(many, { maxBytes: 3000 }).nodes;
  assert.ok(trimmed.length < full.length);
  assert.ok(JSON.stringify(trimmed).length <= 3000);
});

test("depth keeps only nodes near the root", () => {
  const root = node("generic", "");
  const child = node("button", "Child", { parentId: root.nodeId });
  const grandchild = node("button", "Grandchild", { parentId: child.nodeId });
  const deep = createSemanticNodes([root, child, grandchild], { depth: 3 }).nodes;
  assert.deepEqual(
    deep.map((item) => item.name),
    ["Child", "Grandchild"],
  );
  const shallow = createSemanticNodes([root, child, grandchild], { depth: 2 }).nodes;
  assert.deepEqual(
    shallow.map((item) => item.name),
    ["Child"],
  );
});

test("hidden nodes appear only when includeHidden is set, and are marked", () => {
  const nodes = [node("button", "Visible"), node("button", "Offscreen", { ignored: true })];
  assert.equal(createSemanticNodes(nodes).nodes.length, 1);
  const withHidden = createSemanticNodes(nodes, { includeHidden: true }).nodes;
  assert.equal(withHidden.length, 2);
  assert.equal(withHidden.find((item) => item.name === "Offscreen")?.hidden, true);
});
