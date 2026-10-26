// The command line: its help and argument parsing, and two real calls — a mapped site operation
// straight from Node, and a page read over plain HTTP.
import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { parseArgs } from "../apps/bridge/dist/args.js";
import { buildSiteModel, parseCapture, saveModel } from "../packages/site-mapper/dist/index.js";

const run = promisify(execFile);
const cli = resolve("apps/bridge/dist/cli.js");

async function browserkit(home, args, options = {}) {
  try {
    const { stdout, stderr } = await run(process.execPath, [cli, ...args], {
      env: {
        ...process.env,
        BROWSERKIT_HOME: home,
        SITE_TO_API_HOME: join(home, "site-to-api"),
        BROWSER_CRAWL_HOME: join(home, "crawl"),
      },
      ...options,
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    return { code: error.code, stdout: error.stdout ?? "", stderr: error.stderr ?? "" };
  }
}

/** A HAR with one XHR that answers JSON: the smallest thing a site's API can be built from. */
function itemsHar(origin) {
  return JSON.stringify({
    log: {
      version: "1.2",
      creator: { name: "browserkit-test", version: "1" },
      entries: [
        {
          startedDateTime: new Date().toISOString(),
          _resourceType: "xhr",
          request: {
            method: "GET",
            url: `${origin}/api/items?q=lamp`,
            headers: [{ name: "accept", value: "application/json" }],
          },
          response: {
            status: 200,
            headers: [{ name: "content-type", value: "application/json" }],
            content: {
              mimeType: "application/json",
              text: JSON.stringify({ items: [{ id: 1, name: "lamp", price: 40 }] }),
            },
          },
        },
        {
          startedDateTime: new Date().toISOString(),
          _resourceType: "xhr",
          request: {
            method: "GET",
            url: `${origin}/api/items/7`,
            headers: [{ name: "accept", value: "application/json" }],
          },
          response: {
            status: 200,
            headers: [{ name: "content-type", value: "application/json" }],
            content: {
              mimeType: "application/json",
              text: JSON.stringify({ id: 7, name: "shade", price: 20 }),
            },
          },
        },
      ],
    },
  });
}

function startSite() {
  const server = createServer((request, response) => {
    if (request.url?.startsWith("/api/items")) {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ items: [{ id: 1, name: "lamp", price: 40 }] }));
      return;
    }
    response.setHeader("content-type", "text/html");
    response.end("<title>Shop</title><h1>Shop</h1><p>Lamps and shades.</p>");
  });
  return new Promise((done) =>
    server.listen(0, "127.0.0.1", () =>
      done({ server, origin: `http://127.0.0.1:${server.address().port}` }),
    ),
  );
}

test("arguments: flags keep their values, and boolean flags do not swallow a URL", () => {
  const args = parseArgs([
    "call",
    "shop.example",
    "searchProducts",
    '{"q":"lamp"}',
    "--json",
    "https://example.com",
    "--param",
    "page=2",
    "--limit",
    "5",
  ]);
  assert.deepEqual(args.positional, [
    "call",
    "shop.example",
    "searchProducts",
    '{"q":"lamp"}',
    "https://example.com",
  ]);
  assert.equal(args.flags.json, true);
  assert.equal(args.flags.limit, "5");
  assert.equal(args.flags["param.page"], "2");
  assert.equal(parseArgs(["--depth=3"]).flags.depth, "3");
});

test("help lists every command, and each command has its own help", async () => {
  const home = await mkdtemp(join(tmpdir(), "browserkit-cli-"));
  try {
    const usage = await browserkit(home, ["--help"]);
    assert.equal(usage.code, 0, usage.stderr);
    for (const command of [
      "setup",
      "repl",
      "mcp",
      "crawl",
      "scrape",
      "sync",
      "map",
      "build",
      "ops",
      "call",
      "watch",
      "heal",
      "federate",
      "boosts",
      "rest",
      "session",
      "signin",
      "block",
      "unblock",
      "blocked",
    ])
      assert.match(usage.stdout, new RegExp(`\\b${command}\\b`), `${command} in the help`);

    const single = await browserkit(home, ["call", "--help"]);
    assert.equal(single.code, 0);
    assert.match(single.stdout, /Usage: browserkit call/);

    const unknown = await browserkit(home, ["nonsense"]);
    assert.equal(unknown.code, 1);
    assert.match(unknown.stdout, /browserkit <command>/);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("blocked sites are their own command, apart from mapped sites", async () => {
  const home = await mkdtemp(join(tmpdir(), "browserkit-block-"));
  try {
    const empty = await browserkit(home, ["blocked", "--json"]);
    assert.equal(empty.code, 0, empty.stderr);
    assert.deepEqual(JSON.parse(empty.stdout), { blocked: [] });

    const blocked = await browserkit(home, ["block", "https://www.bank.example/login"]);
    assert.equal(blocked.code, 0, blocked.stderr);
    assert.match(blocked.stdout, /Blocked bank\.example/);
    assert.deepEqual(JSON.parse((await browserkit(home, ["blocked", "--json"])).stdout), {
      blocked: ["bank.example"],
    });

    const unblocked = await browserkit(home, ["unblock", "bank.example"]);
    assert.equal(unblocked.code, 0, unblocked.stderr);
    assert.match(unblocked.stdout, /Unblocked bank\.example/);
    assert.deepEqual(JSON.parse((await browserkit(home, ["blocked", "--json"])).stdout), {
      blocked: [],
    });

    // `sites` is mapped sites only: a site named "block" is not an action.
    const listed = await browserkit(home, ["sites", "--json"]);
    assert.equal(listed.code, 0, listed.stderr);
    assert.ok(Array.isArray(JSON.parse(listed.stdout)));
    const usage = await browserkit(home, ["sites", "--help"]);
    assert.doesNotMatch(usage.stdout, /sites block </);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("a mapped site is callable, and its operations list what they are for", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "browserkit-call-"));
  const site = await startSite();
  t.after(async () => {
    site.server.close();
    await rm(home, { recursive: true, force: true });
  });
  process.env.SITE_TO_API_HOME = join(home, "site-to-api");
  t.after(() => delete process.env.SITE_TO_API_HOME);

  const name = "127.0.0.1";
  const { model } = await buildSiteModel(parseCapture(itemsHar(site.origin), "flow"), {
    site: name,
  });
  await saveModel(model);
  const operation = model.operations.find((item) => item.path.startsWith("/api/items"));
  assert.ok(operation, model.operations.map((item) => item.path).join(", "));

  const called = await browserkit(home, [
    "call",
    name,
    operation.id,
    '{"q":"lamp"}',
    "--transport",
    "direct",
  ]);
  assert.equal(called.code, 0, called.stderr);
  assert.deepEqual(JSON.parse(called.stdout).items[0].name, "lamp");

  const ops = await browserkit(home, ["ops", name, "--json"]);
  assert.equal(ops.code, 0, ops.stderr);
  const listed = JSON.parse(ops.stdout).operations.find((item) => item.id === operation.id);
  assert.ok(Array.isArray(listed.capabilities), JSON.stringify(listed));
  assert.ok(Array.isArray(listed.volatile), JSON.stringify(listed));

  const sites = await browserkit(home, ["sites", "--json"]);
  assert.equal(sites.code, 0, sites.stderr);
  assert.equal(JSON.parse(sites.stdout)[0].site, name);

  // A path input nothing produces cannot be filled in: that is exit code 2, not a generic failure.
  const detail = model.operations.find((item) => item.path.includes("{"));
  if (detail) {
    const missing = await browserkit(home, ["call", name, detail.id, "--transport", "direct"]);
    assert.equal(missing.code, 2, missing.stderr);
    assert.match(missing.stderr, /needs:/);
  }
});

test("crawl reads a page over plain HTTP", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "browserkit-crawl-"));
  const site = await startSite();
  t.after(async () => {
    site.server.close();
    await rm(home, { recursive: true, force: true });
  });
  const result = await browserkit(home, [
    "crawl",
    "scrape",
    site.origin,
    "--formats",
    "text",
    "--render",
    "static",
    "--json",
  ]);
  assert.equal(result.code, 0, result.stderr);
  const page = JSON.parse(result.stdout);
  assert.equal(page.status, 200);
  assert.match(page.text, /Lamps and shades/);

  const scraped = await browserkit(home, [
    "scrape",
    site.origin,
    "--formats",
    "markdown",
    "--render",
    "static",
    "--json",
  ]);
  assert.equal(scraped.code, 0, scraped.stderr);
  assert.match(JSON.parse(scraped.stdout).markdown, /# Shop/);
});

test("a missing operation input is reported with its exit code", async () => {
  const home = await mkdtemp(join(tmpdir(), "browserkit-missing-"));
  try {
    await writeFile(join(home, "README.txt"), "not a site");
    const result = await browserkit(home, ["call", "nope.example", "listThings"]);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /not mapped/);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

// Cookies accept one comma-separated domain list or repeated --domain flags.
test("repeated --domain flags are one list", () => {
  assert.equal(
    parseArgs(["import", "--domain", "a.com", "--domain", "b.com"]).flags.domain,
    "a.com,b.com",
  );
  assert.equal(parseArgs(["import", "--domain=a.com,b.com"]).flags.domain, "a.com,b.com");
});
