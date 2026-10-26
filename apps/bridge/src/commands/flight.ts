import { copyFile } from "node:fs/promises";
import { BridgeClient } from "../client.js";
import { flag, has, type Args } from "../args.js";
import { out } from "../output.js";
import type { Command } from "../usage.js";

// Saves the last two minutes of an agent session's page as a WebM. The recording lives in the
// offscreen document; the host writes it under BROWSERKIT_HOME/flight (or --out).
async function flight(args: Args): Promise<number> {
  const session = args.positional[0] ?? "cli";
  const bridge = await BridgeClient.connect();
  try {
    const result = await bridge.request("run", {
      session,
      code: "await page.flight.save()",
      timeoutMs: 240000,
    });
    if (result.error) throw new Error(String(result.error));
    const saved = (result.value ?? {}) as { path?: string; bytes?: number; frames?: number };
    if (!saved.path) throw new Error("FLIGHT_EMPTY: no frames were recorded");
    const wanted = flag(args, "out");
    if (wanted) await copyFile(saved.path, wanted);
    if (has(args, "json")) {
      out(JSON.stringify({ ...saved, ...(wanted ? { out: wanted } : {}) }, null, 2));
      return 0;
    }
    out(
      `Saved ${String(saved.frames ?? 0)} frame(s), ${Math.round(Number(saved.bytes ?? 0) / 1024)} KB: ${wanted ?? saved.path}`,
    );
    return 0;
  } finally {
    bridge.close();
  }
}

export const flightCommand: Command = {
  name: "flight",
  group: "Browser",
  summary: "save the last two minutes of an agent tab as WebM",
  help: `Usage: browserkit flight [session] [--out file.webm] [--json]

Saves the ring buffer of the session's current page. A failed browser_code cell saves one by
itself; pass --no-flight to repl to turn recording off for that run. Files land in
BROWSERKIT_HOME/flight unless --out names another place.`,
  run: flight,
};
