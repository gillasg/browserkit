import { BridgeClient } from "../client.js";
import { flag, has, type Args } from "../args.js";
import { out } from "../output.js";
import type { Command } from "../usage.js";

// The standalone viewer: a local page that shows an agent tab using the screencast flight already
// owns, and sends pointer/keys back as agent input.
async function view(args: Args): Promise<number> {
  const bridge = await BridgeClient.connect();
  try {
    const reply = has(args, "stop")
      ? await bridge.request("view.stop")
      : await bridge.request("view.start", {
          tabId: Number(flag(args, "tab") ?? 0),
          session: flag(args, "session") ?? "cli",
          port: Number(flag(args, "port") ?? 0),
        });
    if (reply.error) throw new Error(String(reply.error));
    if (has(args, "json")) {
      out(JSON.stringify(reply, null, 2));
      return reply.running ? 0 : 1;
    }
    if (!reply.running) {
      out("The viewer is not running. Start it: browserkit view --tab <id>");
      return 1;
    }
    out(`Agent view: ${String(reply.url)}`);
    return 0;
  } finally {
    bridge.close();
  }
}

export const viewCommand: Command = {
  name: "view",
  group: "Browser",
  summary: "live view of one agent tab, with click and key input",
  help: `Usage: browserkit view --tab <id> [--session name] [--port 0] [--json]
       browserkit view --stop

Runs a 127.0.0.1-only page showing the tab's existing screencast. It never starts a second
screencast; closing the viewer leaves flight recording untouched.`,
  run: view,
};
