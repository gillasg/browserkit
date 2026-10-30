import { createInterface } from "node:readline";
import { BridgeClient } from "./client.js";
import { browserCodeDescription } from "./guidance.js";
import { formatResult } from "./format.js";
import { spillText } from "./spill.js";
import { callWebTool, webTools } from "./web-tools.js";
import {
  browserActionCode,
  browserActionDescription,
  browserActionSchema,
} from "@browserkit/tools/action";
import {
  browserContextCode,
  browserContextDescription,
  browserContextSchema,
} from "@browserkit/tools/context";

// A stdio MCP server (JSON-RPC 2.0, one message per line) exposing the browser to any MCP client.
type Json = Record<string, unknown>;
const tools = [
  {
    name: "browser_code",
    description: browserCodeDescription,
    inputSchema: {
      type: "object",
      properties: {
        code: {
          type: "string",
          description: "JavaScript to run; the last expression is returned.",
        },
        session: {
          type: "string",
          description:
            "Optional REPL session name; cells in the same session share variables and tabs.",
        },
        timeoutMs: { type: "integer", minimum: 1000, maximum: 600000 },
      },
      required: ["code"],
      additionalProperties: false,
    },
  },
  {
    name: "browser_tabs",
    description:
      "List the open tabs of the connected browser, with the target to pass to browser.attachTab().",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "browser_context",
    description: browserContextDescription,
    inputSchema: browserContextSchema,
  },
  {
    name: "browser_action",
    description: browserActionDescription,
    inputSchema: browserActionSchema,
  },
];

export async function runMcpServer(): Promise<void> {
  let client: BridgeClient | undefined;
  const bridge = async () => (client ??= await BridgeClient.connect());
  const lines = createInterface({ input: process.stdin });
  for await (const line of lines) {
    if (!line.trim()) continue;
    let message: Json;
    try {
      message = JSON.parse(line) as Json;
    } catch {
      continue;
    }
    if (message.id === undefined) continue;
    void handle(message, bridge).then(
      (result) => write({ jsonrpc: "2.0", id: message.id, result }),
      (error: unknown) =>
        write({
          jsonrpc: "2.0",
          id: message.id,
          error: { code: -32603, message: error instanceof Error ? error.message : String(error) },
        }),
    );
  }
  client?.close();
}

async function handle(message: Json, bridge: () => Promise<BridgeClient>): Promise<unknown> {
  const params = (message.params ?? {}) as Json;
  if (message.method === "initialize")
    return {
      protocolVersion:
        typeof params.protocolVersion === "string" ? params.protocolVersion : "2025-06-18",
      capabilities: { tools: {} },
      serverInfo: { name: "browserkit", version: "0.1.0" },
    };
  if (message.method === "ping") return {};
  if (message.method === "tools/list") return { tools: [...tools, ...webTools] };
  if (message.method !== "tools/call")
    throw new Error(`Unsupported method: ${String(message.method)}`);
  const args = (params.arguments ?? {}) as Json;
  const web = await callWebTool(params.name, args);
  if (web) return web;
  const client = await bridge();
  if (params.name === "browser_tabs") {
    const reply = await client.request("tabs");
    return { content: [{ type: "text", text: JSON.stringify(reply.tabs ?? [], null, 2) }] };
  }
  if (params.name === "browser_context") {
    const result = await client.request("run", {
      code: browserContextCode(args as never),
      session: typeof args.session === "string" ? args.session : "mcp",
    });
    return {
      content: [{ type: "text", text: formatResult(result).text }],
      isError: Boolean(result.error),
    };
  }
  if (params.name === "browser_action") {
    const code = browserActionCode(args as never);
    const session = typeof args.session === "string" ? args.session : "mcp";
    const timeoutMs = typeof args.timeoutMs === "number" ? args.timeoutMs : undefined;
    const result = await client.request("run", {
      code,
      session,
      ...(timeoutMs ? { timeoutMs } : {}),
    });
    const where = await client.request("run", {
      code: "typeof page !== 'undefined' && page ? { title: await page.title(), url: page.url() } : null",
      session,
      ...(timeoutMs ? { timeoutMs } : {}),
    });
    const formatted = formatResult(result);
    const text = await spillText(formatted.text, session);
    const place = where.error ? null : (where.value as Json | null);
    return {
      content: [
        { type: "text", text },
        ...(place ? [{ type: "text", text: JSON.stringify(place) }] : []),
        ...formatted.images.map((image) => ({
          type: "image",
          data: image.data,
          mimeType: image.mimeType,
        })),
      ],
      isError: Boolean(result.error),
    };
  }
  if (params.name !== "browser_code") throw new Error(`Unknown tool: ${String(params.name)}`);
  const session = typeof args.session === "string" ? args.session : "mcp";
  const result = await client.request("run", {
    code: String(args.code ?? ""),
    session,
    ...(typeof args.timeoutMs === "number" ? { timeoutMs: args.timeoutMs } : {}),
  });
  const formatted = formatResult(result);
  const text = await spillText(formatted.text, session);
  return {
    content: [
      { type: "text", text },
      ...formatted.images.map((image) => ({
        type: "image",
        data: image.data,
        mimeType: image.mimeType,
      })),
    ],
    isError: Boolean(result.error),
  };
}

function write(message: unknown): void {
  process.stdout.write(JSON.stringify(message) + "\n");
}
