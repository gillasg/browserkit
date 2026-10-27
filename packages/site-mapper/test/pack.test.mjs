import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { strFromU8, unzipSync } from "fflate";
import { exportSitePack, installSitePack, readSitePack, skillsForSite } from "../dist/pack.js";

async function temp(t) {
  const directory = await mkdtemp(join(tmpdir(), "browserkit-pack-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function write(path, value) {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, typeof value === "string" ? value : JSON.stringify(value, null, 2));
}

function unzip(bytes) {
  const entries = unzipSync(bytes);
  return Object.fromEntries(Object.entries(entries).map(([path, data]) => [path, strFromU8(data)]));
}

test("export leaves sessions, cookies and credential-bearing values out of the pack", async (t) => {
  const home = await temp(t);
  const site = join(home, "sites", "shop.example");
  await write(join(site, "model.json"), {
    site: "shop.example",
    operations: [{ name: "search", headers: { authorization: "Bearer live-token" } }],
    session: { cookie: "secret" },
  });
  await write(join(site, "openapi.json"), { openapi: "3.1.0", info: { title: "Shop" } });
  await write(join(site, "client.ts"), "export const token = 'live-token';");
  await write(join(site, "sessions", "shop.json"), { cookies: ["secret"] });
  await write(join(site, "cookies.json"), { value: "secret" });
  await write(join(site, "flows", "checkout.har"), {
    log: {
      entries: [
        {
          request: {
            headers: [
              { name: "Authorization", value: "Bearer live-token" },
              { name: "Accept", value: "application/json" },
            ],
            cookies: [{ name: "sid", value: "secret" }],
            postData: {
              mimeType: "application/json",
              text: JSON.stringify({ email: "me@example.com", password: "hunter2" }),
            },
          },
          response: {
            headers: [{ name: "Set-Cookie", value: "sid=secret" }],
            content: { text: "token=live-token" },
          },
        },
      ],
    },
  });
  process.env.SITE_TO_API_HOME = home;
  const out = join(home, "shop.zip");
  const result = await exportSitePack({
    site: "shop.example",
    out,
    skills: [
      {
        name: "search",
        domains: ["shop.example"],
        description: "Search",
        examples: "",
        code: "const token = 'live-token'; await page.goto('https://shop.example');",
      },
    ],
    boosts: [
      {
        name: "Hide ads",
        sites: ["shop.example"],
        js: "console.log('live-token')",
        values: { token: "live-token" },
      },
    ],
  });
  assert.equal(result.site, "shop.example");
  assert.equal(result.skills.length, 1);
  const entries = unzip(await readFile(out));
  assert.ok(entries["pack.json"]);
  assert.ok(entries["model.json"]);
  assert.ok(entries["openapi.json"]);
  assert.ok(entries["client.ts"]);
  assert.ok(entries["flows/checkout.har"]);
  assert.equal(entries["sessions/shop.json"], undefined);
  assert.equal(entries["cookies.json"], undefined);
  assert.ok(!Object.keys(entries).some((path) => /session|cookie/i.test(path)));

  const model = JSON.parse(entries["model.json"]);
  assert.doesNotMatch(JSON.stringify(model), /secret/);
  assert.equal(model.operations[0].headers.authorization, "<redacted>");
  assert.doesNotMatch(entries["client.ts"], /live-token/);
  const har = JSON.parse(entries["flows/checkout.har"]);
  const request = har.log.entries[0].request;
  assert.equal(request.headers[0].value, "<redacted>");
  assert.equal(request.headers[1].value, "application/json");
  assert.deepEqual(request.cookies, []);
  assert.doesNotMatch(request.postData.text, /hunter2|me@example\.com/);
  assert.equal(har.log.entries[0].response.headers[0].value, "<redacted>");
  assert.doesNotMatch(har.log.entries[0].response.content.text, /live-token/);
  const skill = JSON.parse(entries["skills/search.json"]);
  assert.equal(skill.enabled, true);
  const boost = JSON.parse(entries["boosts/hide-ads.json"]);
  assert.equal(boost.enabled, false);
  assert.equal(boost.values, undefined);
});

test("import writes site files, enables skills, and returns boosts disabled", async (t) => {
  const home = await temp(t);
  process.env.SITE_TO_API_HOME = home;
  const source = join(home, "sites", "shop.example");
  await write(join(source, "model.json"), { site: "shop.example", operations: [] });
  await write(join(source, "openapi.json"), { openapi: "3.1.0" });
  await write(join(source, "sessions", "shop.json"), { cookies: ["secret"] });
  const file = join(home, "shop.zip");
  await exportSitePack({
    site: "shop.example",
    out: file,
    skills: [{ name: "search", domains: ["shop.example"], code: "const x = 1;" }],
    boosts: [{ name: "Clean", sites: ["shop.example"], css: "h1{}" }],
  });
  const target = await temp(t);
  process.env.SITE_TO_API_HOME = target;
  const pack = await readSitePack(file);
  const installed = await installSitePack(pack);
  assert.equal(installed.site, "shop.example");
  assert.ok(installed.written.includes("model.json"));
  assert.ok(!installed.written.some((path) => /session|cookie/i.test(path)));
  assert.equal(pack.skills.length, 1);
  assert.equal(pack.skills[0].enabled, true);
  assert.equal(pack.boosts.length, 1);
  assert.equal(pack.boosts[0].enabled, false);
  const model = JSON.parse(
    await readFile(join(target, "sites", "shop.example", "model.json"), "utf8"),
  );
  assert.equal(model.site, "shop.example");
  assert.deepEqual(
    skillsForSite(pack.skills, "shop.example").map((skill) => skill.name),
    ["search"],
  );
  assert.deepEqual(skillsForSite(pack.skills, "other.example"), []);
});
