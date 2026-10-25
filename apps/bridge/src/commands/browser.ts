import { readFile } from "node:fs/promises";
import { BridgeClient } from "../client.js";
import { startBridge } from "../bridge-server.js";
import { runDoctor } from "../doctor.js";
import { formatResult } from "../format.js";
import { installSkill } from "../install-skill.js";
import { runMcpServer } from "../mcp.js";
import { nextSteps, setup } from "../setup.js";
import { flag, has, type Args } from "../args.js";
import { out } from "../output.js";
import type { Command } from "../usage.js";

// The browser itself: the bridge, the REPL, tabs, the journal, the MCP server.

async function repl(args: Args): Promise<number> {
  // @file.js runs a file; "-" reads the code from stdin. Cells are often longer than a shell
  // line, so both keep quoting out of the way.
  const given = args.positional.join(" ");
  const code =
    given === "-"
      ? await stdin()
      : given.startsWith("@")
        ? await readFile(given.slice(1), "utf8")
        : given;
  if (!code.trim())
    throw new Error(
      'Usage: browserkit repl "<code>" | @file.js | - [--session name] [--timeout ms] [--quiet]',
    );
  // After-action behaviour for this realm: --screenshot turns it on, --settle waits after each
  // action, --full captures at full resolution, --no-screenshot/--no-diff switch parts off.
  const settings: string[] = [];
  if (has(args, "screenshot") || has(args, "full") || has(args, "settle")) settings.push("on:true");
  if (has(args, "screenshot") || has(args, "full")) settings.push("screenshots:true", "diff:true");
  if (has(args, "settle"))
    settings.push(`settleMs:${Math.max(0, Number(flag(args, "settle")) || 0)}`);
  if (has(args, "full")) settings.push("full:true");
  if (has(args, "no-screenshot")) settings.push("screenshots:false");
  if (has(args, "no-diff")) settings.push("diff:false");
  const prelude = settings.length ? `__options({${settings.join(", ")}});\n` : "";
  const bridge = await BridgeClient.connect();
  try {
    const timeout = flag(args, "timeout");
    const result = await bridge.request("run", {
      code: prelude + code,
      session: flag(args, "session") ?? "cli",
      ...(timeout ? { timeoutMs: Number(timeout) } : {}),
    });
    if (!has(args, "quiet")) process.stdout.write(formatResult(result).text + "\n");
    return result.error ? 1 : 0;
  } finally {
    bridge.close();
  }
}

/** Reads a cell piped on stdin. */
async function stdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

async function tabs(args: Args): Promise<number> {
  const bridge = await BridgeClient.connect();
  try {
    const reply = await bridge.request("tabs");
    if (has(args, "json")) {
      out(JSON.stringify(reply.tabs ?? [], null, 2));
      return 0;
    }
    for (const tab of (reply.tabs as Record<string, unknown>[] | undefined) ?? [])
      out(
        `${String((tab.target as { tabId?: number })?.tabId)}\t${String(tab.title ?? "")}\t${String(tab.url ?? "")}`,
      );
    return 0;
  } finally {
    bridge.close();
  }
}

async function status(args: Args): Promise<number> {
  const bridge = await BridgeClient.connect();
  try {
    const reply = await bridge.request("status");
    if (has(args, "json")) out(JSON.stringify(reply));
    else out(`Bridge running; ${String(reply.browsers)} browser(s) connected.`);
    return 0;
  } finally {
    bridge.close();
  }
}

async function journal(args: Args): Promise<number> {
  const session = args.positional[0] ?? "cli";
  const limit = Number(flag(args, "limit") ?? 50);
  const bridge = await BridgeClient.connect();
  try {
    const reply = await bridge.request("journal", { session, limit });
    const entries = (reply.entries as Record<string, unknown>[] | undefined) ?? [];
    if (has(args, "json")) out(JSON.stringify(entries, null, 2));
    else if (!entries.length) out("No journal entries.");
    else
      for (const entry of entries)
        out(
          `${String(entry.ts ?? "")} ${entry.isError ? "ERR" : "ok "} ${String(entry.durationMs ?? 0)}ms ${String(entry.resultPreview ?? "").slice(0, 120)}`,
        );
    return 0;
  } finally {
    bridge.close();
  }
}

async function serve(): Promise<number> {
  const { state } = await startBridge();
  process.stderr.write(`Bridge listening on 127.0.0.1:${state.port}\n`);
  await new Promise(() => undefined);
  return 0;
}

async function register(args: Args): Promise<number> {
  await setup({ register: !has(args, "no-register") });
  process.stdout.write(nextSteps() + "\n");
  const linked = await installSkill();
  for (const path of linked) out(`Linked the browserkit skill at ${path}`);
  return 0;
}

async function mcp(): Promise<number> {
  await runMcpServer();
  return 0;
}

export const browserGroup: Command[] = [
  {
    name: "setup",
    group: "Browser",
    summary: "register the native host and print how to connect agents",
    help: `Usage: browserkit setup [--no-register]

Writes the native messaging host manifest and registers it for Chrome, Edge, Chromium and Brave.
An older registration from before the rename is removed. --no-register only writes the files.
It also links the browserkit skill into ~/.agents/skills (and ~/.claude/skills) so coding agents
on this machine find it.`,
    run: register,
  },
  {
    name: "doctor",
    group: "Browser",
    summary: "check the install, the bridge and the browser connection",
    help: `Usage: browserkit doctor`,
    run: async () => runDoctor(),
  },
  {
    name: "status",
    group: "Browser",
    summary: "show whether a browser is connected",
    help: `Usage: browserkit status [--json]`,
    run: status,
  },
  {
    name: "tabs",
    group: "Browser",
    summary: "list the browser's open tabs",
    help: `Usage: browserkit tabs [--json]

Prints tab id, title and URL, one tab per line; --json prints the browser's own entries.`,
    run: tabs,
  },
  {
    name: "repl",
    group: "Browser",
    summary: "run a browser_code cell",
    help: `Usage: browserkit repl "<code>" [--session name] [--timeout ms] [--quiet]
       browserkit repl @file.js [--session name]
       echo "<code>" | browserkit repl -

The last expression is returned. Variables and tabs persist per session. A long cell goes in a
file (@file.js) or on stdin (-) instead of on the command line, so quoting and line endings stay
out of the way. --quiet prints nothing but still sets the exit code. --timeout caps the cell.`,
    run: repl,
  },
  {
    name: "journal",
    group: "Browser",
    summary: "show the last cells a session ran",
    help: `Usage: browserkit journal [session] [--limit n] [--json]`,
    run: journal,
  },
  {
    name: "mcp",
    group: "Browser",
    summary: "stdio MCP server: browser_code, browser_tabs, crawl, site_mapper",
    help: `Usage: browserkit mcp`,
    run: mcp,
  },
  {
    name: "serve",
    group: "Browser",
    summary: "run the bridge in the foreground",
    help: `Usage: browserkit serve

Usually the bridge starts on demand; this keeps one in the foreground to watch it.`,
    run: serve,
  },
];
