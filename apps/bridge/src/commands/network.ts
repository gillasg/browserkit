import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { BridgeClient } from "../client.js";
import { flag, has, type Args } from "../args.js";
import { out } from "../output.js";
import type { Command } from "../usage.js";

// The host-wide network store: what every tab the session worked in asked for, kept after the
// tabs close. Filters answer "what did this site call", "what did this endpoint return", "what
// would the curl be", "which origins were touched", and "give me a HAR".

const SESSION = "browserkit-cli";

async function inBrowser(code: string): Promise<unknown> {
  const bridge = await BridgeClient.connect();
  try {
    const reply = await bridge.request("run", { code, session: SESSION });
    if (reply.error) throw new Error(String(reply.error));
    return reply.value;
  } finally {
    bridge.close();
  }
}

const SCRIPT = `(async () => {
  const tab = await browser.activeTab().catch(() => null);
  if (!tab) throw new Error("no page tab is open; open one first");
  const filter = __FILTER__;
  return __BODY__;
})()`;

function run(filter: Record<string, unknown>, body: string): Promise<unknown> {
  return inBrowser(SCRIPT.replace("__FILTER__", JSON.stringify(filter)).replace("__BODY__", body));
}

function filterFrom(args: Args): Record<string, unknown> {
  const filter: Record<string, unknown> = {};
  if (flag(args, "match")) filter.match = flag(args, "match");
  if (flag(args, "origin")) filter.origin = flag(args, "origin");
  if (flag(args, "method")) filter.method = flag(args, "method");
  if (flag(args, "type")) filter.type = flag(args, "type");
  if (flag(args, "status")) filter.status = Number(flag(args, "status"));
  if (has(args, "static")) filter.static = "static";
  if (has(args, "dynamic")) filter.static = "dynamic";
  if (flag(args, "since")) filter.since = Date.parse(flag(args, "since") as string);
  if (flag(args, "limit")) filter.limit = Number(flag(args, "limit"));
  return filter;
}

async function list(args: Args): Promise<number> {
  const result = (await run(filterFrom(args), "browser.network.list(filter)")) as {
    entries: Record<string, unknown>[];
    count: number;
  };
  if (has(args, "json")) {
    out(JSON.stringify(result, null, 2));
    return 0;
  }
  for (const entry of result.entries)
    out(
      `${String(entry.method).padEnd(6)} ${String(entry.status).padEnd(4)} ${String(entry.type).padEnd(10)} ` +
        `${new Date(Number(entry.startedAt)).toISOString().slice(11, 19)} ${String(entry.id)} ${String(entry.url)}`,
    );
  out(`${result.count} requests`);
  return 0;
}

async function one(args: Args, action: "get" | "body" | "curl"): Promise<number> {
  const id = args.positional[1];
  if (!id) throw new Error(`Usage: browserkit network ${action} <id>`);
  if (action === "curl") {
    const result = (await run(
      {},
      `browser.network.curl(${JSON.stringify(id)}, {secrets: ${has(args, "secrets")}})`,
    )) as { curl?: string };
    out(result.curl ?? "(no request with that id)");
    return 0;
  }
  const value = await run({}, `browser.network.${action}(${JSON.stringify(id)})`);
  out(JSON.stringify(value, null, 2));
  return 0;
}

async function origins(args: Args): Promise<number> {
  const result = (await run({}, "browser.network.origins()")) as {
    origins: { origin: string; requests: number; bytes: number }[];
  };
  if (has(args, "json")) out(JSON.stringify(result, null, 2));
  else for (const row of result.origins) out(`${row.requests}\t${row.bytes}\t${row.origin}`);
  return 0;
}

async function stats(args: Args): Promise<number> {
  out(JSON.stringify(await run({}, "browser.network.stats()"), null, 2));
  return 0;
}

async function clear(args: Args): Promise<number> {
  const result = (await run({}, "browser.network.clear()")) as { cleared: number };
  out(`Cleared ${result.cleared} requests from the store.`);
  return 0;
}

async function exportHar(args: Args): Promise<number> {
  const har = await run(filterFrom(args), "browser.network.har(filter)");
  const outPath = resolve(flag(args, "out") ?? "network.har");
  await writeFile(outPath, JSON.stringify(har, null, 2), "utf8");
  out(`Wrote ${outPath}`);
  return 0;
}

async function network(args: Args): Promise<number> {
  const action = args.positional[0] ?? "list";
  if (action === "list") return list(args);
  if (action === "get") return one(args, "get");
  if (action === "body") return one(args, "body");
  if (action === "curl") return one(args, "curl");
  if (action === "origins") return origins(args);
  if (action === "stats") return stats(args);
  if (action === "clear") return clear(args);
  if (action === "export" || action === "har") return exportHar(args);
  throw new Error(
    "Usage: browserkit network list|get|body|curl|origins|stats|clear|export [--match text] [--origin url] [--json]",
  );
}

export const networkCommand: Command = {
  name: "network",
  group: "Browser",
  summary: "search the requests every tab made, after the fact",
  help: `Usage: browserkit network list [--match text] [--origin url] [--method GET] [--type XHR]
                                 [--status 200] [--static|--dynamic] [--since ISO] [--limit n] [--json]
       browserkit network get <id> [--json]
       browserkit network body <id>
       browserkit network curl <id> [--secrets]
       browserkit network origins [--json]
       browserkit network stats
       browserkit network clear
       browserkit network export [--out network.har] [filters]

Requests from every tab the session used are kept for an hour (bounded in count and size), so a
capture survives the tab closing. Values like cookies and authorization are left out of curl
unless --secrets is passed. Bodies are kept only for calls captured while a tab was open.`,
  run: network,
};
