import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BridgeClient } from "../client.js";
import { out } from "../output.js";
import { extensionFolder } from "../setup-extension.js";
import type { Command } from "../usage.js";

// browserkit update: brings a checkout or an npm install up to date and reloads the extension,
// so there is no Web Store to wait for. A checkout pulls (fast-forward only, never over local
// changes) and rebuilds; an npm install downloads the latest release's extension again.

const cli = fileURLToPath(new URL("../cli.js", import.meta.url));
const checkout = resolve(dirname(cli), "..", "..", "..");

async function update(): Promise<number> {
  if (existsSync(join(checkout, ".git"))) {
    const dirty = git(["status", "--porcelain"]).trim();
    if (dirty) {
      out(`Local changes in ${checkout}; commit or stash them, then run update again.`);
      return 1;
    }
    const before = git(["rev-parse", "HEAD"]).trim();
    git(["pull", "--ff-only"]);
    if (git(["rev-parse", "HEAD"]).trim() === before) out("Already up to date.");
    else {
      out("Rebuilding…");
      run("pnpm", ["install"]);
      run("pnpm", ["build"]);
    }
  } else {
    await extensionFolder(out, { fresh: true });
    out("The CLI itself updates with: npx browserkit@latest setup");
  }
  out(
    (await reloadExtension())
      ? "Extension reloaded."
      : "Reload the extension in chrome://extensions.",
  );
  return 0;
}

function git(args: string[]): string {
  return execFileSync("git", args, { cwd: checkout, encoding: "utf8" });
}

function run(command: string, args: string[]): void {
  execFileSync(command, args, {
    cwd: checkout,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
}

/** Asks the connected extension to reload itself; false when none is connected. */
async function reloadExtension(): Promise<boolean> {
  try {
    const bridge = await BridgeClient.connect();
    try {
      if (!(Number((await bridge.request("status")).browsers) > 0)) return false;
      await bridge.request("run", { code: "await browser.reloadExtension()", session: "cli" });
      return true;
    } finally {
      bridge.close();
    }
  } catch {
    return false;
  }
}

export const updateCommand: Command = {
  name: "update",
  group: "Browser",
  summary: "update browserkit and reload the extension",
  help: `Usage: browserkit update

From a checkout: pulls (fast-forward only; refuses with local changes) and rebuilds. From npm:
downloads the latest release's extension again. Then reloads the extension.`,
  run: update,
};
