import assert from "node:assert/strict";
import test from "node:test";
import { privateTarget } from "../dist/native-browser-policy.js";

test("private, metadata and local names are recognised", () => {
  assert.ok(privateTarget("http://10.1.2.3/"));
  assert.ok(privateTarget("http://192.168.1.1/"));
  assert.ok(privateTarget("http://169.254.169.254/latest"));
  assert.ok(privateTarget("http://metadata.google.internal/"));
  assert.ok(privateTarget("http://printer.local/"));
  assert.equal(privateTarget("https://example.com/"), undefined);
});

test("the localhost port allowlist keeps local development working", () => {
  assert.equal(privateTarget("http://127.0.0.1:3000/app", [3000]), undefined);
  assert.ok(privateTarget("http://127.0.0.1:8080/app", [3000]));
  assert.equal(privateTarget("http://localhost:8787/", [8787]), undefined);
});
