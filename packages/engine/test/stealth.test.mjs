import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import test from "node:test";
import {
  forgetStealth,
  injectedScripts,
  judgeStealth,
  noteInjectedScript,
} from "../dist/stealth.js";
import { nativeSourcePreamble } from "../dist/native-source.js";

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

test("own properties or symbols on a wrapper are reported", () => {
  const report = judgeStealth(
    { leaks: ["window.open has its own toString", "window has Symbol(browserkit.quiet)"] },
    { runtimeEnabled: false, injectedScripts: [] },
  );
  assert.equal(report.detectable, true);
  assert.match(report.signals.join("\n"), /own toString/);
  assert.match(report.signals.join("\n"), /Symbol\(browserkit\.quiet\)/);
});

test("the shared native-source helper makes wrapped functions and itself look native", () => {
  const result = runInNewContext(
    `(() => {
      ${nativeSourcePreamble}
      const real = Function.prototype.bind;
      const wrapper = function () {};
      __keepNative(wrapper, real);
      const second = function () {};
      __keepNative(second, wrapper);
      return {
        first: Function.prototype.toString.call(wrapper),
        second: Function.prototype.toString.call(second),
        own: Object.getOwnPropertyNames(wrapper),
        proxy: Function.prototype.toString.call(Function.prototype.toString),
      };
    })()`,
    {},
  );
  assert.match(result.first, /\[native code\]/);
  assert.match(result.second, /\[native code\]/);
  assert.match(result.proxy, /\[native code\]/);
  assert.ok(!result.own.includes("toString"));
});
