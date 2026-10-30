import { readFile } from "node:fs/promises";
import { BridgeClient } from "../client.js";
import { spillText } from "../spill.js";
import { startBridge } from "../bridge-server.js";
import { runDoctor } from "../doctor.js";
import { formatResult } from "../format.js";
import { installSkill } from "../install-skill.js";
import { runMcpServer } from "../mcp.js";
import { connectAgents } from "../connect-agents.js";
import { mcpCommand, nextSteps, setup } from "../setup.js";
import { extensionFolder, presentExtension } from "../setup-extension.js";
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
      ...(has(args, "challenge-assist") ? { challengeAssist: true } : {}),
    });
    if (!has(args, "quiet")) {
      const text = await spillText(formatResult(result).text, flag(args, "session") ?? "cli");
      process.stdout.write(text + "\n");
    } else if (result.error) {
      // --quiet drops the output, never the error.
      process.stderr.write(String(result.error) + "\n");
    }
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

// One command: native host, extension folder, agents, skill, then wait for the extension.
async function register(args: Args): Promise<number> {
  await setup({ register: !has(args, "no-register") });
  out("Native host registered for Chrome, Edge, Chromium, Brave, Vivaldi, Opera, Arc and Helium.");
  const folder = await extensionFolder(out);
  if (!has(args, "no-agents")) {
    const results = await connectAgents({ name: "browserkit", ...mcpCommand() });
    for (const result of results)
      out(`${result.done ? "Connected" : "Could not connect"} ${result.agent} (${result.detail})`);
    if (!results.length) out(nextSteps());
  }
  for (const path of await installSkill()) out(`Linked the browserkit skill at ${path}`);
  // Only a person at a terminal gets the page opened and the wait; scripts get the steps.
  const interactive = process.stdout.isTTY === true && !has(args, "no-wait");
  if (interactive && (await browserConnected())) {
    out('The extension is connected. Try: browserkit repl "(await browser.tabs()).length"');
    return 0;
  }
  if (interactive) presentExtension(folder);
  out("");
  out("Last step: load the extension. In chrome://extensions, turn on");
  out(
    "Developer mode, click Load unpacked and choose this folder (its path is on your clipboard):",
  );
  out(`  ${folder}`);
  out("Then restart your agent so it picks up the browserkit MCP server.");
  if (!interactive) return 0;
  out("Waiting for the extension to connect (Ctrl+C to stop)…");
  for (let waited = 0; waited < 10 * 60_000; waited += 2000) {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    if (await browserConnected()) {
      out('Connected. Try: browserkit repl "(await browser.tabs()).length"');
      return 0;
    }
  }
  out("Still not connected; run `browserkit doctor` to see why.");
  return 1;
}

async function browserConnected(): Promise<boolean> {
  try {
    const bridge = await BridgeClient.connect();
    try {
      return Number((await bridge.request("status")).browsers) > 0;
    } finally {
      bridge.close();
    }
  } catch {
    return false;
  }
}

async function mcp(): Promise<number> {
  await runMcpServer();
  return 0;
}

export const browserGroup: Command[] = [
  {
    name: "setup",
    group: "Browser",
    summary: "set everything up: native host, extension, agents, skill",
    help: `Usage: browserkit setup [--no-register] [--no-agents] [--no-wait]

Registers the native messaging host for Chromium browsers (Chrome, Edge, Brave, Arc and others),
finds the extension (the built folder, or the latest release downloaded), adds the browserkit
MCP server to the coding agents on this machine (Claude Code, Codex, opencode, Cursor, Gemini
CLI, Claude Desktop), links the browserkit skill into ~/.agents/skills, then opens
chrome://extensions with the extension folder on the clipboard and waits until it connects.
--no-register only writes the host files; --no-agents leaves agent configs alone; --no-wait
returns without waiting.`,
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
out of the way. --quiet prints only errors (on stderr) and keeps the exit code. --timeout caps the cell.
--challenge-assist allows human-verification assistance only for chat cells.`,
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
