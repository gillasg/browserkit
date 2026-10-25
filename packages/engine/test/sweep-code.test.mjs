import assert from "node:assert/strict";
import test from "node:test";
import { sweepCode, sweepOptions } from "../dist/code-sweep-code.js";
import { judgeOutcome, registrableDomain } from "../dist/outcomes.js";

function harness(code, browser, __call) {
  const run = new Function("browser", "__keptTabs", "bu", "__call", `"use strict"; return ${code}`);
  return run(browser, new Set(), { progress: () => undefined }, __call);
}

function fakeTab(overrides = {}) {
  return {
    target: { tabId: 11 },
    waitReady: async () => ({ state: "ready" }),
    enterSite: async () => ({ gate: "age", clicked: "I am 18 or older" }),
    wait: async () => undefined,
    network: {
      list: async () => [
        { url: "https://cdn.example/master.m3u8", mimeType: "application/x-mpegURL" },
        { url: "https://cdn.example/page.css", mimeType: "text/css" },
      ],
    },
    media: async () => ({ masters: [{ url: "m", variants: [{ height: 1080 }] }], playlists: [] }),
    url: async () => "https://shop.example/watch",
    title: async () => "Watch",
    evaluate: async () => "I am 18 or older",
    screenshot: async () => ({ dataBase64: "AA==" }),
    close: async () => undefined,
    ...overrides,
  };
}

test("a sweep item opens, gates, captures media, saves evidence and judges itself ok", async () => {
  const calls = [];
  const tab = fakeTab();
  const code = sweepCode({
    jobId: "sweep-1",
    urls: ["https://shop.example/watch"],
    options: sweepOptions({
      concurrency: 1,
      timeoutMs: 5000,
      capture: "media",
      evidence: true,
      gate: true,
    }),
    judge: judgeOutcome.toString(),
    domain: registrableDomain.toString(),
  });
  const value = await harness(code, { openTab: async () => tab }, async (request) => {
    calls.push(request);
    return request.workspace ? { saved: "sweep/x/0.png" } : {};
  });
  const record = value.results[0];
  assert.equal(record.outcome, "ok");
  assert.match(record.reason, /captured/);
  assert.equal(record.media.masters.length, 1);
  assert.equal(record.evidence.screenshot, "sweep/sweep-1/0.png");
  assert.equal(
    calls.some((call) => call.job?.action === "item" && call.job.index === 0),
    true,
  );
});

test("a sweep with no capture says shell rather than throwing", async () => {
  const tab = fakeTab({
    media: async () => ({ masters: [], playlists: [] }),
    network: { list: async () => [] },
    enterSite: async () => ({ gate: "none", clicked: null }),
    url: async () => "https://quiet.example/",
  });
  const code = sweepCode({
    jobId: "sweep-2",
    urls: ["https://quiet.example/"],
    options: sweepOptions({ concurrency: 1, capture: "media" }),
    judge: judgeOutcome.toString(),
    domain: registrableDomain.toString(),
  });
  const value = await harness(code, { openTab: async () => tab }, async () => ({}));
  assert.equal(value.results[0].outcome, "shell");
  assert.match(value.results[0].reason, /nothing found/);
});

test("a tab that fails to open is an error record, not a lost job", async () => {
  const code = sweepCode({
    jobId: "sweep-3",
    urls: ["https://down.example/"],
    options: sweepOptions({}),
    judge: judgeOutcome.toString(),
    domain: registrableDomain.toString(),
  });
  const value = await harness(
    code,
    {
      openTab: async () => {
        throw new Error("TARGET_LOST");
      },
    },
    async () => ({}),
  );
  assert.equal(value.results[0].outcome, "error");
  assert.match(value.results[0].reason, /TARGET_LOST/);
});
