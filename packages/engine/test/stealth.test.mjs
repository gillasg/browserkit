import assert from "node:assert/strict";
import test from "node:test";
import {
  forgetStealth,
  injectedScripts,
  judgeStealth,
  noteInjectedScript,
} from "../dist/stealth.js";

test("a clean page has no signals", () => {
  const report = judgeStealth({}, { runtimeEnabled: false, injectedScripts: [] });
  assert.equal(report.detectable, false);
  assert.deepEqual(report.signals, []);
});

test("each observable signal is named", () => {
  const report = judgeStealth(
    {
      webdriver: true,
      globals: ["__aeonDemo"],
      overlays: ["#aeon-handoff"],
      wrapped: ["window.open"],
      geolocationShim: true,
    },
    { runtimeEnabled: true, injectedScripts: ["quiet tab"] },
  );
  assert.equal(report.detectable, true);
  assert.equal(report.signals.length, 7);
  assert.match(report.signals.join("\n"), /navigator\.webdriver/);
  assert.match(report.signals.join("\n"), /Runtime domain/);
  assert.match(report.signals.join("\n"), /__aeonDemo/);
  assert.match(report.signals.join("\n"), /#aeon-handoff/);
  assert.match(report.signals.join("\n"), /window\.open/);
  assert.match(report.signals.join("\n"), /quiet tab/);
});

test("queued scripts are cleared with the tab", () => {
  noteInjectedScript(7, "dialogs");
  noteInjectedScript(7, "location");
  assert.deepEqual(injectedScripts(7).sort(), ["dialogs", "location"]);
  forgetStealth(7);
  assert.deepEqual(injectedScripts(7), []);
});
