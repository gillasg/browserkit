import assert from "node:assert/strict";
import test from "node:test";
import { cookieUrl } from "../dist/native-browser-cookies.js";

test("a domain becomes a cookie url chrome accepts", () => {
  assert.equal(cookieUrl("example.com"), "https://example.com/");
  assert.equal(cookieUrl(".example.com"), "https://example.com/");
  assert.equal(cookieUrl("example.com", "/app"), "https://example.com/app");
  assert.equal(cookieUrl("example.com", "app"), "https://example.com/app");
});
