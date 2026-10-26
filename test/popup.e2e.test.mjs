// One targeted real-Chrome check: the toolbar popup's shared toggle sets the badge and makes
// browser.tabs({shared:true}) return exactly the chosen tab.
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

const chromePath =
  process.env.CHROME_PATH ??
  resolve("../aeon-browser/.slice0-audit/chrome-for-testing-154.0.8037.57/chrome-win64/chrome.exe");
const extension = resolve("apps/extension/build");
const cli = resolve("apps/bridge/dist/cli.js");
const extensionId = "dmlgohfphkbenjopdphcojgjeidlmajj";
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const run = promisify(execFile);

test(
  "the popup toggle shares exactly one tab and sets the badge",
  {
    skip:
      !process.env.REQUIRE_E2E &&
      (!existsSync(chromePath) || !existsSync(extension) || !existsSync(cli)),
  },
  async () => {
    const home = await mkdtemp(join(tmpdir(), "bue-popup-"));
    const env = { ...process.env, BROWSERKIT_HOME: home, SITE_TO_API_HOME: join(home, "s2a") };
    const site = createServer((_request, response) => {
      response.setHeader("content-type", "text/html");
      response.end("<title>Share me</title><h1>Share me</h1>");
    });
    await new Promise((done) => site.listen(0, "127.0.0.1", done));
    const url = `http://127.0.0.1:${site.address().port}/`;
    const bridge = spawn(process.execPath, [cli, "serve"], { env, stdio: "ignore" });
    const profile = await mkdtemp(join(tmpdir(), "bue-popup-chrome-"));
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
      const { worker, browser } = await connectExtension(profile, env);
      const opened = await run(
        process.execPath,
        [
          cli,
          "repl",
          "--session",
          "popup",
          `page = await browser.openTab(${JSON.stringify(url)});
           const tabs = await browser.tabs();
           console.log("TAB " + tabs.find((tab) => tab.url.startsWith("http://127.0.0.1:")).target.tabId);`,
        ],
        { env },
      );
      const tabId = Number(/TAB (\d+)/.exec(opened.stdout)?.[1]);
      assert.ok(tabId, opened.stdout + opened.stderr);
      const popup = await browser("Target.createTarget", {
        url: `chrome-extension://${extensionId}/popup.html?tab=${tabId}`,
      });
      const popupId = popup.result?.targetId;
      assert.ok(popupId, JSON.stringify(popup));
      const popupSession = await browser("Target.attachToTarget", {
        targetId: popupId,
        flatten: true,
      });
      const sessionId = popupSession.result?.sessionId;
      await waitFor(async () => {
        const ready = await evaluate(
          browser,
          "document.getElementById('share')?.disabled === false",
          sessionId,
        );
        if (ready !== true) throw new Error("popup not ready");
      });
      await evaluate(browser, "document.getElementById('share').click()", sessionId);
      await waitFor(async () => {
        const badge = await evaluate(worker, `chrome.action.getBadgeText({tabId:${tabId}})`);
        if (badge !== "ON") throw new Error("badge is " + badge);
      });
      const shared = await run(
        process.execPath,
        [
          cli,
          "repl",
          "--session",
          "popup",
          `const tabs = await browser.tabs({shared:true});
           console.log("SHARED " + JSON.stringify(tabs.map((tab) => tab.target.tabId)));`,
        ],
        { env },
      );
      assert.match(
        shared.stdout,
        new RegExp(`SHARED \\[${tabId}\\]`),
        shared.stdout + shared.stderr,
      );
      await evaluate(browser, "document.getElementById('share').click()", sessionId);
      await waitFor(async () => {
        const badge = await evaluate(worker, `chrome.action.getBadgeText({tabId:${tabId}})`);
        if (badge !== "") throw new Error("badge is " + badge);
      });
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

async function evaluate(cdp, expression, sessionId) {
  const reply = await cdp(
    "Runtime.evaluate",
    { expression, returnByValue: true, awaitPromise: true },
    sessionId,
  );
  return reply.result?.result?.value;
}

async function connectExtension(profile, env) {
  const port = await waitFor(async () =>
    Number((await readFile(join(profile, "DevToolsActivePort"), "utf8")).split("\n")[0]),
  );
  const target = await waitFor(async () => {
    const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json());
    const found = targets.find((item) => item.url.endsWith("/service-worker.js"));
    if (!found) throw new Error("no worker yet");
    return found;
  });
  const reply = await nativeBootstrap(env);
  const worker = await connect(target.webSocketDebuggerUrl);
  await waitFor(async () => {
    const ready = await evaluate(worker, "typeof chrome?.runtime?.id");
    if (ready !== "string") throw new Error("worker not ready");
  });
  await worker("Runtime.evaluate", {
    expression: `chrome.runtime.sendNativeMessage = (_host, request, callback) => callback(${JSON.stringify(reply)});`,
  });
  const version = await fetch(`http://127.0.0.1:${port}/json/version`).then((r) => r.json());
  const browser = await connect(version.webSocketDebuggerUrl);
  await browser("Target.createTarget", { url: "about:blank" });
  await waitFor(async () => {
    const { stdout } = await run(process.execPath, [cli, "status"], { env });
    if (!/1 browser/.test(stdout)) throw new Error(stdout);
  }, 30000);
  return { worker, browser };
}

function nativeBootstrap(env) {
  return new Promise((resolveReply, reject) => {
    const host = spawn(process.execPath, [cli, `chrome-extension://${extensionId}/`], { env });
    const chunks = [];
    host.stdout.on("data", (chunk) => chunks.push(chunk));
    host.on("error", reject);
    host.on("close", () => {
      const buffer = Buffer.concat(chunks);
      resolveReply(JSON.parse(buffer.subarray(4, 4 + buffer.readUInt32LE(0)).toString("utf8")));
    });
    const body = Buffer.from(
      JSON.stringify({
        kind: "native.bootstrap",
        protocolVersion: { major: 1, minor: 6 },
        clientInstanceId: "091b9308-1ee9-420e-b71f-a564a5a27701",
        browserRunId: "3ee7ba6e-5aad-4692-9e4e-fb4cff0964f8",
      }),
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
  return async (method, params = {}, sessionId) => {
    await opened;
    const callId = ++id;
    socket.send(
      JSON.stringify({ id: callId, method, params, ...(sessionId ? { sessionId } : {}) }),
    );
    return new Promise((done) => waiting.set(callId, done));
  };
}
