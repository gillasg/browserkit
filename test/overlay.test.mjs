import assert from "node:assert/strict";
import test from "node:test";
import {
  isBrowserkitOverlay,
  isBrowserkitOverlayEvent,
} from "../packages/engine/dist/native-browser-overlay.js";

test("an overlay host is recognised through its attribute", () => {
  const overlay = { hasAttribute: (name) => name === "data-browserkit-overlay" };
  const page = { hasAttribute: () => false };
  assert.equal(isBrowserkitOverlay(overlay), true);
  assert.equal(isBrowserkitOverlay(page), false);
  assert.equal(isBrowserkitOverlay(undefined), false);
  assert.equal(isBrowserkitOverlayEvent([page, overlay]), true);
  assert.equal(isBrowserkitOverlayEvent([page]), false);
});
