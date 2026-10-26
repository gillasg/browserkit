import {
  activeProvider,
  configPath,
  providerFor,
  readConfig,
  saveConfig,
  type ProviderName,
} from "@browserkit/credentials";
import { spawn } from "node:child_process";
import { has, type Args } from "../args.js";
import { out } from "../output.js";
import { dataDirectory } from "../paths.js";
import type { Command } from "../usage.js";

// `browserkit signin setup bitwarden|proton` picks the password manager agents sign in with;
// `browserkit signin status` says which one answers. Agents then call bu.signIn() on a sign-in
// page: the password goes from the password manager into the page, never through the agent.

async function status(args: Args): Promise<number> {
  const provider = await activeProvider(dataDirectory());
  if (!provider) {
    out(
      "No password manager answers. Run `browserkit signin setup bitwarden` or `signin setup proton`.",
    );
    return 1;
  }
  const state = await provider.status().catch((error: unknown) => String(error));
  if (has(args, "json")) out(JSON.stringify({ provider: provider.name, status: state }));
  else out(`${provider.name}: ${state}`);
  return state === "unlocked" ? 0 : 1;
}

async function setupProvider(name: ProviderName): Promise<number> {
  const directory = dataDirectory();
  const config = await readConfig(directory);
  if (name === "bitwarden") {
    out("Unlocking Bitwarden (`bw unlock --raw`); enter your master password.");
    const session = await unlockBitwarden();
    if (!session) {
      process.stderr.write("Bitwarden did not unlock. Run `bw login` first if needed.\n");
      return 1;
    }
    config.bitwardenSession = session;
  } else delete config.bitwardenSession;
  config.provider = name;
  const state = await providerFor(name, config)
    .status()
    .catch((error: unknown) => String(error));
  if (state !== "unlocked") {
    process.stderr.write(`${name} is not ready: ${state}\n`);
    return 1;
  }
  await saveConfig(directory, config);
  out(`Agents now sign in with ${name}. Saved to ${configPath(directory)}`);
  return 0;
}

function unlockBitwarden(): Promise<string | undefined> {
  return new Promise((resolve) => {
    // One command string with no argument array: on Windows `bw` is a .cmd shim that needs a
    // shell, and Node warns when a shell is given separate arguments.
    const child = spawn("bw unlock --raw", [], {
      stdio: ["inherit", "pipe", "inherit"],
      shell: true,
    });
    let text = "";
    child.stdout.on("data", (chunk: Buffer) => (text += chunk.toString()));
    child.on("error", () => resolve(undefined));
    child.on("close", (code) => resolve(code === 0 && text.trim() ? text.trim() : undefined));
  });
}

async function signin(args: Args): Promise<number> {
  const [action = "status", name] = args.positional;
  if (action === "status") return status(args);
  if (action === "setup" && (name === "bitwarden" || name === "proton")) return setupProvider(name);
  if (action !== "setup") throw new Error(`Unknown signin action "${action}": setup or status`);
  throw new Error("Usage: browserkit signin setup bitwarden|proton");
}

export const signinCommand: Command = {
  name: "signin",
  group: "Sign in",
  summary: "choose the password manager agents sign in with, or check it",
  help: `Usage: browserkit signin setup <bitwarden|proton>
       browserkit signin status [--json]

  setup bitwarden   unlock Bitwarden with \`bw\` and save a session key only you can read
  setup proton      use Proton Pass through its \`pass-cli\` (it keeps its own session)
  status            say which password manager answers, and whether it is unlocked

bu.signIn() in browser code then fills a site's sign-in form from that password manager. The
agent never sees the password or the one-time code; the first sign-in on a site is approved on
the page itself.

Saving a new login hands the item to the configured password manager CLI. Bitwarden receives a
base64 item and Proton Pass receives \`--password\` as an argument; that argument is visible to
processes of the same user. No password is written to browserkit logs or files.`,
  run: signin,
};
