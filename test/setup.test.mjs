// Setup on macOS and Linux: native host manifests land where each browser looks, and the
// launcher they point to answers the extension's bootstrap.
import test from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile, constants } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

const cli = resolve("apps/bridge/dist/cli.js");
const run = promisify(execFile);
const HOST = "com.browserkit.bridge";
/** The host name before the rename: setup clears its manifest so Chrome stops looking for it. */
const OLD_HOST = "com.browser_use_extension.bridge";
const folders = {
  darwin: [
    "Library/Application Support/Google/Chrome/NativeMessagingHosts",
    "Library/Application Support/Microsoft Edge/NativeMessagingHosts",
    "Library/Application Support/Chromium/NativeMessagingHosts",
    "Library/Application Support/BraveSoftware/Brave-Browser/NativeMessagingHosts",
    "Library/Application Support/Vivaldi/NativeMessagingHosts",
    "Library/Application Support/com.operasoftware.Opera/NativeMessagingHosts",
    "Library/Application Support/Arc/NativeMessagingHosts",
    "Library/Application Support/net.imput.helium/NativeMessagingHosts",
  ],
  linux: [
    ".config/google-chrome/NativeMessagingHosts",
    ".config/microsoft-edge/NativeMessagingHosts",
    ".config/chromium/NativeMessagingHosts",
    ".config/BraveSoftware/Brave-Browser/NativeMessagingHosts",
    ".config/vivaldi/NativeMessagingHosts",
    ".config/opera/NativeMessagingHosts",
    ".config/Arc/NativeMessagingHosts",
    ".config/net.imput.helium/NativeMessagingHosts",
  ],
};

test(
  "setup registers the native host for every browser and its launcher answers",
  { skip: process.platform === "win32" },
  async () => {
    const home = await mkdtemp(join(tmpdir(), "bue-setup-"));
    const env = { ...process.env, HOME: home, BROWSERKIT_HOME: join(home, "data") };
    try {
      // An install from before the rename leaves its manifest behind.
      const old = join(home, folders[process.platform][0], OLD_HOST + ".json");
      await mkdir(dirname(old), { recursive: true });
      await writeFile(old, "{}");
      const { stdout } = await run(process.execPath, [cli, "setup"], { env });
      assert.match(stdout, /Native host registered/);
      await assert.rejects(() => access(old), "the old registration is removed");
      let launcher;
      for (const folder of folders[process.platform]) {
        const manifest = JSON.parse(await readFile(join(home, folder, HOST + ".json"), "utf8"));
        assert.equal(manifest.name, HOST);
        assert.deepEqual(manifest.allowed_origins, [
          "chrome-extension://dmlgohfphkbenjopdphcojgjeidlmajj/",
        ]);
        launcher = manifest.path;
      }
      await access(launcher, constants.X_OK);
      const reply = await bootstrap(launcher, env);
      assert.equal(reply.ok, true, JSON.stringify(reply));
      assert.match(reply.endpoint, /^ws:\/\/127\.0\.0\.1:\d+\//);
      const state = JSON.parse(await readFile(join(home, "data", "bridge.json"), "utf8"));
      process.kill(state.pid);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  },
);

// Chrome starts the launcher with the extension origin and speaks length-prefixed JSON.
function bootstrap(launcher, env) {
  return new Promise((done, fail) => {
    const host = spawn(launcher, ["chrome-extension://dmlgohfphkbenjopdphcojgjeidlmajj/"], {
      env,
    });
    const chunks = [];
    host.stdout.on("data", (chunk) => chunks.push(chunk));
    host.on("error", fail);
    host.on("close", () => {
      const buffer = Buffer.concat(chunks);
      if (buffer.length < 4) return fail(new Error("No reply from the native host"));
      done(JSON.parse(buffer.subarray(4, 4 + buffer.readUInt32LE(0)).toString("utf8")));
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
    header.writeUInt32LE(body.length);
    host.stdin.end(Buffer.concat([header, body]));
  });
}

import { browsers } from "../apps/bridge/dist/setup.js";
test("the browser manifest table names each new browser and ignores unknown names", () => {
  for (const name of ["vivaldi", "opera", "arc", "helium"]) {
    const entry = browsers[name];
    assert.ok(entry.win && entry.mac && entry.linux, name);
    assert.match(entry.linux, /NativeMessagingHosts$/);
  }
  assert.equal(browsers.unknown, undefined);
  assert.match(browsers.opera.linux, /\/opera\//);
});
