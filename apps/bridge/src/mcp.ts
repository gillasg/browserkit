import { createInterface } from "node:readline";
import { BridgeClient } from "./client.js";
import { browserCodeDescription } from "./guidance.js";
import { formatResult } from "./format.js";
import { callWebTool, webTools } from "./web-tools.js";

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
    name: "browser_action",
    description:
      'One browser action without writing code: navigate, click, type, press, scroll, wait, extract, screenshot, evaluate, back, forward, reload or tabs. Use browser_code for anything that needs several steps or its own logic; this tool does not replace it. Example: {"action":"click","selector":"button[type=submit]"}. Returns the page title and URL after the action, plus the read text or the saved screenshot.',
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: [
            "navigate",
            "click",
            "type",
            "press",
            "scroll",
            "wait",
            "extract",
            "screenshot",
            "evaluate",
            "back",
            "forward",
            "reload",
            "tabs",
          ],
          description: "What to do.",
        },
        url: { type: "string", description: "For navigate: the page to open." },
        selector: {
          type: "string",
          description:
            "For click, type, press, wait, extract and screenshot: a CSS selector (or text=label).",
        },
        text: {
          type: "string",
          description: "For type: the text to enter. For press: a key name. For scroll: pixels.",
        },
        code: { type: "string", description: "For evaluate: JavaScript to run in the page." },
        tab: { type: "integer", description: "Optional tab id from browser_tabs." },
        session: { type: "string", description: "Optional REPL session name." },
        timeoutMs: { type: "integer", minimum: 1000, maximum: 600000 },
      },
      required: ["action"],
      additionalProperties: false,
    },
  },
];

function actionCode(args: Json): string {
  const action = String(args.action ?? "");
  const selector = args.selector === undefined ? "" : String(args.selector);
  const text = args.text === undefined ? "" : String(args.text);
  const choose =
    args.tab === undefined ? "" : `page = await browser.getTab(${Number(args.tab)});\n`;
  const target = selector ? `page.locator(${JSON.stringify(selector)})` : "page";
  switch (action) {
    case "navigate":
      if (!args.url) throw new Error("navigate needs url");
      return `page = await browser.openTab(${JSON.stringify(String(args.url))});`;
    case "click":
      if (!selector) throw new Error("click needs selector");
      return `${choose}await page.locator(${JSON.stringify(selector)}).first().click();`;
    case "type":
      if (!selector) throw new Error("type needs selector");
      return `${choose}await page.locator(${JSON.stringify(selector)}).first().fill(${JSON.stringify(text)});`;
    case "press":
      if (!text) throw new Error("press needs text (a key name)");
      return `${choose}await page.keyboard.press(${JSON.stringify(text)});`;
    case "scroll":
      return `${choose}await page.scroll({ deltaY: ${Number(text) || 600} });`;
    case "wait":
      return `${choose}${selector ? `await page.locator(${JSON.stringify(selector)}).first().waitFor({ timeout: ${Number(args.timeoutMs) || 20000} });` : `await page.waitForTimeout(${Number(text) || 1000});`}`;
    case "extract":
      return `${choose}const values = await page.locator(${JSON.stringify(selector || "body")}).allTextContents();\nvalues.map((item) => item.trim()).filter(Boolean)`;
    case "screenshot":
      return `${choose}const shot = await page.screenshot({ fullPage: true });\nawait artifact("browser-action.png", shot);\n"saved browser-action.png";`;
    case "evaluate":
      if (!args.code) throw new Error("evaluate needs code");
      return `${choose}await page.evaluate(${JSON.stringify(String(args.code))});`;
    case "back":
      return `${choose}await page.goBack();`;
    case "forward":
      return `${choose}await page.goForward();`;
    case "reload":
      return `${choose}await page.reload();`;
    case "tabs":
      return "browser.tabs().then((tabs) => tabs.map((tab) => ({ id: tab.id, title: tab.title, url: tab.url, mine: tab.mine })))";
    default:
      throw new Error(`unknown action: ${action}`);
  }
}

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
  if (params.name === "browser_action") {
    const code = actionCode(args);
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
    const place = where.error ? null : (where.value as Json | null);
    return {
      content: [
        { type: "text", text: formatted.text },
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
  const result = await client.request("run", {
    code: String(args.code ?? ""),
    session: typeof args.session === "string" ? args.session : "mcp",
    ...(typeof args.timeoutMs === "number" ? { timeoutMs: args.timeoutMs } : {}),
  });
  const formatted = formatResult(result);
  return {
    content: [
      { type: "text", text: formatted.text },
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
