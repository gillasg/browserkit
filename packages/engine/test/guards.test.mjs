import assert from "node:assert/strict";
import test from "node:test";
import { cdpChangesPage, refusedCdp, stepChangesPage } from "../dist/native-browser-guards.js";

test("write steps are classified and reads are not", () => {
  assert.equal(stepChangesPage({ op: "click" }), true);
  assert.equal(stepChangesPage({ op: "fill" }), true);
  assert.equal(stepChangesPage({ op: "observe" }), false);
  assert.equal(stepChangesPage({ op: "evaluate" }), false);
  assert.equal(stepChangesPage({ op: "cdp", method: "Page.captureScreenshot" }), false);
  assert.equal(stepChangesPage({ op: "cdp", method: "Network.setCookie" }), true);
});

test("browser-wide clears are refused, scoped storage is not", () => {
  assert.match(refusedCdp("Network.clearBrowserCookies"), /browser\.cookies/);
  assert.match(refusedCdp("Storage.clearDataForOrigin", {}), /origin/);
  assert.equal(refusedCdp("Storage.clearDataForOrigin", { origin: "https://example.com" }), undefined);
  assert.equal(cdpChangesPage("Page.captureScreenshot"), false);
});
