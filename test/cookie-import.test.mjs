import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readCookies } from "../apps/bridge/dist/cookie-import.js";

test("Firefox cookies are read and session cookies are optional", async () => {
  const root = await mkdtemp(join(tmpdir(), "bue-ff-"));
  const dir = join(root, "Mozilla", "Firefox", "Profiles", "test");
  await mkdir(dir, { recursive: true });
  const db = new DatabaseSync(join(dir, "cookies.sqlite"));
  db.exec(
    "CREATE TABLE moz_cookies (host TEXT, path TEXT, name TEXT, value TEXT, expiry INTEGER, isSecure INTEGER, isHttpOnly INTEGER, sameSite INTEGER)",
  );
  db.prepare("INSERT INTO moz_cookies VALUES (?,?,?,?,?,?,?,?)").run(
    ".example.com",
    "/",
    "sid",
    "secret",
    2000000000,
    1,
    1,
    1,
  );
  db.prepare("INSERT INTO moz_cookies VALUES (?,?,?,?,?,?,?,?)").run(
    "example.com",
    "/",
    "tmp",
    "session",
    0,
    0,
    0,
    0,
  );
  db.close();
  const old = process.env.APPDATA;
  process.env.APPDATA = root;
  try {
    const result = await readCookies({
      from: "firefox",
      profile: "test",
      domains: ["example.com"],
      includeSession: false,
    });
    assert.equal(result.cookies.length, 1);
    assert.equal(result.cookies[0].domain, ".example.com");
    assert.equal(result.cookies[0].value, "secret");
    const all = await readCookies({
      from: "firefox",
      profile: "test",
      domains: ["example.com"],
      includeSession: true,
    });
    assert.equal(all.cookies.length, 2);
  } finally {
    process.env.APPDATA = old;
    await rm(root, { recursive: true, force: true });
  }
});

test("Chromium empty encrypted values are usable and v20 is skipped", async () => {
  const root = await mkdtemp(join(tmpdir(), "bue-chromium-"));
  const dir = join(root, "Microsoft", "Edge", "User Data", "Default", "Network");
  await mkdir(dir, { recursive: true });
  const db = new DatabaseSync(join(dir, "Cookies"));
  db.exec(
    "CREATE TABLE cookies (host_key TEXT, path TEXT, name TEXT, value TEXT, encrypted_value TEXT, expires_utc INTEGER, is_secure INTEGER, is_httponly INTEGER, samesite INTEGER, is_persistent INTEGER)",
  );
  db.prepare("INSERT INTO cookies VALUES (?,?,?,?,?,?,?,?,?,?)").run(
    ".example.com",
    "/",
    "sid",
    "plain",
    "",
    1330000000000000,
    1,
    1,
    2,
    1,
  );
  db.prepare("INSERT INTO cookies VALUES (?,?,?,?,?,?,?,?,?,?)").run(
    ".example.com",
    "/",
    "v20",
    "",
    "v20abc",
    1330000000000000,
    1,
    1,
    2,
    1,
  );
  db.close();
  const old = process.env.LOCALAPPDATA;
  process.env.LOCALAPPDATA = root;
  try {
    const result = await readCookies({
      from: "edge",
      profile: "Default",
      domains: [],
      includeSession: false,
    });
    assert.equal(result.cookies.length, 1);
    assert.equal(result.skippedV20, 1);
    assert.equal(result.cookies[0].sameSite, "strict");
  } finally {
    process.env.LOCALAPPDATA = old;
    await rm(root, { recursive: true, force: true });
  }
});
