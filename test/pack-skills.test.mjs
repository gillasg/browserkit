import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  enableSiteSkills,
  importSiteSkills,
  readSiteSkills,
  siteSkillCall,
} from "../apps/bridge/dist/site-skills.js";

test("imported skills are enabled", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "browserkit-skills-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const imported = await importSiteSkills(directory, [
    { name: "search", domains: ["shop.example"], description: "Search", code: "const x = 1;" },
    { name: "other", domains: ["other.example"], code: "const y = 2;" },
  ]);
  assert.deepEqual(
    imported.map((skill) => [skill.name, skill.enabled]),
    [
      ["search", true],
      ["other", true],
    ],
  );
  assert.deepEqual(
    (await siteSkillCall(directory, { siteSkill: "list" })).map((skill) => skill.name).sort(),
    ["other", "search"],
  );
  assert.equal(
    (await siteSkillCall(directory, { siteSkill: "get", name: "search" })).name,
    "search",
  );
  assert.equal((await readSiteSkills(directory)).length, 2);

  assert.deepEqual(await enableSiteSkills(directory, "shop.example"), []);
  assert.deepEqual(
    (await siteSkillCall(directory, { siteSkill: "list", url: "https://shop.example/x" })).map(
      (skill) => skill.name,
    ),
    ["search"],
  );
  assert.equal(
    (await siteSkillCall(directory, { siteSkill: "get", name: "search" })).name,
    "search",
  );
  assert.deepEqual(
    (await siteSkillCall(directory, { siteSkill: "list" })).map((skill) => skill.name).sort(),
    ["other", "search"],
  );
});
