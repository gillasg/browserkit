import assert from "node:assert/strict";
import test from "node:test";
import { hintEvaluateError } from "../dist/native-browser-navigation.js";

test("page globals in a ReferenceError get the sandbox hint", () => {
  assert.match(hintEvaluateError("ReferenceError: document is not defined"), /sandbox/);
  assert.doesNotMatch(hintEvaluateError("ReferenceError: foo is not defined"), /sandbox/);
  assert.match(
    hintEvaluateError("TypeError: Cannot read properties of undefined (reading 'querySelector')"),
    /sandbox/,
  );
});
