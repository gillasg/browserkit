import assert from "node:assert/strict";
import test from "node:test";

const calls = [];
globalThis.chrome = {
  debugger: {
    sendCommand: async (_debuggee, method, params) => {
      calls.push({ method, params });
      return {};
    },
  },
};

const { scrollAt } = await import("../dist/native-browser-debugger.js");
const { executeInteraction } = await import("../dist/native-browser-input.js");

test("page.scroll sends a glide of wheel frames, not one jump", async () => {
  calls.length = 0;
  await scrollAt({ tabId: 1 }, 50, 50, "down", 1200);
  const wheels = calls.filter((call) => call.method === "Input.dispatchMouseEvent");
  assert.ok(wheels.length >= 4, `sent ${wheels.length} wheel frames`);
  const deltas = wheels.map((call) => Number(call.params.deltaY));
  assert.ok(
    deltas.every((delta) => delta >= 0),
    JSON.stringify(deltas),
  );
  assert.ok(deltas.at(-1) < deltas[0], JSON.stringify(deltas));
});

test("keyboard text is paced one insertText frame per character", async () => {
  calls.length = 0;
  await executeInteraction(
    { tabId: 1 },
    { op: "keys", keys: "ab", target: { tabId: 1, clientInstanceId: "x" } },
  );
  const frames = calls.filter((call) => call.method === "Input.insertText");
  assert.equal(frames.length, 2, JSON.stringify(calls));
  assert.deepEqual(
    frames.map((call) => call.params.text),
    ["a", "b"],
  );
});
