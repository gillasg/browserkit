import assert from "node:assert/strict";
import test from "node:test";
import { createSemanticNodes } from "../dist/native-browser-observation.js";

test("a frame's nodes follow its iframe, with prefixed refs routed to that session", () => {
  const nodes = [
    { nodeId: "1", backendDOMNodeId: 1, role: { value: "RootWebArea" }, frameId: "root" },
    {
      nodeId: "2",
      backendDOMNodeId: 2,
      role: { value: "button" },
      name: { value: "Top" },
      frameId: "root",
    },
    {
      nodeId: "3",
      backendDOMNodeId: 3,
      role: { value: "Iframe" },
      name: { value: "Checkout" },
      frameId: "root",
      frameOwner: "frame-2",
    },
    {
      nodeId: "4",
      backendDOMNodeId: 40,
      role: { value: "textbox" },
      name: { value: "Card" },
      frameId: "frame-2",
      sessionId: "session-2",
    },
  ];
  const result = createSemanticNodes(nodes);
  assert.deepEqual(
    result.nodes.map((node) => node.ref),
    ["e0", "e1", "f1:e0"],
  );
  assert.equal(result.nodes[2].frame, "f1");
  const inner = result.refs.get("f1:e0");
  assert.equal(inner?.backendNodeId, 40);
  assert.equal(inner?.sessionId, "session-2");
  assert.equal(inner?.frameId, "frame-2");
});

test("a frame whose iframe is not shown keeps its nodes at the end", () => {
  const nodes = [
    { nodeId: "1", backendDOMNodeId: 1, role: { value: "RootWebArea" }, frameId: "root" },
    {
      nodeId: "9",
      backendDOMNodeId: 90,
      role: { value: "link" },
      name: { value: "Terms" },
      frameId: "frame-9",
      sessionId: "session-9",
    },
  ];
  const result = createSemanticNodes(nodes);
  assert.equal(result.nodes.at(-1)?.ref, "f1:e0");
  assert.equal(result.refs.get("f1:e0")?.sessionId, "session-9");
});
