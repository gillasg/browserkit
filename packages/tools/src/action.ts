// One browser action, as browser_code for clients that prefer discrete calls. Both MCP servers
// build the same cell from this, so an action means the same thing in browserkit and Aeon.

export interface BrowserActionInput {
  action: string;
  url?: string;
  selector?: string;
  text?: string;
  code?: string;
  tab?: number;
  session?: string;
  timeoutMs?: number;
}

/** The browser_code cell for one action; throws for an action that needs a missing field. */
export function browserActionCode(input: BrowserActionInput): string {
  const action = String(input.action ?? "");
  const selector = input.selector === undefined ? "" : String(input.selector);
  const text = input.text === undefined ? "" : String(input.text);
  const choose =
    input.tab === undefined ? "" : `page = await browser.getTab(${Number(input.tab)});\n`;
  switch (action) {
    case "navigate":
      if (!input.url) throw new Error("navigate needs url");
      return `page = await browser.openTab(${JSON.stringify(String(input.url))});`;
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
      return `${choose}${
        selector
          ? `await page.locator(${JSON.stringify(selector)}).first().waitFor({ timeout: ${Number(input.timeoutMs) || 20000} });`
          : `await page.waitForTimeout(${Number(text) || 1000});`
      }`;
    case "extract":
      return `${choose}const values = await page.locator(${JSON.stringify(selector || "body")}).allTextContents();\nvalues.map((item) => item.trim()).filter(Boolean)`;
    case "screenshot":
      return `${choose}const shot = await page.screenshot({ fullPage: true });\nawait artifact("browser-action.png", shot);\n"saved browser-action.png";`;
    case "evaluate":
      if (!input.code) throw new Error("evaluate needs code");
      return `${choose}await page.evaluate(${JSON.stringify(String(input.code))});`;
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

/** The JSON schema both servers describe the tool with. */
export const browserActionSchema = {
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
} as const;

export const browserActionDescription =
  'One browser action without writing code: navigate, click, type, press, scroll, wait, extract, screenshot, evaluate, back, forward, reload or tabs. Use browser_code for anything that needs several steps or its own logic; this tool does not replace it. Example: {"action":"click","selector":"button[type=submit]"}. Returns the page title and URL after the action, plus the read text or the saved screenshot.';
