import { BridgeClient } from "../client.js";
import { flag, has, type Args } from "../args.js";
import { out } from "../output.js";
import type { Command } from "../usage.js";

// A local DevTools Protocol endpoint for Playwright/Puppeteer. It is opt-in: this command starts
// the endpoint inside the bridge, prints how to connect, and can report or stop it.
async function cdp(args: Args): Promise<number> {
  const bridge = await BridgeClient.connect();
  try {
    const reply = has(args, "status")
      ? await bridge.request("cdp.status")
      : has(args, "stop")
        ? await bridge.request("cdp.stop")
        : await bridge.request("cdp.start", { port: Number(flag(args, "port") ?? 9333) });
    if (reply.error) throw new Error(String(reply.error));
    if (has(args, "json")) {
      out(JSON.stringify(reply, null, 2));
      return reply.running ? 0 : 1;
    }
    if (!reply.running) {
      out("The CDP endpoint is not running. Start it: browserkit cdp");
      return 1;
    }
    out(`CDP endpoint: ${String(reply.connectUrl ?? reply.url)}`);
    out(`Browser WebSocket: ${String(reply.wsUrl)}`);
    out(`Playwright: chromium.connectOverCDP("${String(reply.connectUrl ?? reply.url)}")`);
    out(
      "Puppeteer: puppeteer.connect({ browserURL: " +
        JSON.stringify(reply.connectUrl ?? reply.url) +
        " })",
    );
    return 0;
  } finally {
    bridge.close();
  }
}

export const cdpCommand: Command = {
  name: "cdp",
  group: "Browser",
  summary: "local DevTools Protocol endpoint for Playwright and Puppeteer",
  help: `Usage: browserkit cdp [--port 9333] [--status] [--stop] [--json]

Starts a 127.0.0.1-only CDP endpoint over agent tabs. A token is required; the printed URL
carries it. Playwright: chromium.connectOverCDP(url). Puppeteer: connect({browserURL: url}).
Tabs opened through the endpoint belong to that client and close when it disconnects.`,
  run: cdp,
};
