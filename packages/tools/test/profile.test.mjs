import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { handleProfileRequest, profileKey } from "../dist/profile.js";

test("the form profile keeps names and values apart and refuses secrets", async () => {
  const home = await mkdtemp(join(tmpdir(), "profile-"));
  assert.equal(profileKey("Passport city"), "passportCity");
  const saved = await handleProfileRequest(
    {
      profile: "save",
      values: {
        "First name": "Ada",
        email: "ada@example.com",
        "Card number": "4111 1111 1111 1111",
        note: "4111111111111111",
      },
    },
    home,
  );
  assert.deepEqual(saved.saved, ["firstName", "email"]);
  assert.equal(saved.refused.length, 2);
  assert.deepEqual(await handleProfileRequest({ profile: "fields" }, home), {
    fields: ["firstName", "email"],
  });
  assert.deepEqual(
    await handleProfileRequest({ profile: "values", keys: ["email", "phone"] }, home),
    { values: { email: "ada@example.com" } },
  );
  assert.deepEqual(await handleProfileRequest({ profile: "remove", name: "email" }, home), {
    removed: true,
  });
});
