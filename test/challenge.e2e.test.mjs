// One targeted real-Chrome check: a checkbox challenge is solved without touching a decoy box,
// and a numbered grid clicks only the requested tiles.
// Run alone: node --test test/challenge.e2e.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import WebSocket from "ws";
import { dataRoutes } from "./data-site.mjs";

const chromePath =
  process.env.CHROME_PATH ??
  resolve("../aeon-browser/.slice0-audit/chrome-for-testing-154.0.8037.57/chrome-win64/chrome.exe");
const extension = resolve("apps/extension/build");
const cli = resolve("apps/bridge/dist/cli.js");
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const run = promisify(execFile);

test(
  "challenges solve a checkbox without a decoy and a grid with selected tiles",
  {
    skip:
      !process.env.REQUIRE_E2E &&
      (!existsSync(chromePath) || !existsSync(extension) || !existsSync(cli)),
  },
  async () => {
    const home = await mkdtemp(join(tmpdir(), "bue-frame-"));
    const env = { ...process.env, BROWSERKIT_HOME: home, SITE_TO_API_HOME: join(home, "s2a") };
    const site = createServer((request, response) => {
      if (!dataRoutes(request, response)) {
        response.statusCode = 404;
        response.end("not found");
      }
    });
    await new Promise((done) => site.listen(0, "127.0.0.1", done));
    const siteUrl = `http://127.0.0.1:${site.address().port}/`;
    const bridge = spawn(process.execPath, [cli, "serve"], { env, stdio: "ignore" });
    const profile = await mkdtemp(join(tmpdir(), "bue-frame-chrome-"));
    let chrome;
    try {
      await waitFor(async () => JSON.parse(await readFile(join(home, "bridge.json"), "utf8")));
      chrome = spawn(
        chromePath,
        [
          `--user-data-dir=${profile}`,
          "--remote-debugging-port=0",
          `--load-extension=${extension}`,
          `--disable-extensions-except=${extension}`,
          "--no-first-run",
          "--no-default-browser-check",
          "--headless=new",
          ...(process.platform === "linux" && process.env.CI ? ["--no-sandbox"] : []),
          "about:blank",
        ],
        { stdio: "ignore" },
      );
      await connectExtension(profile, env);
      const cell = (code, extra = []) =>
        run(process.execPath, [cli, "repl", "--session", "challenge", ...extra, code], { env });
      const solved = await cell(
        `page = await browser.openTab(${JSON.stringify(siteUrl + "challenge")});
         const found = await page.challenges();
         const solved = await page.challenges.solve({stage: "checkbox"});
         console.log("CHALLENGE " + JSON.stringify({found, solved}));`,
        ["--challenge-assist"],
      );
      const result = JSON.parse(/CHALLENGE (.*)/.exec(solved.stdout)[1]);
      assert.equal(result.found[0].kind, "captcha", solved.stdout);
      assert.equal(result.solved.stage, "checkbox");
      assert.equal(result.solved.cleared, true, solved.stdout);
      assert.ok(!result.decoy, solved.stdout);
      assert.match(result.solved.action, /checkbox clicked/);
      assert.doesNotMatch(solved.stdout, /base64|data:image/);
      const grid = await cell(
        `page = await browser.openTab(${JSON.stringify(siteUrl + "challenge-grid")});
         const first = await page.challenges.solve({stage: "grid"});
         const second = await page.challenges.solve({stage: "grid", tiles: [3, 7]});
         const clicked = await page.evaluate(() => window.__tilesClicked || []);
         console.log("GRID " + JSON.stringify({first, second, clicked}));`,
        ["--challenge-assist"],
      );
      const gridResult = JSON.parse(/GRID (.*)/.exec(grid.stdout)[1]);
      assert.equal(gridResult.first.needsVision, true, grid.stdout);
      assert.deepEqual(gridResult.clicked, [3, 7], grid.stdout);
      assert.equal(gridResult.second.cleared, true, grid.stdout);
      const web = await cell(
        `page = await browser.openTab(${JSON.stringify(siteUrl + "webmcp")});
         const listed = await page.webmcp.list();
         const called = await page.webmcp.call("echo", {x: 1});
         const plain = await browser.openTab(${JSON.stringify(siteUrl + "deals")});
         const empty = await plain.webmcp.list();
         console.log("WEBMCP " + JSON.stringify({listed, called, empty}));`,
        ["--challenge-assist"],
      );
      const webResult = JSON.parse(/WEBMCP (.*)/.exec(web.stdout)[1]);
      assert.equal(webResult.listed.tools[0].name, "echo", web.stdout);
      assert.deepEqual(webResult.called.result, { x: 1 }, web.stdout);
      assert.equal(webResult.empty.available, false, web.stdout);
      const agents = await cell(
        `page = await browser.openTab(${JSON.stringify(siteUrl + "deals")});
         const state = await bu.state();
         console.log("AGENTS " + JSON.stringify({has: /agent manifest: 3 actions/.test(state)}));`,
      );
      assert.equal(JSON.parse(/AGENTS (.*)/.exec(agents.stdout)[1]).has, true, agents.stdout);
      const denied = await cell(`page.challenges.solve({stage: "checkbox"})`).catch(
        (error) => error,
      );
      const deniedOutput = String(denied.stdout ?? "") + String(denied.stderr ?? "");
      assert.match(deniedOutput, /CHALLENGE_ASSIST_NOT_ALLOWED/);
    } finally {
      chrome?.kill();
      bridge.kill();
      site.close();
      await sleep(300);
      await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(
        () => {},
      );
      await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(
        () => {},
      );
    }
  },
);

async function connectExtension(profile, env) {
  const port = await waitFor(async () =>
    Number((await readFile(join(profile, "DevToolsActivePort"), "utf8")).split("\n")[0]),
  );
  const worker = await waitFor(async () => {
    const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json());
    const found = targets.find((item) => item.url.endsWith("/service-worker.js"));
    if (!found) throw new Error("no worker yet");
    return found;
  });
  const reply = await nativeBootstrap(env);
  const cdp = await connect(worker.webSocketDebuggerUrl);
  await waitFor(async () => {
    const ready = await cdp("Runtime.evaluate", {
      expression: "typeof chrome?.runtime?.id",
      returnByValue: true,
    });
    if (ready.result?.result?.value !== "string") throw new Error("worker not ready");
  });
  await cdp("Runtime.evaluate", {
    expression: `chrome.runtime.sendNativeMessage = (_host, request, callback) => callback(${JSON.stringify(reply)});`,
  });
  const version = await fetch(`http://127.0.0.1:${port}/json/version`).then((r) => r.json());
  const browser = await connect(version.webSocketDebuggerUrl);
  await browser("Target.createTarget", { url: "about:blank" });
  await waitFor(async () => {
    const { stdout } = await run(process.execPath, [cli, "status"], { env });
    if (!/1 browser/.test(stdout)) throw new Error(stdout);
  }, 30000);
  return cdp;
}

function nativeBootstrap(env, message) {
  return new Promise((resolveReply, reject) => {
    const host = spawn(
      process.execPath,
      [cli, "chrome-extension://dmlgohfphkbenjopdphcojgjeidlmajj/"],
      {
        env,
      },
    );
    const chunks = [];
    host.stdout.on("data", (chunk) => chunks.push(chunk));
    host.on("error", reject);
    host.on("close", () => {
      const buffer = Buffer.concat(chunks);
      resolveReply(JSON.parse(buffer.subarray(4, 4 + buffer.readUInt32LE(0)).toString("utf8")));
    });
    const body = Buffer.from(
      JSON.stringify(
        message ?? {
          kind: "native.bootstrap",
          protocolVersion: { major: 1, minor: 6 },
          clientInstanceId: "091b9308-1ee9-420e-b71f-a564a5a27701",
          browserRunId: "3ee7ba6e-5aad-4692-9e4e-fb4cff0964f8",
        },
      ),
    );
    const header = Buffer.alloc(4);
    header.writeUInt32LE(body.length, 0);
    host.stdin.end(Buffer.concat([header, body]));
  });
}

async function waitFor(check, timeout = 15000) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    try {
      return await check();
    } catch (error) {
      last = error;
      await sleep(150);
    }
  }
  throw last ?? new Error("timed out");
}

function connect(url) {
  const socket = new WebSocket(url);
  let id = 0;
  const waiting = new Map();
  socket.on("message", (raw) => {
    const message = JSON.parse(String(raw));
    waiting.get(message.id)?.(message);
    waiting.delete(message.id);
  });
  const opened = new Promise((done) => socket.once("open", done));
  return async (method, params = {}) => {
    await opened;
    return new Promise((done) => {
      waiting.set(++id, done);
      socket.send(JSON.stringify({ id, method, params }));
    });
  };
}
