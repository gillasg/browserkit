import { sharedBridge, type Bridge } from "../bridge.js";
import { passGate } from "./gate.js";
import type { Action, ScrapeOptions } from "../types.js";
import type { Fetched, Fetcher } from "./types.js";
import { flattenedHtml } from "./flatten.js";

// The user's own browser, through browserkit: their logins, a real fingerprint,
// JavaScript rendering, actions, scrolling, screenshots and PDFs. Each worker has its own
// session and tab, so pages load in parallel; a page that asks the user to sign in or verify
// waits for them (only that worker).

export interface BrowserOutputs {
  screenshot?: boolean;
  pdf?: boolean;
  mhtml?: boolean;
  pageData?: boolean;
}

function actionCode(action: Action): string {
  const s = JSON.stringify;
  switch (action.type) {
    case "click":
      return `await tab.locator(${s(action.selector)}).first().click();`;
    case "write":
      return `await tab.fill(${s(action.selector)}, ${s(action.text)});`;
    case "press":
      return `await tab.keyboard.press(${s(action.key)});`;
    case "scroll":
      return `await tab.scroll(${s(action.direction ?? "down")}, ${action.amount ?? 1200});`;
    case "wait":
      return action.selector
        ? `await tab.waitForSelector(${s(action.selector)});`
        : `await new Promise((r) => setTimeout(r, ${action.ms ?? 1000}));`;
    case "js":
      return `await tab.evaluate(${s(action.code)});`;
    case "screenshot":
      return `out.actionShots.push((await tab.cdp('Page.captureScreenshot', { format: 'png', captureBeyondViewport: ${!!action.fullPage} })).data);`;
  }
}

/** One-time tab settings: blocked resources, language, location, mobile. */
function setupCode(options: ScrapeOptions): string {
  const lines: string[] = [];
  const block = options.blockResources ?? [];
  if (block.length)
    lines.push(
      `await tab.rules.block({ images: ${block.includes("image")}, media: ${block.includes("media")}, fonts: ${block.includes("font")} });`,
    );
  if (options.language)
    lines.push(
      `await tab.rules.headers({ 'Accept-Language': ${JSON.stringify(options.language)} });`,
    );
  if (options.location)
    lines.push(
      `await tab.setLocation(${options.location.latitude}, ${options.location.longitude});`,
    );
  if (options.mobile) lines.push(`await tab.emulate({ device: 'iPhone' });`);
  if (options.headers && Object.keys(options.headers).length)
    lines.push(`await tab.rules.headers(${JSON.stringify(options.headers)});`);
  return lines.join("\n");
}

const EXPAND = `await tab.evaluate(() => {
  const words = /^(show|see|read|load|view) (more|all)|^more$|^expand|^continue reading/i;
  for (const el of [...document.querySelectorAll('button, [role=button], summary, a')].slice(0, 400))
    if (words.test((el.innerText || '').trim()) && !el.closest('nav, header, footer')) { try { el.click(); } catch {} }
  for (const d of document.querySelectorAll('details:not([open])')) d.open = true;
});
await new Promise((r) => setTimeout(r, 600));`;

const NETWORK_IDLE = `for (let quiet = 0, last = -1, i = 0; quiet < 3 && i < 40; i++) {
  const n = await tab.inspect(() => performance.getEntriesByType('resource').length);
  quiet = n === last ? quiet + 1 : 0; last = n;
  await new Promise((r) => setTimeout(r, 250));
}`;

const LOGIN_WALL = `await tab.inspect(() => {
  const password = !!document.querySelector('input[type=password]');
  const text = (document.body?.innerText || '').slice(0, 3000);
  return (password && /sign in|log in|login|password/i.test(text)) || /verify (it's|that) you|are you a robot|two-factor|2-step|enter the code/i.test(text);
})`;

function scrollCode(scroll: ScrapeOptions["scroll"]): string {
  if (scroll === "infinite") return "await tab.scrollToEnd({ maxSteps: 40 });";
  if (typeof scroll === "number")
    return `for (let i = 0; i < ${scroll}; i++) await tab.scroll('down', 1600);`;
  return "";
}

function captureCode(outputs: BrowserOutputs): string {
  const lines = [
    `out.html = await tab.inspect(${flattenedHtml.toString()});`,
    "out.finalUrl = await tab.inspect(() => location.href);",
    "out.status = (await tab.status()) ?? 200;",
    "out.contentType = await tab.inspect(() => document.contentType);",
  ];
  if (outputs.pageData)
    lines.push(
      "out.pageData = await tab.data();",
      // Wait until the page's own requests settle: no new ones and none still waiting for a response.
      "for (let quiet = 0, last = -1, i = 0; quiet < 2 && i < 16; i++) { const list = await tab.network.list({}); const n = list.length + 1000 * list.filter((c) => !c.status).length; quiet = n === last && n < 1000 ? quiet + 1 : 0; last = n; await new Promise((r) => setTimeout(r, 250)); }",
      "const calls = (await tab.network.list({})).filter((c) => c.json && c.status < 400).slice(-15);",
      "out.pageData.requests = [];",
      // A body can still be arriving when the page looks done: give each a moment.
      "for (const c of calls) { let json; for (let i = 0; i < 10 && json === undefined; i++) { try { json = await tab.network.body(c.id); } catch {} if (json === undefined) await new Promise((r) => setTimeout(r, 200)); } if (json !== undefined) out.pageData.requests.push({ url: c.url, method: c.method, json }); }",
    );
  if (outputs.screenshot)
    lines.push(
      "out.screenshot = (await tab.cdp('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true })).data;",
    );
  if (outputs.pdf)
    lines.push("out.pdf = (await tab.cdp('Page.printToPDF', { printBackground: true })).data;");
  if (outputs.mhtml)
    lines.push("out.mhtml = (await tab.cdp('Page.captureSnapshot', { format: 'mhtml' })).data;");
  return lines.join("\n");
}

/** The browser code for one page fetch in a worker's session. */
export function pageCode(url: string, options: ScrapeOptions, outputs: BrowserOutputs): string {
  const target = JSON.stringify(url);
  const wait = options.waitUntil === "networkidle" ? NETWORK_IDLE : "";
  const waitFor = options.waitFor
    ? `await tab.waitForSelector(${JSON.stringify(options.waitFor)});`
    : "";
  // Only this worker waits for the user, and not forever: after the limit the page is kept as is.
  const limit = options.handoffTimeoutMs ?? 300_000;
  const handoff =
    options.handoff === false
      ? ""
      : `if (${LOGIN_WALL}) { await bu.use(tab.target); const done = await Promise.race([bu.handoff('Sign in or verify so the crawl can continue, then click Done.').then(() => true, () => false), new Promise((r) => setTimeout(() => r(false), ${limit}))]); if (done) await tab.navigate(${target}); }`;
  return `const out = { actionShots: [] };
let tab = globalThis.__crawlTab;
if (!tab) {
  tab = await browser.openTab(${target}, { new: true });
  globalThis.__crawlTab = tab;
  ${setupCode(options)}
  await tab.network.start({});
  await tab.navigate(${target});
} else {
  await tab.network.clear();
  await tab.navigate(${target});
}
${handoff}
${wait}
${waitFor}
${options.expand ? EXPAND : ""}
${scrollCode(options.scroll)}
${(options.actions ?? []).map(actionCode).join("\n")}
${captureCode(outputs)}
out`;
}

interface Captured {
  html: string;
  finalUrl: string;
  status: number;
  contentType: string;
  pageData?: Record<string, unknown>;
  screenshot?: string;
  pdf?: string;
  mhtml?: string;
  actionShots: string[];
}

function outputsFor(options: ScrapeOptions): BrowserOutputs {
  const formats = options.formats ?? [];
  return {
    pageData: true,
    screenshot: formats.includes("screenshot"),
    pdf: formats.includes("pdf"),
    mhtml: formats.includes("mhtml"),
  };
}

export class BrowserFetcher implements Fetcher {
  readonly name = "browser" as const;
  private readonly free: string[] = [];
  private readonly waiting: ((session: string) => void)[] = [];

  constructor(
    workers = 3,
    private readonly bridge: () => Promise<Bridge> = sharedBridge,
    prefix = "browser-crawl",
  ) {
    for (let i = 0; i < workers; i++) this.free.push(`${prefix}-${i + 1}`);
  }

  private async acquire(): Promise<string> {
    const session = this.free.shift();
    if (session) return session;
    return new Promise((resolve) => this.waiting.push(resolve));
  }

  private release(session: string): void {
    const next = this.waiting.shift();
    if (next) next(session);
    else this.free.push(session);
  }

  async fetch(url: string, options: ScrapeOptions): Promise<Fetched> {
    await passGate(url);
    const session = await this.acquire();
    try {
      const bridge = await this.bridge();
      const captured = (await bridge.run(pageCode(url, options, outputsFor(options)), {
        session,
        timeoutMs: options.timeoutMs ?? 90_000,
      })) as Captured;
      const fetched: Fetched = {
        url,
        finalUrl: captured.finalUrl,
        status: captured.status,
        headers: {},
        contentType: captured.contentType || "text/html",
        body: Buffer.from(captured.html ?? ""),
        fetchedBy: "browser",
        html: captured.html,
      };
      if (captured.pageData) fetched.pageData = captured.pageData;
      for (const key of ["screenshot", "pdf", "mhtml"] as const)
        if (captured[key]) fetched[key] = captured[key];
      if (captured.actionShots?.length)
        fetched.pageData = { ...(fetched.pageData ?? {}), actionScreenshots: captured.actionShots };
      return fetched;
    } finally {
      this.release(session);
    }
  }

  /** Closes every worker's tab. */
  async close(): Promise<void> {
    const bridge = await this.bridge().catch(() => undefined);
    if (!bridge) return;
    for (const session of [...this.free])
      await bridge
        .run(
          "if (globalThis.__crawlTab) { await globalThis.__crawlTab.close(); globalThis.__crawlTab = undefined; } true",
          { session },
        )
        .catch(() => undefined);
  }
}
