import { siteCapabilities } from "@browserkit/tools/site-to-api";
import { BridgeClient } from "../client.js";
import { has, type Args } from "../args.js";
import { out } from "../output.js";
import type { Command } from "../usage.js";

async function activeUrl(): Promise<string | undefined> {
  const bridge = await BridgeClient.connect();
  try {
    const reply = await bridge.request("run", {
      session: "browserkit-cli",
      code: `(await browser.activeTab()).url`,
    });
    if (reply.error) return undefined;
    return typeof reply.value === "string" ? reply.value : undefined;
  } finally {
    bridge.close();
  }
}

async function capabilities(args: Args): Promise<number> {
  const site = args.positional[0] ?? (await activeUrl());
  if (!site) throw new Error("Usage: browserkit capabilities [site] [--json]");
  const answer = await siteCapabilities(site);
  if (has(args, "json")) out(JSON.stringify(answer, null, 2));
  else {
    out(
      `${answer.site}: ${answer.abilities.length} abilities, ${answer.operations.length} operations`,
    );
    for (const ability of answer.abilities)
      out(`${ability.does}\t${ability.ways.join("+")}\t${ability.name}\t${ability.title}`);
    if (answer.notes.trim()) out(`\n${answer.notes.trim()}`);
  }
  return 0;
}

export const capabilitiesCommand: Command = {
  name: "capabilities",
  group: "Sites",
  summary: "what already exists on a site: abilities, operations and notes",
  help: `Usage: browserkit capabilities [site] [--json]

Returns the site's abilities (name, read/write, ways, inputs, stats), mapped operations with
their roles, the site's Markdown notes, and WebMCP tools in browser code. Without a site, uses the
active tab.`,
  run: capabilities,
};
