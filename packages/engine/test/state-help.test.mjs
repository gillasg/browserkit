import assert from "node:assert/strict";
import test from "node:test";
import { HELP_TOPICS } from "../dist/code-api-help.js";
import { refusedCdp } from "../dist/native-browser-guards.js";

test("help('state') names every refused browser-wide clear", () => {
  const text = HELP_TOPICS.state;
  for (const method of [
    "Network.clearBrowserCache",
    "Network.clearBrowserCookies",
    "Storage.clearCookies",
    "Storage.clearDataForOrigin",
  ])
    assert.match(text, new RegExp(method.replace(".", "\\.")));
  assert.match(text, /cookies/i);
  assert.match(text, /service worker/i);
  assert.match(text, /permissions/i);
});

test("page.cdp refusals carry the same browser-wide reason", () => {
  const refused = refusedCdp("Network.clearBrowserCache");
  assert.ok(refused);
  assert.match(refused, /browser-wide/);
  assert.match(refused, /Network\.clearBrowserCache/);
  assert.match(refusedCdp("Storage.clearDataForOrigin", {}) ?? "", /explicit origin/);
});
