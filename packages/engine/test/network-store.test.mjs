import assert from "node:assert/strict";
import test from "node:test";
import {
  bodyGlobal,
  clearGlobal,
  curlGlobal,
  getGlobal,
  harGlobal,
  originsGlobal,
  queryGlobal,
  recordGlobalEntry,
  statsGlobal,
  storeSize,
} from "../dist/network-store.js";

function entry(overrides = {}) {
  return {
    id: "1",
    url: "https://api.example/items?q=1",
    method: "GET",
    type: "Fetch",
    startedAt: Date.now() - 1000,
    requestHeaders: { accept: "application/json", cookie: "sid=secret" },
    status: 200,
    mimeType: "application/json",
    durationMs: 40,
    size: 120,
    body: '{"items":[1,2]}',
    ...overrides,
  };
}

test("the store keeps finished requests and filters them", () => {
  clearGlobal();
  recordGlobalEntry(1, entry({ id: "a" }));
  recordGlobalEntry(1, entry({ id: "b", method: "POST", status: 201, type: "XHR" }));
  recordGlobalEntry(
    2,
    entry({
      id: "c",
      url: "https://cdn.example/app.js",
      type: "Script",
      status: 200,
      body: "console.log(1)",
    }),
  );

  assert.equal(queryGlobal().length, 3);
  assert.equal(queryGlobal({ origin: "https://api.example" }).length, 2);
  assert.equal(queryGlobal({ method: "POST" }).length, 1);
  assert.equal(queryGlobal({ type: "Script" }).length, 1);
  assert.equal(queryGlobal({ status: 201 }).length, 1);
  assert.equal(queryGlobal({ static: "static" }).length, 1);
  assert.equal(queryGlobal({ static: "dynamic" }).length, 2);
  assert.equal(queryGlobal({ match: "cdn.example" }).length, 1);
  assert.equal(storeSize().entries, 3);

  const newest = queryGlobal({ limit: 1 });
  assert.equal(newest.length, 1);
});

test("entries keep a body and a curl, with secrets hidden by default", () => {
  clearGlobal();
  recordGlobalEntry(1, entry({ id: "a" }));
  const found = getGlobal("1:a");
  assert.ok(found);
  assert.equal(found?.body, '{"items":[1,2]}');
  assert.equal(bodyGlobal("1:a").body, '{"items":[1,2]}');
  assert.equal(bodyGlobal("missing").reason, "no request with that id in the store");

  const safe = curlGlobal("1:a") ?? "";
  assert.match(safe, /curl 'https:\/\/api\.example\/items\?q=1'/);
  assert.doesNotMatch(safe, /sid=secret/);
  const full = curlGlobal("1:a", true) ?? "";
  assert.match(full, /sid=secret/);
});

test("origins, stats and HAR summarise what happened", () => {
  clearGlobal();
  recordGlobalEntry(1, entry({ id: "a" }));
  recordGlobalEntry(1, entry({ id: "b", status: 500, size: 10, body: undefined }));
  const origins = originsGlobal();
  assert.deepEqual(origins[0]?.origin, "https://api.example");
  assert.equal(origins[0]?.requests, 2);

  const stats = statsGlobal();
  assert.equal(stats.requests, 2);
  assert.equal(stats.byStatus.find((row) => row.status === 500)?.count, 1);
  assert.equal(stats.byType.find((row) => row.type === "Fetch")?.count, 2);

  const har = harGlobal();
  assert.equal(har.log.entries.length, 2);
  assert.equal(har.log.entries[0].request.method, "GET");
  assert.equal(har.log.entries[0].response.status, 200);

  assert.equal(clearGlobal().cleared, 2);
  assert.equal(queryGlobal().length, 0);
});
