import { spawnSync } from "node:child_process";
import { access, readdir } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BridgeClient } from "./client.js";
import { NATIVE_HOST, dataDirectory, statePath } from "./paths.js";

type Check = { status: "ok" | "warn" | "fail"; label: string; message: string };

const extensionBuild = fileURLToPath(new URL("../../extension/build", import.meta.url));

// Read-only install and runtime diagnostics. It says which piece is missing instead of making
// the user guess, and never prints the bridge token.
export async function runDoctor(): Promise<number> {
  const checks: Check[] = [];
  const exists = async (path: string): Promise<boolean> => {
    try {
      await access(path);
      return true;
    } catch {
      return false;
    }
  };
  const check = (status: Check["status"], label: string, message: string): void => {
    checks.push({ status, label, message });
  };

  const data = dataDirectory();
  check(
    (await exists(data)) ? "ok" : "warn",
    "data directory",
    (await exists(data)) ? data : `${data} (created on first use)`,
  );
  const manifest = join(data, "native-host", NATIVE_HOST + ".json");
  check(
    (await exists(manifest)) ? "ok" : "fail",
    "native host manifest",
    (await exists(manifest)) ? manifest : "missing; run `browserkit setup`",
  );
  check(
    (await exists(extensionBuild)) ? "ok" : "warn",
    "extension build",
    (await exists(extensionBuild)) ? extensionBuild : "missing; run the extension build",
  );
  // A half-written dist file makes every command fail with a syntax error, so catch it here.
  const dist = dirname(fileURLToPath(new URL("./cli.js", import.meta.url)));
  const broken = await checkDistSyntax(dist, exists);
  check(
    broken.length ? "fail" : "ok",
    "command files",
    broken.length
      ? `${broken.length} file(s) do not parse: ${broken.slice(0, 3).join("; ")}`
      : "every dist command file parses",
  );
  const state = await exists(statePath());
  check(
    state ? "ok" : "fail",
    "bridge state",
    state ? statePath() : "missing; run a browser command or `browserkit serve`",
  );

  if (state) {
    try {
      const bridge = await BridgeClient.connect();
      try {
        const reply = await bridge.request("status");
        const browsers = Number(reply.browsers ?? 0);
        check(
          browsers > 0 ? "ok" : "fail",
          "browser connection",
          browsers > 0
            ? `${browsers} browser${browsers === 1 ? "" : "s"} connected`
            : "no browser connected; load the extension and open Chrome",
        );
        const protocol = reply.protocol as { major?: number; minor?: number } | undefined;
        if (protocol)
          check("ok", "bridge protocol", `${protocol.major ?? "?"}.${protocol.minor ?? "?"}`);
      } finally {
        bridge.close();
      }
    } catch (error) {
      check("fail", "bridge connection", error instanceof Error ? error.message : String(error));
    }
  }

  const status = checks.some((item) => item.status === "fail")
    ? "fail"
    : checks.some((item) => item.status === "warn")
      ? "warn"
      : "ok";
  process.stdout.write("browserkit doctor\n");
  process.stdout.write(`Status: ${status}\n`);
  for (const item of checks)
    process.stdout.write(`[${item.status}] ${item.label}: ${item.message}\n`);
  if (status !== "ok") {
    process.stdout.write(
      "Next: run `browserkit setup`, reload the extension at chrome://extensions, then try `browserkit status`.\n",
    );
  }
  return status === "fail" ? 1 : 0;
}

/** node --check every shipped command file; a broken build is named, not guessed at. */
async function checkDistSyntax(
  dist: string,
  exists: (path: string) => Promise<boolean>,
): Promise<string[]> {
  const files = [join(dist, "cli.js"), join(dist, "mcp.js")];
  const commands = join(dist, "commands");
  if (await exists(commands))
    for (const name of await readdir(commands).catch(() => []))
      if (name.endsWith(".js")) files.push(join(commands, name));
  const broken: string[] = [];
  for (const file of files) {
    if (!(await exists(file))) continue;
    const result = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
    if (result.status !== 0) {
      const reason = String(result.stderr ?? "")
        .split("\n")
        .find((line) => line.trim() && !line.startsWith("node:"));
      broken.push(`${basename(file)}: ${reason ?? "does not parse"}`);
    }
  }
  return broken;
}
