import assert from "node:assert/strict";
import test from "node:test";
import { parseLocatorShorthand } from "../dist/locator-shorthand.js";

test("locator shorthands become the existing specs", () => {
  assert.deepEqual(parseLocatorShorthand("text=Sign in").spec, {
    kind: "query",
    by: "text",
    value: "Sign in",
  });
  const role = parseLocatorShorthand('role=button[name="Save"] >> nth=1');
  assert.equal(role.index, 1);
  assert.equal(role.spec.kind, "locator");
  assert.equal(role.spec.role, "button");
  assert.equal(role.spec.name, "Save");
  assert.equal(parseLocatorShorthand("xpath=//li[2]").spec.by, "xpath");
  assert.deepEqual(parseLocatorShorthand("#save").spec, {
    kind: "query",
    by: "css",
    value: "#save",
  });
});

test("quotes and :has-text are scanned, not split", () => {
  const text = parseLocatorShorthand('text="a >> b"');
  assert.equal(text.spec.value, "a >> b");
  const chained = parseLocatorShorthand('section >> :has-text("a >> b")');
  assert.equal(chained.spec.scope, "section");
  assert.deepEqual(chained.spec.filters, [{ hasText: "a >> b" }]);
  const role = parseLocatorShorthand('role=button[name="a :has-text(b)"]');
  assert.equal(role.spec.name, "a :has-text(b)");
});

test("only text= and role= at the token start are shorthand", () => {
  assert.equal(
    parseLocatorShorthand('[data-label="text=Save"]').spec.value,
    '[data-label="text=Save"]',
  );
  assert.equal(parseLocatorShorthand("main > .x").spec.value, "main > .x");
});
