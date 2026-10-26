// One targeted real-Chrome check: /view streams a frame, a viewer click lands, closing one of two
// clients leaves the other streaming, and flight still saves a non-trivial WebM afterwards.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
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
  "the viewer streams frames, sends a click, and leaves flight recording intact",
  {
    skip:
      !process.env.REQUIRE_E2E &&
      (!existsSync(chromePath) || !existsSync(extension) || !existsSync(cli)),
  },
  async () => {
    const home = await mkdtemp(join(tmpdir(), "bue-view-"));
    const env = { ...process.env, BROWSERKIT_HOME: home, SITE_TO_API_HOME: join(home, "s2a") };
    const site = createServer((_request, response) => {
      response.setHeader("content-type", "text/html");
      response.end(
        `<title>Viewer</title><h2 id="tick">0</h2><button style="position:fixed;left:0;top:0;width:200px;height:200px" onclick="document.title='viewer-clicked'">Click</button><script>let n=0;setInterval(()=>{n++;document.getElementById('tick').textContent=String(n)},150)</script>`,
      );
    });
    await new Promise((done) => site.listen(0, "127.0.0.1", done));
    const url = `http://127.0.0.1:${site.address().port}/`;
    const bridge = spawn(process.execPath, [cli, "serve"], { env, stdio: "ignore" });
    const profile = await mkdtemp(join(tmpdir(), "bue-view-chrome-"));
    let chrome;
    const sockets = [];
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
      const opened = await run(
        process.execPath,
        [
          cli,
          "repl",
          "--session",
          "viewer",
          `page = await browser.openTab(${JSON.stringify(url)}, {foreground:true});
           const tabs = await browser.tabs();
           console.log("TAB " + tabs.find((tab) => tab.url.startsWith("http://127.0.0.1:")).target.tabId);`,
        ],
        { env },
      );
      const tabId = Number(/TAB (\d+)/.exec(opened.stdout)?.[1]);
      assert.ok(tabId, opened.stdout + opened.stderr);
      const started = JSON.parse(
        (await run(process.execPath, [cli, "view", "--tab", String(tabId), "--json"], { env }))
          .stdout,
      );
      assert.equal(started.running, true, JSON.stringify(started));
      const token = new URL(started.url).searchParams.get("token");
      const wsUrl = started.url
        .replace("http://", "ws://")
        .replace("/view?token=", "/view/ws?token=");
      const first = await connectViewer(wsUrl);
      const second = await connectViewer(wsUrl);
      sockets.push(first.socket, second.socket);
      assert.ok(await first.nextFrame(), "first client received no frame");
      assert.ok(await second.nextFrame(), "second client received no frame");
      first.socket.close();
      assert.ok(await second.nextFrame(), "remaining client stopped after the other closed");
      second.socket.send(JSON.stringify({ action: "click", x: 80, y: 80 }));
      await sleep(500);
      const clicked = await run(
        process.execPath,
        [
          cli,
          "repl",
          "--session",
          "viewer",
          `const tab = await browser.tab(${tabId}); console.log("TITLE " + (await tab.title()))`,
        ],
        { env },
      );
      assert.match(clicked.stdout, /viewer-clicked/, clicked.stdout + clicked.stderr);
      const saved = await run(
        process.execPath,
        [
          cli,
          "repl",
          "--session",
          "viewer",
          "const tab = await browser.tab(" +
            tabId +
            '); await tab.waitForTimeout(2600); const saved = await tab.flight.save(); console.log("FLIGHT " + JSON.stringify(saved));',
        ],
        { env },
      );
      const flight = JSON.parse(/FLIGHT (\{.*)/.exec(saved.stdout)?.[1] ?? "{}");
      assert.ok(flight.path, saved.stdout + saved.stderr);
      const info = await stat(flight.path);
      assert.ok(info.size > 1000, `WebM was ${info.size} bytes: ${JSON.stringify(flight)}`);
      assert.ok(Number(flight.frames) >= 2, JSON.stringify(flight));
      assert.ok(token, started.url);
    } finally {
      for (const socket of sockets) socket.close();
      await run(process.execPath, [cli, "view", "--stop", "--json"], { env }).catch(() => {});
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
  120000,
);

function connectViewer(url) {
  const socket = new WebSocket(url);
  const frames = [];
  const waiters = [];
  socket.on("message", (raw) => {
    const message = JSON.parse(String(raw));
    if (message.kind !== "frame") return;
    frames.push(message);
    waiters.shift()?.(message);
  });
  const opened = new Promise((done, fail) => {
    socket.once("open", done);
    socket.once("error", fail);
  });
  return {
    socket,
    async nextFrame(timeout = 8000) {
      await opened;
      if (frames.length) return frames.shift();
      return new Promise((done) => {
        const timer = setTimeout(() => done(undefined), timeout);
        waiters.push((message) => {
          clearTimeout(timer);
          done(message);
        });
      });
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

function nativeBootstrap(env) {
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
  return async (method, params = {}) => {
    await opened;
    const callId = ++id;
    socket.send(JSON.stringify({ id: callId, method, params }));
    return new Promise((done) => waiting.set(callId, done));
  };
}
