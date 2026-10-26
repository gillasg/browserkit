import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  deleteSecretProfile,
  listSecretProfiles,
  readSecretProfile,
  redactSecrets,
  runSecretScript,
  saveSecretProfile,
  setSecretCipherForTests,
} from "../dist/secrets.js";

const home = await mkdtemp(join(tmpdir(), "bue-secrets-"));
const secret = "super-secret-token-42";
const values = {
  site: "example.com",
  savedAt: new Date().toISOString(),
  headers: { Authorization: secret },
  cookies: [{ name: "sid", value: "cookie-value-99", domain: "example.com", path: "/" }],
};
test.after(() => rm(home, { recursive: true, force: true }));

setSecretCipherForTests({
  name: "test",
  async encrypt(text) {
    return Buffer.from(text, "utf8").toString("base64");
  },
  async decrypt(payload) {
    return Buffer.from(payload, "base64").toString("utf8");
  },
});

test("a profile round trips and never writes a plaintext value", async () => {
  const meta = await saveSecretProfile("work", values, home);
  assert.equal(meta.site, "example.com");
  assert.equal(meta.cipher, "test");
  const file = await readFile(join(home, "secrets", "work.json"), "utf8");
  assert.ok(!file.includes(secret));
  assert.ok(!file.includes("cookie-value-99"));
  const profile = await readSecretProfile("work", home);
  assert.equal(profile.values.headers.Authorization, secret);
  assert.equal(profile.values.cookies[0].value, "cookie-value-99");
});

test("list and delete see the profile", async () => {
  const profiles = await listSecretProfiles(home);
  assert.equal(profiles.length, 1);
  assert.equal(profiles[0].name, "work");
  assert.equal(await deleteSecretProfile("work", home), true);
  assert.equal((await listSecretProfiles(home)).length, 0);
  assert.equal(await deleteSecretProfile("work", home), false);
});

test("a missing profile is a clear error", async () => {
  await assert.rejects(() => readSecretProfile("missing", home), /SECRET_PROFILE_MISSING/);
  await assert.rejects(
    () => runSecretScript("missing", "console.log(1)", home),
    /SECRET_PROFILE_MISSING/,
  );
});

test("a script sees BK_* values but its output is redacted", async () => {
  await saveSecretProfile("work", values, home);
  const result = await runSecretScript(
    "work",
    "console.log(process.env.BK_AUTHORIZATION); console.error(process.env.BK_SID); process.exit(3);",
    home,
  );
  assert.equal(result.code, 3);
  assert.ok(result.stdout.includes("[REDACTED]"));
  assert.ok(result.stderr.includes("[REDACTED]"));
  assert.ok(!result.stdout.includes(secret));
  assert.ok(!result.stderr.includes("cookie-value-99"));
});

test("redaction covers values in headers, cookies and storage", () => {
  const redacted = redactSecrets(`token=${secret} sid=cookie-value-99 storage="stored-value"`, {
    ...values,
    localStorage: { "https://example.com": { auth: "stored-value" } },
  });
  assert.ok(!redacted.includes(secret));
  assert.ok(!redacted.includes("cookie-value-99"));
  assert.ok(!redacted.includes("stored-value"));
});
