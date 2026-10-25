import assert from "node:assert/strict";
import test from "node:test";
import { jobCode, jobOptions } from "../dist/code-job-code.js";

function harness(code, browser, __call) {
  const run = new Function("browser", "__keptTabs", "bu", "__call", `"use strict"; return ${code}`);
  return run(browser, new Set(), { progress: () => undefined }, __call);
}

test("a job reports every finished item as it lands", async () => {
  const items = ["https://a.example/1", "https://b.example/2"];
  const calls = [];
  const browser = {
    openTab: async () => ({
      target: { tabId: 7 },
      close: async () => undefined,
      title: async () => "page",
    }),
  };
  const code = jobCode({
    jobId: "job-1",
    items,
    fn: "async (tab, item) => ({ url: item })",
    options: jobOptions({ concurrency: 1, timeoutMs: 5000 }),
  });
  const value = await harness(code, browser, async (request) => {
    calls.push(request);
    return {};
  });
  assert.equal(value.complete, true);
  assert.equal(value.results.length, 2);
  assert.deepEqual(
    calls.map((call) => [call.job.action, call.job.index]),
    [
      ["item", 0],
      ["item", 1],
    ],
  );
  assert.equal(value.results[0].value.url, items[0]);
});

test("a resumed job writes from its offset and keeps the earlier results", async () => {
  const browser = {
    openTab: async () => ({
      target: { tabId: 8 },
      close: async () => undefined,
      title: async () => "page",
    }),
  };
  const calls = [];
  const code = jobCode({
    jobId: "job-2",
    items: ["https://c.example/3"],
    fn: "async (tab, item) => ({ url: item })",
    options: jobOptions({ concurrency: 1, timeoutMs: 5000 }),
    offset: 2,
  });
  const value = await harness(code, browser, async (request) => {
    calls.push(request);
    return {};
  });
  assert.equal(value.total, 3);
  assert.equal(value.offset, 2);
  assert.equal(value.results.length, 3);
  assert.equal(calls[0].job.index, 2);
});
