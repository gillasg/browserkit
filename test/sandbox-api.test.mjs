import assert from "node:assert/strict";
import test from "node:test";
import { browserControlsApi } from "../packages/engine/dist/code-api-controls.js";
import { browserSitesApi } from "../packages/engine/dist/code-api-sites.js";

// API source is evaluated inside the sandbox before its message listener is installed. A runtime
// error there leaves every browser cell hanging; execute the real strings with the smallest stubs.
test("the sites API evaluates before the sandbox listener is installed", () => {
  assert.doesNotThrow(() =>
    new Function("__siteToolGroup", "__call", browserSitesApi)(() => ({}), () => undefined),
  );
  assert.doesNotMatch(browserSitesApi, /Object\.Freeze\(/);
});

test("the controls API evaluates before the sandbox listener is installed", () => {
  assert.doesNotThrow(() => new Function(browserControlsApi)());
});
