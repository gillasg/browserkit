import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { resolve } from "node:path";
import test from "node:test";
import {
  installSitePack,
  listSiteTools,
  readPageTool,
  readSiteTools,
  runSiteTool,
  setSiteToolsEnabled,
  writeSiteTools,
} from "../dist/index.js";

const home = await mkdtemp(join(tmpdir(), "bue-site-tools-"));
process.env.SITE_TO_API_HOME = home;
const site = "tools.example";
test.after(() => rm(home, { recursive: true, force: true }));

function toolFile(enabled = true) {
  return {
    version: 1,
    tools: [
      {
        version: 1,
        name: "sum",
        description: "add two numbers",
        params: [
          { name: "a", type: "number", required: true },
          { name: "b", type: "number", default: 2 },
        ],
        code: "return args.a + args.b;",
        enabled,
        updatedAt: new Date().toISOString(),
      },
    ],
    pageTools: [
      {
        version: 1,
        name: "title",
        description: "the page title",
        params: [],
        code: "return document.title;",
        enabled,
        updatedAt: new Date().toISOString(),
      },
    ],
  };
}

test("a saved Node tool runs with defaults and host calls", async () => {
  await writeSiteTools(site, toolFile());
  const called = [];
  const value = await runSiteTool(
    site,
    "sum",
    { a: 3, b: 4 },
    {
      call: async (operation, params) => {
        called.push({ operation, params });
        return { ok: true };
      },
    },
  );
  assert.equal(value, 7);
  assert.deepEqual(await listSiteTools(site), {
    tools: [
      {
        name: "sum",
        description: "add two numbers",
        params: [
          { name: "a", type: "number", required: true },
          { name: "b", type: "number", default: 2 },
        ],
        enabled: true,
      },
    ],
    pageTools: [{ name: "title", description: "the page title", params: [], enabled: true }],
  });
  assert.deepEqual(await readPageTool(site, "title"), {
    code: "return document.title;",
    params: [],
  });
  assert.deepEqual(called, []);
});

test("validation, unknown and disabled tools fail clearly", async () => {
  const invalid = toolFile();
  invalid.tools[0].name = "bad name!";
  await assert.rejects(() => writeSiteTools(site, invalid), /SITE_TOOL_INVALID/);
  await assert.rejects(() => runSiteTool(site, "missing", {}), /SITE_TOOL_UNKNOWN/);
  await setSiteToolsEnabled(site, "all", undefined, false);
  await assert.rejects(() => runSiteTool(site, "sum", { a: 1 }), /SITE_TOOL_DISABLED/);
  await assert.rejects(() => readPageTool(site, "title"), /SITE_TOOL_DISABLED/);
});

test("a bad file is ignored instead of breaking the site", async () => {
  const dir = join(home, "sites", site);
  await writeSiteTools(site, toolFile());
  const { writeFile } = await import("node:fs/promises");
  await writeFile(join(dir, "tools.json"), "{not json");
  assert.deepEqual(await readSiteTools(site), { version: 1, tools: [], pageTools: [] });
});

test("imported tools are written disabled", async () => {
  const pack = {
    manifest: {
      format: "browserkit-site-pack",
      version: 1,
      site,
      exportedAt: new Date().toISOString(),
      files: ["tools.json"],
      skills: [],
      boosts: [],
    },
    files: new Map([["tools.json", JSON.stringify(toolFile(true))]]),
    skills: [],
    boosts: [],
  };
  const imported = await installSitePack(pack, site);
  assert.ok(imported.written.includes("tools.json"));
  const file = await readSiteTools(site);
  assert.equal(file.tools[0].enabled, false);
  assert.equal(file.pageTools[0].enabled, false);
});

test("the registry stays under the configured home", () => {
  assert.ok(home.startsWith(resolve(tmpdir()) + sep));
});
