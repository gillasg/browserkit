import { lookup } from "node:dns/promises";
import { BridgeClient } from "../client.js";
import { has, type Args } from "../args.js";
import { out } from "../output.js";
import type { Command } from "../usage.js";

// DNS from both sides: the address Chrome connected to (its resolver, after DoH or a hosts file)
// and the address the machine's resolver returns. Differing hosts are exactly the ones a request
// will behave differently on.

const SESSION = "browserkit-cli";

async function inBrowser(code: string, timeoutMs = 120_000): Promise<unknown> {
  const bridge = await BridgeClient.connect();
  try {
    const reply = await bridge.request("run", { code, session: SESSION, timeoutMs });
    if (reply.error) throw new Error(String(reply.error));
    return reply.value;
  } finally {
    bridge.close();
  }
}

interface BrowserAnswer {
  host: string;
  address: string;
  url: string;
}

async function dns(args: Args): Promise<number> {
  const hosts = args.positional
    .map((value) =>
      value
        .replace(/^https?:\/\//i, "")
        .split("/")[0]
        ?.trim(),
    )
    .filter((value): value is string => Boolean(value));
  if (!hosts.length) throw new Error("Usage: browserkit dns <host> [host...] [--json]");
  const code = `(async () => {
  const hosts = ${JSON.stringify(hosts)};
  const out = [];
  for (const host of hosts) {
    let page;
    try {
      page = await browser.openTab("https://" + host + "/", { newTab: true, quiet: true, timeoutMs: 20000 });
      await page.waitForTimeout(800);
      out.push({ host, browser: await page.dns() });
    } catch (error) {
      out.push({ host, browser: null, error: String((error && error.message) || error) });
    } finally {
      if (page) await page.close().catch(() => {});
    }
  }
  return out;
})()`;
  const browser = (await inBrowser(code, 180_000)) as {
    host: string;
    browser: BrowserAnswer | null;
    error?: string;
  }[];
  const machine: { host: string; addresses: string[]; error?: string }[] = await Promise.all(
    hosts.map(async (host) => {
      try {
        const rows = await lookup(host, { all: true });
        return { host, addresses: rows.map((row) => row.address) };
      } catch (error) {
        return {
          host,
          addresses: [],
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }),
  );
  const rows = browser.map((entry) => {
    const local = machine.find((item) => item.host === entry.host);
    const browserAddress = entry.browser?.address;
    return {
      host: entry.host,
      browser: browserAddress ?? null,
      machine: local?.addresses ?? [],
      differs:
        browserAddress !== undefined &&
        local?.addresses.length !== undefined &&
        !local.addresses.includes(browserAddress),
      ...(entry.error ? { browserError: entry.error } : {}),
      ...(local?.error ? { machineError: local.error } : {}),
    };
  });
  if (has(args, "json")) {
    out(JSON.stringify({ hosts: rows }, null, 2));
    return 0;
  }
  for (const row of rows) {
    const status = row.differs ? "DIFFERS" : row.browser ? "same" : "unknown";
    out(
      `${row.host.padEnd(32)} browser ${String(row.browser ?? "?").padEnd(18)} machine ${row.machine.join(", ") || "?"}  ${status}`,
    );
  }
  return 0;
}

export const dnsCommand: Command = {
  name: "dns",
  group: "Browser",
  summary: "compare the browser's resolver with the machine's for a host",
  help: `Usage: browserkit dns <host> [host...] [--json]

Opens each host in a quiet tab and reads the address Chrome actually connected to (its resolver,
after DoH, a proxy or a hosts file), then resolves the same host with the machine's resolver. A
host that differs is the one whose requests will behave differently for the agent.`,
  run: dns,
};

export function dnsCommands(): Command[] {
  return [dnsCommand];
}
