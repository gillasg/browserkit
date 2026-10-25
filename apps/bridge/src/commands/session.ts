import { BridgeClient } from "../client.js";
import { flag, has, type Args } from "../args.js";
import { out } from "../output.js";
import type { Command } from "../usage.js";

// Named sessions: a tab (or its own window) an agent can come back to by name, with its own FIFO
// so it never interleaves with another session, while reads still run in parallel across sessions.

async function request(body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const bridge = await BridgeClient.connect();
  try {
    const { kind, ...rest } = body;
    return await bridge.request(String(kind), rest as never);
  } finally {
    bridge.close();
  }
}

async function listSessions(args: Args): Promise<number> {
  const result = await request({ kind: "session.list" });
  const sessions = (result.sessions as Record<string, unknown>[] | undefined) ?? [];
  if (has(args, "json")) {
    out(JSON.stringify(result, null, 2));
    return 0;
  }
  if (!sessions.length) {
    out("No named sessions. Create one: browserkit sessions create work --url https://example.com");
    return 0;
  }
  for (const session of sessions)
    out(
      `${String(session.name).padEnd(20)} ${String(session.mode).padEnd(6)} ` +
        `${(session.tabs as number[] | undefined)?.length ?? 0} tab(s)` +
        `${session.busy ? `  busy ${String(session.busy)}` : ""}${session.queued ? `  queued ${String(session.queued)}` : ""}` +
        `${session.lastUsedAt ? `  ${String(session.lastUsedAt)}` : ""}`,
    );
  return 0;
}

async function info(args: Args): Promise<number> {
  const name = args.positional[1];
  if (!name) throw new Error("Usage: browserkit sessions info <name> [--json]");
  const result = await request({ kind: "session.info", session: name });
  out(JSON.stringify(result, null, 2));
  return 0;
}

async function open(args: Args, mode: "create" | "ensure" | "reopen"): Promise<number> {
  const name = args.positional[1];
  if (!name) throw new Error(`Usage: browserkit sessions ${mode} <name> [--url <url>] [--window]`);
  const url = flag(args, "url");
  const result = await request({
    kind: `session.${mode}`,
    session: name,
    ...(url ? { url } : {}),
    ...(has(args, "window") ? { mode: "window" } : {}),
  });
  if (result.error) throw new Error(String(result.error));
  if (has(args, "json")) out(JSON.stringify(result, null, 2));
  else
    out(
      `${String(result.name)} ${result.reused ? "reused" : "opened"}: ` +
        `${(result.tabs as number[] | undefined)?.length ?? 0} tab(s)` +
        `${result.url ? ` on ${String(result.url)}` : ""}.`,
    );
  return 0;
}

async function cleanup(args: Args, remove: boolean): Promise<number> {
  const name = args.positional[1];
  if (!name) throw new Error(`Usage: browserkit sessions ${remove ? "delete" : "cleanup"} <name>`);
  const result = await request({
    kind: remove ? "session.delete" : "session.cleanup",
    session: name,
  });
  if (result.error) throw new Error(String(result.error));
  if (has(args, "json")) out(JSON.stringify(result, null, 2));
  else
    out(
      `${remove ? "Deleted" : "Cleaned up"} ${name}: closed ${String(result.closed ?? 0)} tab(s).`,
    );
  return 0;
}

async function session(args: Args): Promise<number> {
  const action = args.positional[0] ?? "list";
  if (action === "list") return listSessions(args);
  if (action === "info") return info(args);
  if (action === "create") return open(args, "create");
  if (action === "ensure") return open(args, "ensure");
  if (action === "reopen") return open(args, "reopen");
  if (action === "cleanup") return cleanup(args, false);
  if (action === "delete" || action === "rm") return cleanup(args, true);
  throw new Error(
    "Usage: browserkit sessions list|info|create|ensure|reopen|cleanup|delete <name>",
  );
}

export const sessionCommand: Command = {
  name: "sessions",
  group: "Browser",
  summary: "named browser sessions: one tab or window each, with their own queue",
  help: `Usage: browserkit sessions list [--json]
       browserkit sessions info <name> [--json]
       browserkit sessions create <name> --url <url> [--window] [--json]
       browserkit sessions ensure <name> [--url <url>] [--window] [--json]
       browserkit sessions reopen <name> [--json]
       browserkit sessions cleanup <name> [--json]
       browserkit sessions delete <name> [--json]

A named session owns one quiet tab (default) or its own window, and its cells run in the order
they were sent. Sessions run in parallel; writes across sessions are serialized by the engine.
The name and its url survive a bridge restart, so "ensure" comes back to the same session and
"reopen" makes a fresh tab after "cleanup".`,
  run: session,
};
