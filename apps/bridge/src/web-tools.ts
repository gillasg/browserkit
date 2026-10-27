import { join } from "node:path";
import {
  AGENT_CRAWL_ACTIONS,
  AGENT_SITE_MAPPER_ACTIONS,
  crawlTool,
  HOW_TO_CALL,
  siteMapperTool,
  toolSchema,
  type AgentToolContext,
  type AgentToolDefinition,
  type CrawlToolInput,
  type SiteMapperToolInput,
} from "@browserkit/tools/definitions";
import { SITE_TOOL_HELP } from "@browserkit/tools/site-to-api";
import { dataDirectory } from "./paths.js";

// browserkit's MCP tools are built from the same definitions Aeon uses. The host only chooses
// which actions are exposed and where mapped-site captures live.

type Json = Record<string, unknown>;
const MAX_TEXT = 60_000;

function mcpTool(
  definition: AgentToolDefinition<Record<string, unknown>>,
  actions: readonly string[],
  description = definition.description,
) {
  return {
    name: definition.name,
    description,
    inputSchema: toolSchema(definition, actions),
  };
}

export const webTools = [
  mcpTool(crawlTool, AGENT_CRAWL_ACTIONS),
  mcpTool(
    siteMapperTool,
    AGENT_SITE_MAPPER_ACTIONS,
    `${siteMapperTool.description} ${SITE_TOOL_HELP.join(" ")} ${HOW_TO_CALL}`,
  ),
];

const text = (value: unknown): string => {
  const out = typeof value === "string" ? value : JSON.stringify(value, null, 1);
  return out.length > MAX_TEXT
    ? `${out.slice(0, MAX_TEXT)}\n[... ${out.length - MAX_TEXT} more characters clipped]`
    : out;
};

/** Runs crawl or site_mapper; undefined when the tool is neither. */
export async function callWebTool(name: unknown, args: Json): Promise<unknown> {
  const definition =
    name === "crawl" ? crawlTool : name === "site_mapper" ? siteMapperTool : undefined;
  if (!definition) return undefined;
  const context: AgentToolContext = {
    ...(name === "site_mapper" ? { workspace: join(dataDirectory(), "workspaces", "mcp") } : {}),
  };
  try {
    const value =
      name === "crawl"
        ? await crawlTool.run(args as CrawlToolInput, context)
        : await siteMapperTool.run(args as SiteMapperToolInput, context);
    return { content: [{ type: "text", text: text(value) }] };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
  }
}
