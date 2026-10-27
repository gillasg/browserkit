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
    out(`${answer.site}: ${answer.items.length} things`);
    for (const item of answer.items) out(`${item.does}\t${item.kind}\t${item.name}\t${item.title}`);
    for (const note of answer.notes) out(`note: ${note}`);
  }
  return 0;
}

export const capabilitiesCommand: Command = {
  name: "capabilities",
  group: "Sites",
  summary: "what already exists on a site: operations, recipes, workflows, tools, skills",
  help: `Usage: browserkit capabilities [site] [--json]

Merges mapped operations (with search/list/detail/price/availability roles), recipes, recorded
workflows, enabled site and page tools, learned notes and WebMCP tools. Reads sort before writes.
Without a site, uses the active tab.`,
  run: capabilities,
};
