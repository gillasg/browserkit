import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { learnAbout, learnedHint, readLearned } from "../dist/learned.js";

test("what a run learned about a site is kept in its pack and merges", async () => {
  const home = await mkdtemp(join(tmpdir(), "bk-learned-"));
  const previous = process.env.SITE_TO_API_HOME;
  process.env.SITE_TO_API_HOME = home;
  try {
    const first = await learnAbout("shop.example", {
      gate: "age",
      clicked: "I am 18 or older",
      functions: ["getSources", "player"],
    });
    assert.equal(first.runs, 1);
    const second = await learnAbout("shop.example", {
      play: true,
      referer: "https://shop.example/",
      functions: ["getSources", "resolve"],
    });
    assert.equal(second.runs, 2);
    assert.equal(second.gate, "age", "a newer note does not erase an older gate");
    assert.deepEqual(second.functions, ["getSources", "player", "resolve"]);
    const read = await readLearned("shop.example");
    assert.equal(read?.play, true);
    const hint = learnedHint(read);
    assert.match(hint, /gate: age/);
    assert.match(hint, /I am 18 or older/);
    assert.match(hint, /play\/watch/);
    assert.match(hint, /referer required/);
  } finally {
    if (previous === undefined) delete process.env.SITE_TO_API_HOME;
    else process.env.SITE_TO_API_HOME = previous;
    await rm(home, { recursive: true, force: true });
  }
});

test("a site with nothing learned has no hint", () => {
  assert.equal(learnedHint(undefined), "");
  assert.equal(learnedHint({ site: "x.test", runs: 1, updatedAt: "2026-01-01" }), "");
});
