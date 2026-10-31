import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runEffect } from "../dist/kernel.js";

function recorder() {
  const calls = [];
  return {
    calls,
    checks: {
      authorize: (_, target) => {
        calls.push(["authorize", target]);
        if (target?.tabId === undefined) throw new Error("INVALID_TARGET");
        return target.tabId;
      },
      guardTab: async (_, tabId) => {
        calls.push(["guardTab", tabId]);
        if (tabId === 13) throw new Error("SITE_BLOCKED");
      },
      guardSite: async (_, site) => {
        calls.push(["guardSite", site]);
        if (String(site).includes("blocked.test")) throw new Error("SITE_BLOCKED");
      },
    },
  };
}

const effects = [
  {
    name: "page.thing",
    match: (value) => "thing" in value,
    tab: (value) => value.thing.target,
    run: async (_, __, tabId) => ({ ran: tabId }),
  },
  {
    name: "net.thing",
    match: (value) => "fetch" in value,
    site: (value) => value.fetch,
    run: async () => ({ ran: "fetch" }),
  },
];

test("a tab effect runs only after its tab is authorized and guarded", async () => {
  const { calls, checks } = recorder();
  const done = await runEffect(effects, checks, {}, { thing: { target: { tabId: 7 } } });
  assert.deepEqual(done, { value: { ran: 7 } });
  assert.deepEqual(calls, [
    ["authorize", { tabId: 7 }],
    ["guardTab", 7],
  ]);
});

test("a refused tab or site never reaches the effect", async () => {
  const { checks } = recorder();
  await assert.rejects(runEffect(effects, checks, {}, { thing: {} }), /INVALID_TARGET/);
  await assert.rejects(
    runEffect(effects, checks, {}, { thing: { target: { tabId: 13 } } }),
    /SITE_BLOCKED/,
  );
  await assert.rejects(
    runEffect(effects, checks, {}, { fetch: "https://blocked.test/x" }),
    /SITE_BLOCKED/,
  );
});

test("a request no effect claims is left to the host", async () => {
  const { calls, checks } = recorder();
  assert.equal(await runEffect(effects, checks, {}, { other: true }), undefined);
  assert.deepEqual(calls, []);
});

// The effect table imports Chrome-only modules, so its contract is checked on the source:
// an effect that acts in a tab must declare that tab, and one that reaches the web its site.
test("every declared effect that uses a tab or a URL declares it", () => {
  const source = readFileSync(new URL("../src/code-runtime-effects.ts", import.meta.url), "utf8");
  const blocks = source.split(/\n\s*\{\n\s*name: /).slice(1);
  assert.ok(blocks.length > 20, "effects found");
  for (const tail of blocks) {
    const block = tail.split(/\n\s*\},?\n/)[0];
    const name = block.slice(0, block.indexOf("\n"));
    if (/tabId/.test(block)) assert.match(block, /\btab: /, `${name} acts in a tab`);
    if (/fetchCall|googleCall|siteMapper/.test(block))
      assert.match(block, /\bsite: /, `${name} reaches the web`);
  }
});
