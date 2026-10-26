// One targeted real-Chrome check: a fixture cookie DB is imported into the browser cookie store,
// listed with the right domain/path/flags, then cleared. The value never prints.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { createServer } from "node:http";
import { lookup } from "node:dns/promises";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
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
  "an imported cookie is written through and can be cleared",
  {
    skip:
      !process.env.REQUIRE_E2E &&
      (!existsSync(chromePath) || !existsSync(extension) || !existsSync(cli)),
  },
  async () => {
    const home = await mkdtemp(join(tmpdir(), "bue-cookie-write-"));
    const fixture = join(home, "fixture");
    await mkdir(fixture, { recursive: true });
    const db = new DatabaseSync(join(fixture, "cookies.sqlite"));
    db.exec(
      "CREATE TABLE moz_cookies (host TEXT, path TEXT, name TEXT, value TEXT, expiry INTEGER, isSecure INTEGER, isHttpOnly INTEGER, sameSite INTEGER)",
    );
    db.prepare("INSERT INTO moz_cookies VALUES (?,?,?,?,?,?,?,?)").run(
      ".example.com",
      "/",
      "sid",
      "secret-value",
      2000000000,
      1,
      1,
      2,
    );
    db.close();
    const env = { ...process.env, BROWSERKIT_HOME: home, SITE_TO_API_HOME: join(home, "s2a") };
    const site = createServer((_request, response) => {
      response.setHeader("content-type", "text/html");
      response.end("<title>Cookies</title>");
    });
    await new Promise((done) => site.listen(0, "127.0.0.1", done));
    const bridge = spawn(process.execPath, [cli, "serve"], { env, stdio: "ignore" });
    const profile = await mkdtemp(join(tmpdir(), "bue-cookie-chrome-"));
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
      const worker = await connectExtension(profile, env);
      await run(
        process.execPath,
        [
          cli,
          "repl",
          "--session",
          "cookie-write",
          `await browser.openTab("http://127.0.0.1:${site.address().port}/")`,
        ],
        { env },
      );
      const imported = await run(
        process.execPath,
        [
          cli,
          "cookies",
          "import",
          "--from",
          "firefox",
          "--profile",
          join(fixture, "cookies.sqlite"),
          "--domain",
          "example.com",
          "--domain",
          "example.org",
          "--json",
        ],
        { env },
      );
      const counts = JSON.parse(imported.stdout);
      assert.equal(counts.imported, 1, imported.stdout);
      const listed = JSON.parse(
        (
          await run(
            process.execPath,
            [cli, "cookies", "list", "--domain", "example.com", "--json"],
            {
              env,
            },
          )
        ).stdout,
      );
      const cookie = listed.cookies.find((item) => item.name === "sid");
      assert.ok(cookie, JSON.stringify(listed));
      assert.equal(cookie.domain, ".example.com");
      assert.equal(cookie.path, "/");
      assert.equal(cookie.secure, true);
      assert.equal(cookie.httpOnly, true);
      assert.equal(cookie.value, undefined);
      const cleared = JSON.parse(
        (
          await run(
            process.execPath,
            [cli, "cookies", "clear", "--domain", "example.com", "--json"],
            {
              env,
            },
          )
        ).stdout,
      );
      assert.ok(cleared.cleared >= 1, JSON.stringify(cleared));
      const empty = JSON.parse(
        (
          await run(
            process.execPath,
            [cli, "cookies", "list", "--domain", "example.com", "--json"],
            {
              env,
            },
          )
        ).stdout,
      );
      assert.equal(empty.count, 0, JSON.stringify(empty));
      const nip = `127.0.0.1.nip.io:${site.address().port}`;
      let resolves = true;
      try {
        await lookup(nip.split(":")[0]);
      } catch {
        resolves = false;
      }
      if (resolves) {
        await setPrivateNetwork(worker, true);
        const blocked = await run(
          process.execPath,
          [
            cli,
            "repl",
            "--session",
            "cookie-write",
            `try { await browser.fetch("http://${nip}/"); console.log("RESULT ALLOWED") } catch (error) { console.log("RESULT BLOCKED " + error.message) }`,
          ],
          { env },
        );
        assert.match(blocked.stdout, /BLOCKED .*PRIVATE_NETWORK/i, blocked.stdout + blocked.stderr);
        await setPrivateNetwork(worker, false);
        const allowed = await run(
          process.execPath,
          [
            cli,
            "repl",
            "--session",
            "cookie-write",
            `console.log("RESULT " + (await browser.fetch("http://${nip}/")).status)`,
          ],
          { env },
        );
        assert.match(allowed.stdout, /200/, allowed.stdout + allowed.stderr);
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

async function setPrivateNetwork(cdp, enabled) {
  await cdp("Runtime.evaluate", {
    expression: `chrome.storage.local.set({"private-network": ${enabled}})`,
    awaitPromise: true,
  });
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
