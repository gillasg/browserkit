import assert from "node:assert/strict";
import test from "node:test";

const states = [];
globalThis.chrome = {
  debugger: {
    sendCommand: async (_debuggee, method, params) => {
      if (method === "Page.setWebLifecycleState") states.push(params.state);
      return {};
    },
  },
  storage: { local: { set: async () => undefined, get: async () => ({}) } },
  tabs: { onRemoved: { addListener: () => undefined } },
  runtime: { onStartup: { addListener: () => undefined } },
  alarms: { onAlarm: { addListener: () => undefined }, create: () => undefined },
};

const { trackAgentTab, guardAgentTab, seeAgentTab, forgetAgentTab } =
  await import("../dist/native-browser-tab-cleanup.js");
const { beginManualScreencast } = await import("../dist/native-browser-flight.js");
const { parkIdleAgentTabs, unparkAgentTab } = await import("../dist/native-browser-park.js");

test("an idle agent tab freezes, and a request wakes it before running", async () => {
  states.length = 0;
  trackAgentTab(1, undefined, { url: "https://example.com/" });
  await parkIdleAgentTabs(Date.now() + 31_000);
  assert.deepEqual(states, ["frozen"]);
  await unparkAgentTab(1);
  assert.deepEqual(states, ["frozen", "active"]);
  forgetAgentTab(1);
});

test("seen, guarded and recording tabs are never frozen", async () => {
  states.length = 0;
  trackAgentTab(2);
  seeAgentTab(2);
  trackAgentTab(3);
  guardAgentTab(3, true);
  trackAgentTab(4);
  beginManualScreencast(4);
  await parkIdleAgentTabs(Date.now() + 31_000);
  assert.deepEqual(states, []);
});
