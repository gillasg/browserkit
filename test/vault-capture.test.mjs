import assert from "node:assert/strict";
import test from "node:test";
import { vaultSubmissionSucceeded } from "../packages/engine/dist/native-browser-vault.js";

// A fixture signup form: success is the page's own evidence, never a toast. The password field
// is gone after a navigation or an in-page submit; a failed request leaves it in place.
const form = (url, hasPassword) => ({
  url,
  site: "example.com",
  hasPassword,
  password: hasPassword ? "secret" : "",
  username: "me@example.com",
  signup: true,
});

test("success comes from navigation or a removed password field", () => {
  assert.equal(vaultSubmissionSucceeded(form("https://example.com/welcome", false)), true);
  assert.equal(vaultSubmissionSucceeded(form("https://example.com/signup", false)), true);
});

test("a failed signup keeps the password form and is not offered for saving", () => {
  assert.equal(vaultSubmissionSucceeded(form("https://example.com/signup", true)), false);
  assert.equal(vaultSubmissionSucceeded(undefined), false);
});
