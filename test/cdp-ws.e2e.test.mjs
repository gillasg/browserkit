// One targeted real-Chrome check: a raw CDP client opens, evaluates, screenshots and closes an
// agent tab through the local endpoint.
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
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const run = promisify(execFile);

test(
  "the local CDP endpoint drives an agent tab",
  {
    skip:
      !process.env.REQUIRE_E2E &&
      (!existsSync(chromePath) || !existsSync(extension) || !existsSync(cli)),
  },
  async () => {
    const home = await mkdtemp(join(tmpdir(), "bue-cdp-ws-"));
    const env = { ...process.env, BROWSERKIT_HOME: home, SITE_TO_API_HOME: join(home, "s2a") };
    const site = createServer((_request, response) => {
      response.setHeader("content-type", "text/html");
      response.end("<title>CDP page</title><h1>CDP page</h1>");
    });
    await new Promise((done) => site.listen(0, "127.0.0.1", done));
    const url = `http://127.0.0.1:${site.address().port}/`;
    const bridge = spawn(process.execPath, [cli, "serve"], { env, stdio: "ignore" });
    const profile = await mkdtemp(join(tmpdir(), "bue-cdp-ws-chrome-"));
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
      const started = await run(process.execPath, [cli, "cdp", "--port", "0", "--json"], { env });
      const info = JSON.parse(started.stdout);
      assert.equal(info.running, true, started.stdout);
      const denied = await fetch(`${info.url}/json/version`);
      assert.equal(denied.status, 401);

      const client = await cdpClient(info.wsUrl);
      try {
        await client.send("Target.setAutoAttach", {
          autoAttach: true,
          waitForDebuggerOnStart: false,
          flatten: true,
        });
        const created = await client.send("Target.createTarget", { url });
        const targetId = created.targetId;
        const attached = await client.waitEvent("Target.attachedToTarget", 15_000);
        const sessionId = attached.params.sessionId;
        await client.send("Page.enable", {}, sessionId);
        await client.send("Runtime.enable", {}, sessionId);
        await client.send("Page.navigate", { url }, sessionId);
        await sleep(1000);
        const evaluated = await client.send(
          "Runtime.evaluate",
          { expression: "document.title", returnByValue: true },
          sessionId,
        );
        assert.equal(evaluated.result.value, "CDP page");
        const shot = await client.send("Page.captureScreenshot", { format: "png" }, sessionId);
        assert.ok(String(shot.data).length > 100);
        await client.send("Target.closeTarget", { targetId });
      } finally {
        client.close();
      }
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

async function cdpClient(url) {
  const socket = new WebSocket(url);
  await new Promise((done, fail) => {
    socket.once("open", done);
    socket.once("error", fail);
  });
  let id = 0;
  const waiting = new Map();
  const events = [];
  socket.on("message", (raw) => {
    const message = JSON.parse(String(raw));
    if (message.id && waiting.has(message.id)) {
      const waiter = waiting.get(message.id);
      waiting.delete(message.id);
      if (message.error) waiter.fail(new Error(message.error.message));
      else waiter.done(message.result);
      return;
    }
    events.push(message);
  });
  return {
    send(method, params = {}, sessionId) {
      const requestId = ++id;
      return new Promise((done, fail) => {
        waiting.set(requestId, { done, fail });
        socket.send(
          JSON.stringify({ id: requestId, method, params, ...(sessionId ? { sessionId } : {}) }),
        );
      });
    },
    async waitEvent(method, timeoutMs) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const at = events.findIndex((event) => event.method === method);
        if (at >= 0) return events.splice(at, 1)[0];
        await sleep(50);
      }
      throw new Error(`Timed out waiting for ${method}`);
    },
    close() {
      socket.close();
    },
  };
}
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
