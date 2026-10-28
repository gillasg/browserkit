import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dataDirectory } from "./paths.js";

// The extension half of setup. From a source checkout the built folder is used; from an npm
// install the extension of the latest release is downloaded and unpacked into the data folder.
// Then the extensions page opens with the folder's path on the clipboard, which leaves the user
// one click (Load unpacked) until the Web Store listing removes that too.

const RELEASES = "https://api.github.com/repos/gillasg/browserkit/releases/latest";
const sourceBuild = fileURLToPath(new URL("../../extension/build", import.meta.url));

export async function extensionFolder(log: (line: string) => void): Promise<string> {
  if (existsSync(join(sourceBuild, "manifest.json"))) return sourceBuild;
  const folder = join(dataDirectory(), "extension");
  log("Downloading the browserkit extension from the latest release…");
  const release = (await (
    await fetch(RELEASES, { headers: { accept: "application/vnd.github+json" } })
  ).json()) as {
    tag_name?: string;
    assets?: { name: string; browser_download_url: string }[];
  };
  const asset = release.assets?.find((item) => /^browserkit-.*\.zip$/.test(item.name));
  if (!asset)
    throw new Error("No extension in the latest release; build it from source (see the README).");
  const response = await fetch(asset.browser_download_url);
  if (!response.ok) throw new Error(`Download failed: HTTP ${response.status}`);
  const zip = join(dataDirectory(), asset.name);
  await mkdir(dataDirectory(), { recursive: true });
  await writeFile(zip, Buffer.from(await response.arrayBuffer()));
  await rm(folder, { recursive: true, force: true });
  await mkdir(folder, { recursive: true });
  unzip(zip, folder);
  await rm(zip, { force: true });
  log(`Extension ${release.tag_name ?? ""} unpacked at ${folder}`);
  return folder;
}

function unzip(zip: string, folder: string): void {
  // Windows 10+ and macOS ship a tar that reads zip files; Linux has unzip.
  const tries: [string, string[]][] =
    process.platform === "linux"
      ? [
          ["unzip", ["-q", "-o", zip, "-d", folder]],
          ["bsdtar", ["-xf", zip, "-C", folder]],
        ]
      : [["tar", ["-xf", zip, "-C", folder]]];
  for (const [command, args] of tries) {
    try {
      execFileSync(command, args, { stdio: "ignore", windowsHide: true });
      return;
    } catch {
      // Try the next tool.
    }
  }
  throw new Error(`Could not unpack ${zip}; unzip it into ${folder} by hand.`);
}

/** Puts the folder on the clipboard and opens Chrome's extensions page; both best effort. */
export function presentExtension(folder: string): void {
  const copy: [string, string[]] | undefined =
    process.platform === "win32"
      ? ["clip", []]
      : process.platform === "darwin"
        ? ["pbcopy", []]
        : ["xclip", ["-selection", "clipboard"]];
  try {
    execFileSync(copy[0], copy[1], {
      input: folder,
      stdio: ["pipe", "ignore", "ignore"],
      windowsHide: true,
    });
  } catch {
    // No clipboard tool: the path is printed anyway.
  }
  const open: [string, string[]] =
    process.platform === "win32"
      ? ["cmd", ["/c", "start", "", "chrome", "chrome://extensions"]]
      : process.platform === "darwin"
        ? ["open", ["-a", "Google Chrome", "chrome://extensions"]]
        : ["google-chrome", ["chrome://extensions"]];
  try {
    spawn(open[0], open[1], { stdio: "ignore", detached: true, windowsHide: true }).unref();
  } catch {
    // Chrome not found under that name: the steps say where to go.
  }
}
