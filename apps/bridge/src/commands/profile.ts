import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { dataDirectory } from "../paths.js";
import { flag, type Args } from "../args.js";
import { out } from "../output.js";
import type { Command } from "../usage.js";

// A browser profile Aeon owns: a fresh user-data directory, its own DNS-over-HTTPS setting, no
// extensions, and a launcher that keeps it away from the user's own Chrome. Codecs are a property
// of the browser binary, not the profile: a Chrome for Testing build has no proprietary codecs;
// point CHROME_PATH at branded Chrome when a site needs them.

export function profileDirectory(): string {
  return join(dataDirectory(), "profile");
}

export function profileArgs(directory: string, url?: string): string[] {
  return [
    `--user-data-dir=${directory}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    "--disable-component-extensions-with-background-pages",
    "--disable-sync",
    ...(url ? [url] : []),
  ];
}

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  process.platform === "win32"
    ? join(process.env.PROGRAMFILES ?? "", "Google/Chrome/Application/chrome.exe")
    : undefined,
  process.platform === "win32"
    ? join(process.env["PROGRAMFILES(X86)"] ?? "", "Google/Chrome/Application/chrome.exe")
    : undefined,
  process.platform === "darwin"
    ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
    : undefined,
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
].filter((path): path is string => Boolean(path));

function chromePath(): string {
  const found = CHROME_CANDIDATES.find((path) => existsSync(path));
  if (!found)
    throw new Error(
      "CHROME_NOT_FOUND: set CHROME_PATH to a Chrome binary, or install Google Chrome.",
    );
  return found;
}

async function install(): Promise<void> {
  const directory = profileDirectory();
  await mkdir(directory, { recursive: true });
  const preferences = {
    dns_over_https: { mode: "secure", templates: "https://chrome.cloudflare-dns.com/dns-query" },
    profile: { exit_type: "Normal", exited_cleanly: true },
    browser: { has_seen_welcome_page: true },
  };
  await writeFile(join(directory, "Preferences"), JSON.stringify(preferences, null, 2), "utf8");
  out(`Profile ready at ${directory}`);
  out("DNS-over-HTTPS is on; extensions are disabled; it is not the user's Chrome profile.");
}

async function launch(args: Args): Promise<number> {
  const directory = profileDirectory();
  await mkdir(directory, { recursive: true });
  const url = flag(args, "url");
  const child = spawn(chromePath(), profileArgs(directory, url ? String(url) : undefined), {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  out(`Launched the managed profile (${directory})${url ? ` at ${String(url)}` : ""}.`);
  return 0;
}

async function profile(args: Args): Promise<number> {
  const action = args.positional[0] ?? "path";
  if (action === "path") {
    out(profileDirectory());
    return 0;
  }
  if (action === "install") {
    await install();
    return 0;
  }
  if (action === "launch") return launch(args);
  throw new Error("Usage: browserkit profile path|install|launch [--url <url>]");
}

export const profileCommand: Command = {
  name: "profile",
  group: "Browser",
  summary: "a browser profile Aeon owns: fresh, DoH, no extensions",
  help: `Usage: browserkit profile path
       browserkit profile install
       browserkit profile launch [--url <url>]

A fresh Chrome profile under browserkit's data folder, separate from the user's own. install writes
its Preferences (secure DNS-over-HTTPS, no welcome page); launch starts Chrome with
--user-data-dir, --disable-extensions and no first-run screens. Set CHROME_PATH to choose the
binary. Codecs come from the binary: branded Chrome has them, Chrome for Testing does not.`,
  run: profile,
};

export function profileCommands(): Command[] {
  return [profileCommand];
}
