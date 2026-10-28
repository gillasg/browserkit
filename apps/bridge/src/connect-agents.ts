import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

// Adds an MCP server to the coding agents installed on this machine, so setup is one command.
// Only agents that are already set up are touched (their config file or command exists); an
// entry that is already there is replaced, everything else in the file is kept. Safe to rerun.

export interface McpServer {
  name: string;
  command: string;
  args: string[];
}

export interface AgentResult {
  agent: string;
  done: boolean;
  detail: string;
}

export async function connectAgents(server: McpServer): Promise<AgentResult[]> {
  const home = homedir();
  const appData = process.env.APPDATA ?? join(home, "AppData", "Roaming");
  const results = [
    claudeCode(server),
    await jsonServers("Cursor", join(home, ".cursor", "mcp.json"), server),
    await jsonServers("Gemini CLI", join(home, ".gemini", "settings.json"), server),
    await jsonServers(
      "Claude Desktop",
      process.platform === "win32"
        ? join(appData, "Claude", "claude_desktop_config.json")
        : join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json"),
      server,
    ),
    await opencode(join(home, ".config", "opencode", "opencode.json"), server),
    await codex(join(home, ".codex", "config.toml"), server),
  ];
  return results.filter((result): result is AgentResult => result !== undefined);
}

function claudeCode(server: McpServer): AgentResult | undefined {
  const claude = process.platform === "win32" ? "claude.cmd" : "claude";
  try {
    execFileSync(claude, ["--version"], {
      stdio: "ignore",
      windowsHide: true,
      shell: process.platform === "win32",
    });
  } catch {
    return undefined;
  }
  const run = (args: string[]) =>
    execFileSync(claude, args, {
      stdio: "ignore",
      windowsHide: true,
      shell: process.platform === "win32",
    });
  try {
    try {
      run(["mcp", "remove", "--scope", "user", server.name]);
    } catch {
      // Not added yet.
    }
    run(["mcp", "add", "--scope", "user", server.name, "--", server.command, ...server.args]);
    return { agent: "Claude Code", done: true, detail: "claude mcp add --scope user" };
  } catch (error) {
    return {
      agent: "Claude Code",
      done: false,
      detail: String(error instanceof Error ? error.message : error),
    };
  }
}

async function readJson(path: string): Promise<Record<string, unknown> | undefined> {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

/** The common shape: {"mcpServers": {name: {command, args}}}. */
async function jsonServers(
  agent: string,
  path: string,
  server: McpServer,
): Promise<AgentResult | undefined> {
  if (!existsSync(dirname(path))) return undefined;
  const config = (await readJson(path)) ?? (existsSync(path) ? undefined : {});
  if (!config) return { agent, done: false, detail: `could not read ${path}; left as it was` };
  const servers = (config.mcpServers ?? {}) as Record<string, unknown>;
  servers[server.name] = { command: server.command, args: server.args };
  config.mcpServers = servers;
  await writeFile(path, JSON.stringify(config, null, 2) + "\n");
  return { agent, done: true, detail: path };
}

async function opencode(path: string, server: McpServer): Promise<AgentResult | undefined> {
  if (!existsSync(dirname(path))) return undefined;
  const config =
    (await readJson(path)) ??
    (existsSync(path) ? undefined : { $schema: "https://opencode.ai/config.json" });
  if (!config)
    return { agent: "opencode", done: false, detail: `could not read ${path}; left as it was` };
  const servers = (config.mcp ?? {}) as Record<string, unknown>;
  servers[server.name] = {
    type: "local",
    command: [server.command, ...server.args],
    enabled: true,
  };
  config.mcp = servers;
  await writeFile(path, JSON.stringify(config, null, 2) + "\n");
  return { agent: "opencode", done: true, detail: path };
}

/** Codex keeps TOML: our table is replaced as a whole block, the rest of the file untouched. */
async function codex(path: string, server: McpServer): Promise<AgentResult | undefined> {
  if (!existsSync(dirname(path))) return undefined;
  const text = existsSync(path) ? await readFile(path, "utf8") : "";
  const header = `[mcp_servers.${server.name}]`;
  const block = [
    header,
    `command = ${JSON.stringify(server.command)}`,
    `args = ${JSON.stringify(server.args)}`,
    "",
  ].join("\n");
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === header);
  let next = text;
  if (start >= 0) {
    let end = start + 1;
    while (end < lines.length && !/^\s*\[/.test(lines[end] ?? "")) end += 1;
    next = [...lines.slice(0, start), ...block.split("\n"), ...lines.slice(end)].join("\n");
  } else next = (text && !text.endsWith("\n") ? text + "\n" : text) + "\n" + block;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, next);
  return { agent: "Codex", done: true, detail: path };
}
