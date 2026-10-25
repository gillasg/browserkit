import assert from "node:assert/strict";
import test from "node:test";
import { profileArgs, profileDirectory } from "../apps/bridge/dist/commands/profile.js";

test("the managed profile is separate, fresh and extension-free", () => {
  const directory = profileDirectory();
  assert.match(directory, /profile$/);
  const args = profileArgs(directory, "https://example.com");
  assert.ok(args.includes(`--user-data-dir=${directory}`));
  assert.ok(args.includes("--disable-extensions"));
  assert.ok(args.includes("--no-first-run"));
  assert.equal(args.at(-1), "https://example.com");
});
