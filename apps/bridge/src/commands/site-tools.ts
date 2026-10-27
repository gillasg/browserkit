import {
  listSiteTools,
  readSiteTools,
  runSiteTool,
  setSiteToolsEnabled,
} from "@browserkit/tools/site-to-api";
import { flag, has, type Args } from "../args.js";
import { out, printJson } from "../output.js";
import type { Command } from "../usage.js";

// Saved callable helpers in a site pack: list, run a Node tool, or enable/disable code after
// reviewing it. Page tools run in the page (site.pageTools), so the CLI only lists/enables them.
async function siteTools(args: Args): Promise<number> {
  const action = args.positional[1] ?? "list";
  const site = args.positional[2];
  if (!site) throw new Error("Usage: browserkit site tools <list|run|enable|disable> <site>");
  if (action === "list") {
    const listed = await listSiteTools(site);
    if (has(args, "json")) {
      printJson({ site, ...listed });
      return 0;
    }
    for (const kind of ["tools", "pageTools"] as const)
      for (const tool of listed[kind])
        out(
          `${kind === "tools" ? "tool" : "page"}\t${tool.enabled ? "enabled" : "DISABLED"}\t${tool.name}\t${tool.params.map((param) => param.name).join(",")}\t${tool.description ?? ""}`,
        );
    if (!listed.tools.length && !listed.pageTools.length) out(`${site} has no saved tools.`);
    return 0;
  }
  if (action === "run") {
    const name = args.positional[3];
    if (!name) throw new Error("Usage: browserkit site tools run <site> <name> --params '<json>'");
    const value = await runSiteTool(site, name, paramsOf(args));
    printJson({ site, name, value });
    return 0;
  }
  if (action === "enable" || action === "disable") {
    const name = args.positional[3];
    const changed = await setSiteToolsEnabled(site, "all", name, action === "enable");
    if (has(args, "json")) printJson({ site, changed, enabled: action === "enable" });
    else out(`${action === "enable" ? "Enabled" : "Disabled"} ${changed} tool(s) for ${site}.`);
    return 0;
  }
  throw new Error("Usage: browserkit site tools <list|run|enable|disable> <site>");
}

function paramsOf(args: Args): Record<string, unknown> {
  const raw = flag(args, "params");
  if (!raw) return {};
  const value = JSON.parse(raw) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("--params must be a JSON object");
  return value as Record<string, unknown>;
}

export const siteToolsCommand: Command = {
  name: "site",
  group: "Use a site",
  hidden: true,
  summary: "saved site tools, page tools and their code",
  help: `Usage: browserkit site tools <action> <site> [name] [--params '<json>'] [--json]

Actions:
  list <site>             tools and page tools, enabled or disabled
  run <site> <name>       run a Node tool with --params (page tools run in browser code)
  enable <site> [name]    enable all tools, or one after reviewing its code
  disable <site> [name]   disable all tools, or one
Imported packs save tools DISABLED because they are code; enabling trusts them.`,
  run: siteTools,
};

export async function readToolsCode(
  site: string,
): Promise<{ kind: "tool" | "pageTool"; name: string; code: string }[]> {
  const file = await readSiteTools(site);
  return [
    ...file.tools.map((tool) => ({ kind: "tool" as const, name: tool.name, code: tool.code })),
    ...file.pageTools.map((tool) => ({
      kind: "pageTool" as const,
      name: tool.name,
      code: tool.code,
    })),
  ];
}
