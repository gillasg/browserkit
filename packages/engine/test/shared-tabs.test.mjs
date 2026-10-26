import assert from "node:assert/strict";
import test from "node:test";

globalThis.chrome = {
  storage: { session: { set: async () => undefined } },
};
const { isSharedBrowserTab, shareBrowserTab } = await import("../dist/native-browser-session.js");

test("a tab can be shared and unshared", () => {
  shareBrowserTab(41, true);
  assert.equal(isSharedBrowserTab(41), true);
  shareBrowserTab(41, false);
  assert.equal(isSharedBrowserTab(41), false);
});
