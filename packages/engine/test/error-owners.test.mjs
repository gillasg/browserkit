import assert from "node:assert/strict";
import test from "node:test";
import {
  ERRORS,
  ERROR_ALIASES,
  classifyError,
  errorOwner,
  leadingCode,
  nameModelCodeError,
} from "@browserkit/protocol";

test("every code has an owner and a hint, and every alias lands on a code", () => {
  for (const [code, [owner, hint]] of Object.entries(ERRORS)) {
    assert.ok(["model", "page", "user", "ours"].includes(owner), code);
    assert.ok(hint.length > 20, code);
  }
  for (const [alias, code] of Object.entries(ERROR_ALIASES)) assert.ok(code in ERRORS, alias);
  assert.equal(errorOwner("NOT_A_CODE"), "ours");
});

test("the model's own JavaScript errors are the model's; ours stay ours", () => {
  const thrown = [
    new TypeError("p.goto is not a function"),
    new ReferenceError("text is not defined"),
    new SyntaxError("Unexpected token ':'"),
  ];
  for (const error of thrown) {
    assert.equal(classifyError(error, "model-code"), "CODE_ERROR", error.message);
    assert.equal(classifyError(error), "INTERNAL", error.message);
  }
  // Across the sandbox boundary the class is lost; the words still say whose it was.
  assert.equal(
    classifyError(new Error("Cannot read properties of undefined (reading 'id')"), "model-code"),
    "CODE_ERROR",
  );
});

test("failures found in real traces each get their owner's code", () => {
  const cases = {
    "Browser workflow cancelled; runtime reset": "RUN_RESET",
    "Browser runtime did not respond; runtime reset": "INTERNAL",
    "Failed to fetch": "NETWORK",
    "Detached while handling command.": "TARGET_LOST",
    "Cannot access a chrome-extension:// URL of different extension": "PROTECTED_UI",
    "No page is open yet: start with await page.goto(url)": "INVALID_TARGET",
    "SITE_UNKNOWN: pass a site or open a tab first": "INVALID_INPUT",
    "HTTP: 503 from the site": "SITE_BROKEN",
    USER_TOOK_CONTROL: "USER_TOOK_CONTROL",
  };
  for (const [message, code] of Object.entries(cases))
    assert.equal(classifyError(new Error(message), "model-code"), code, message);
  assert.equal(leadingCode("NO_OPTION: no option named Blue"), "TARGET_NOT_FOUND");
});

test("a model-code failure leads with its shared code and keeps the detail", () => {
  assert.equal(
    nameModelCodeError(new TypeError("bu.site is not a function")),
    "CODE_ERROR: TypeError: bu.site is not a function",
  );
  assert.equal(
    nameModelCodeError(new Error("NO_OPTION: no option named Blue")),
    "TARGET_NOT_FOUND: NO_OPTION: no option named Blue",
  );
  assert.equal(nameModelCodeError(new Error("STALE_REF: old id")), "STALE_REF: old id");
});
