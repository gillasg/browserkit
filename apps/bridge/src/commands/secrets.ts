import { readFile } from "node:fs/promises";
import { listSites, readSession } from "@browserkit/tools/site-to-api";
import {
  captureSecretValues,
  deleteSecretProfile,
  listSecretProfiles,
  runSecretScript,
  saveSecretProfile,
} from "@browserkit/tools/secrets";
import { BridgeClient } from "../client.js";
import { cliHost } from "../host.js";
import { flag, has, type Args } from "../args.js";
import { dataDirectory } from "../paths.js";
import { out, printJson } from "../output.js";
import type { Command } from "../usage.js";

// Named secret profiles: capture the sign-in headers and cookies of a live session, keep them
// encrypted for this user, and run a small Node script with the values in BK_* variables. The
// values never print: output and errors are redacted before they leave the runner.
const SESSION = "browserkit-cli";

async function runInBrowser(code: string): Promise<unknown> {
  const host = cliHost();
  if (host) return host.runInBrowser(code, { session: SESSION });
  const bridge = await BridgeClient.connect();
  try {
    const reply = await bridge.request("run", { code, session: SESSION });
    if (reply.error) throw new Error(String(reply.error));
    return reply.value;
  } finally {
    bridge.close();
  }
}

async function captureHeaders(site: string): Promise<Record<string, string>> {
  const url = JSON.stringify(`https://${site}/`);
  try {
    const result = (await runInBrowser(
      `(async () => { const reply = await globalThis.__call({sessionHeaders: {url: ${url}}}); return reply && reply.headers ? reply.headers : {}; })()`,
    )) as { headers?: Record<string, string> } | undefined;
    return result?.headers ?? {};
  } catch {
    return {};
  }
}

async function save(args: Args): Promise<number> {
  const name = args.positional[1];
  if (!name) throw new Error("Usage: browserkit secrets save <name> --site <host>");
  const site = flagValue(args, "site") ?? args.positional[2];
  if (!site) throw new Error("Usage: browserkit secrets save <name> --site <host>");
  const values = await captureSecretValues(site);
  values.headers = await captureHeaders(site);
  const meta = await saveSecretProfile(name, values, dataDirectory());
  if (has(args, "json")) printJson(meta);
  else out(`Saved secret profile ${name} for ${site} (${meta.cipher}).`);
  return 0;
}

async function list(args: Args): Promise<number> {
  const profiles = await listSecretProfiles(dataDirectory());
  const sessions = [];
  for (const site of await listSites()) {
    const session = await readSession(site.site);
    if (session)
      sessions.push({ site: site.site, savedAt: session.savedAt, cookies: session.cookies.length });
  }
  if (has(args, "json")) {
    printJson({ profiles, sessions });
    return 0;
  }
  for (const profile of profiles)
    out(`profile\t${profile.name}\t${profile.site}\t${profile.savedAt}\t${profile.cipher}`);
  for (const session of sessions)
    out(`session\t${session.site}\t${session.savedAt}\t${session.cookies} cookie(s)`);
  if (!profiles.length && !sessions.length) out("No secret profiles or exported sessions.");
  return 0;
}

async function run(args: Args): Promise<number> {
  const name = args.positional[1];
  if (!name) throw new Error("Usage: browserkit secrets run <name> --script <file|->");
  const file = flagValue(args, "script");
  if (!file) throw new Error("Usage: browserkit secrets run <name> --script <file|->");
  const script = file === "-" ? await stdin() : await readFile(file, "utf8");
  const result = await runSecretScript(name, script, dataDirectory());
  if (has(args, "json")) printJson(result);
  else {
    if (result.stdout) out(result.stdout.trimEnd());
    if (result.stderr) out(result.stderr.trimEnd());
  }
  return result.code === 0 ? 0 : 1;
}

async function remove(args: Args): Promise<number> {
  const name = args.positional[1];
  if (!name) throw new Error("Usage: browserkit secrets delete <name>");
  const deleted = await deleteSecretProfile(name, dataDirectory());
  if (has(args, "json")) printJson({ name, deleted });
  else out(deleted ? `Deleted ${name}.` : `No secret profile ${name}.`);
  return deleted ? 0 : 1;
}

function flagValue(args: Args, name: string): string | undefined {
  const value = flag(args, name);
  return typeof value === "string" ? value : undefined;
}

function stdin(): Promise<string> {
  return new Promise((resolve) => {
    let text = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk: string) => (text += chunk));
    process.stdin.on("end", () => resolve(text));
  });
}

export const secretsCommand: Command = {
  name: "secrets",
  group: "Keep a site working",
  summary: "encrypted sign-in profiles and scripts that use them",
  help: `Usage: browserkit secrets <action> [name] [--site <host>] [--script <file|->] [--json]

Actions:
  save <name> --site <host>  capture the live session's sign-in headers and cookies
  list                       profiles and the site sessions already exported
  run <name> --script <file| ->  run a Node script with BK_* values; output is redacted
  delete <name>              remove a profile

Profiles are encrypted for the current user (DPAPI on Windows, a 0600 key file elsewhere).
Secret values never appear in output, errors, steps or the journal.`,
  run: async (args: Args) => {
    const action = args.positional[0] ?? "list";
    if (action === "save") return save(args);
    if (action === "list") return list(args);
    if (action === "run") return run(args);
    if (action === "delete") return remove(args);
    throw new Error("Usage: browserkit secrets <save|list|run|delete> [name]");
  },
};
