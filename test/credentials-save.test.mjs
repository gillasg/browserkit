import assert from "node:assert/strict";
import test from "node:test";
import { handleCredentialRequest } from "../packages/credentials/dist/index.js";

// The password manager is mocked at the provider boundary so the test proves what the engine
// sends (site, username, password) and that the caller's answer never carries the value.
test("a successful form is saved through the configured password manager", async () => {
  const saved = [];
  const provider = {
    name: "Test Vault",
    logins: async () => [],
    totp: async () => undefined,
    status: async () => "unlocked",
    saveLogin: async (login) => {
      saved.push(login);
      return true;
    },
  };
  const answer = await handleCredentialRequest(
    {
      credential: "save",
      url: "https://example.com/login",
      username: "me@example.com",
      password: "vault-password-42",
      name: "Example",
    },
    "/tmp/unused",
    provider,
  );
  assert.deepEqual(answer, { saved: true, provider: "Test Vault" });
  assert.equal(saved.length, 1);
  assert.deepEqual(saved[0], {
    url: "https://example.com/login",
    name: "Example",
    username: "me@example.com",
    password: "vault-password-42",
  });
  assert.ok(!JSON.stringify(answer).includes("vault-password-42"));
});

test("a failed save says so without echoing the password", async () => {
  const provider = {
    name: "Test Vault",
    logins: async () => [],
    totp: async () => undefined,
    status: async () => "unlocked",
    saveLogin: async () => {
      throw new Error("locked");
    },
  };
  const answer = await handleCredentialRequest(
    {
      credential: "save",
      url: "https://example.com/login",
      username: "me@example.com",
      password: "vault-password-42",
    },
    "/tmp/unused",
    provider,
  );
  assert.deepEqual(answer, { saved: false, provider: "Test Vault" });
  assert.ok(!JSON.stringify(answer).includes("vault-password-42"));
});
