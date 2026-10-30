import { sharedBridge, type Bridge } from "./runtime/bridge.js";

// Recording in the user's own browser: open a tab (or take one they already have), capture
// every request with headers, bodies and initiators while they use the site, then hand back
// a HAR plus the page's web storage (to trace tokens kept there).
//
// Passive mode watches every tab on chosen domains instead of one tab.

export interface Recording {
  har: { log: { entries: unknown[] } };
  storage?: { localStorage?: Record<string, string>; sessionStorage?: Record<string, string> };
  startUrl: string;
}

export interface RecordOptions {
  url: string;
  /** Record a tab the user already has open (a tab id, or text matching its title or URL). */
  attach?: string | number;
  bridge?: () => Promise<Bridge>;
  /** Bring the tab to the front so the user can use it. Default true. */
  foreground?: boolean;
  /** No popunders, autoplay or ad hosts while recording (explore defaults to this). */
  quiet?: boolean;
  session?: string;
  /** Block requests that would change something (they are recorded, not sent): map actions safely. */
  dryRun?: boolean;
}

const SESSION = "site-to-api-record";
// A browser call carries at most ~3.5 MB of result, so a recording is read back in pieces: a
// full HAR (response bodies included) is routinely larger than one call allows. Half a million
// characters stays well inside the limit even when every one of them needs escaping.
const CHUNK_CHARS = 500_000;

function mergeHars(hars: Recording["har"][]): Recording["har"] {
  return { log: { entries: hars.flatMap((har) => har?.log?.entries ?? []) } } as Recording["har"];
}

/** Reads a string the browser kept in a global, a piece per call, so no cell result is oversized. */
async function readInChunks(
  bridge: Bridge,
  session: string,
  variable: string,
  timeoutMs: number,
): Promise<string> {
  const length = (await bridge.run(`${variable}?.length`, { session, timeoutMs })) as
    number | undefined;
  if (typeof length !== "number" || length < 0)
    throw new Error("The browser could not read the recording back.");
  let text = "";
  while (text.length < length) {
    const from = text.length;
    const part = (await bridge.run(`${variable}.slice(${from}, ${from + CHUNK_CHARS})`, {
      session,
      timeoutMs,
    })) as string;
    if (typeof part !== "string" || part.length === 0)
      throw new Error("The browser stopped sending the recording.");
    text += part;
  }
  await bridge.run(`${variable} = undefined; 0`, { session }).catch(() => undefined);
  return text;
}

async function countRequests(bridge: Bridge, session: string): Promise<number> {
  const count = await bridge
    .run(
      `let __n = 0;
for (const tab of globalThis.__recTabs || []) { try { __n += (await tab.network.list()).length; } catch {} }
__n`,
      { session },
    )
    .catch(() => 0);
  return typeof count === "number" ? count : 0;
}

export class RecordingSession {
  private constructor(
    private readonly bridge: Bridge,
    private readonly session: string,
    readonly startUrl: string,
    private readonly opened: boolean,
  ) {}

  static async start(options: RecordOptions): Promise<RecordingSession> {
    const bridge = await (options.bridge ?? sharedBridge)();
    const session = options.session ?? SESSION;
    const foreground = options.foreground !== false;
    if (options.attach !== undefined) {
      const which = JSON.stringify(options.attach);
      await bridge.run(
        `const __match = ${which};
const __tabs = typeof __match === 'number' ? [{ tabId: __match }] : await browser.tabs(__match);
if (!__tabs.length) throw new Error('No open tab matches ' + __match);
globalThis.__recTabs = [await browser.attachTab(__tabs[0].tabId)];
await globalThis.__recTabs[0].network.start({ types: 'all'${options.dryRun ? ", dryRun: true" : ""} });
'recording'`,
        { session },
      );
      return new RecordingSession(bridge, session, options.url, false);
    }
    await bridge.run(
      // Tabs open on web pages only, so the first load happens before recording starts and
      // the page is loaded again once it has.
      `globalThis.__recTabs = [await browser.openTab(${JSON.stringify(options.url)}, { foreground: ${foreground}, new: true${options.quiet ? ", quiet: true" : ""}, present: false })];
await globalThis.__recTabs[0].network.start({ types: 'all'${options.dryRun ? ", dryRun: true" : ""} });
await globalThis.__recTabs[0].navigate(${JSON.stringify(options.url)});
'recording'`,
      { session },
    );
    return new RecordingSession(bridge, session, options.url, true);
  }

  /** Runs browser code against the recorded tab (`page` is that tab). */
  run(code: string, timeoutMs = 120_000): Promise<unknown> {
    return this.bridge.run(`page = globalThis.__recTabs[0];\n${code}`, {
      session: this.session,
      timeoutMs,
    });
  }

  /** Requests recorded so far, so a caller can stop once the site goes quiet. */
  requestCount(): Promise<number> {
    return countRequests(this.bridge, this.session);
  }

  /** Tabs this recording still has, so a failure can say which ones it left behind. */
  async tabIds(): Promise<number[]> {
    return (await this.bridge
      .run(`(globalThis.__recTabs || []).map((tab) => tab.target.tabId)`, {
        session: this.session,
      })
      .catch(() => [])) as number[];
  }

  async stop(options: { close?: boolean } = {}): Promise<Recording> {
    await this.bridge.run(
      `const __out = { hars: [], storage: undefined };
for (const tab of globalThis.__recTabs || []) {
  try { __out.hars.push(await tab.network.har()); } catch {}
  if (!__out.storage) { try { __out.storage = await tab.inspect(() => ({ localStorage: Object.fromEntries(Object.entries(localStorage)), sessionStorage: Object.fromEntries(Object.entries(sessionStorage)) })); } catch {} }
  try { await tab.network.stop(); } catch {}
  ${options.close !== false && this.opened ? "try { await tab.close(); } catch {}" : ""}
}
globalThis.__recTabs = [];
globalThis.__recStop = JSON.stringify(__out);
globalThis.__recStop.length`,
      { session: this.session, timeoutMs: 180_000 },
    );
    const text = await readInChunks(this.bridge, this.session, "globalThis.__recStop", 180_000);
    const result = JSON.parse(text) as { hars: Recording["har"][]; storage?: Recording["storage"] };
    const recording: Recording = { har: mergeHars(result.hars), startUrl: this.startUrl };
    if (result.storage) recording.storage = result.storage;
    return recording;
  }
}

/** Watches every tab on the given domains, recording each as it appears. */
export class PassiveRecorder {
  private timer: ReturnType<typeof setInterval> | undefined;

  private constructor(
    private readonly bridge: Bridge,
    private readonly domains: string[],
  ) {}

  static async start(
    domains: string[],
    bridge: () => Promise<Bridge> = sharedBridge,
  ): Promise<PassiveRecorder> {
    const recorder = new PassiveRecorder(await bridge(), domains);
    await recorder.sweep();
    recorder.timer = setInterval(() => void recorder.sweep().catch(() => undefined), 3000);
    return recorder;
  }

  private sweep(): Promise<unknown> {
    return this.bridge.run(
      `const __domains = ${JSON.stringify(this.domains)};
globalThis.__recTabs ??= [];
globalThis.__recIds ??= new Set();
for (const tab of await browser.tabs()) {
  let host = '';
  try { host = new URL(tab.url).hostname; } catch { continue; }
  if (!__domains.some((d) => host === d || host.endsWith('.' + d)) || __recIds.has(tab.tabId)) continue;
  try { const page = await browser.attachTab(tab.tabId); await page.network.start({ types: 'all' }); __recTabs.push(page); __recIds.add(tab.tabId); } catch {}
}
__recTabs.length`,
      { session: SESSION + "-passive" },
    );
  }

  /** Requests recorded so far across every watched tab. */
  requestCount(): Promise<number> {
    return countRequests(this.bridge, SESSION + "-passive");
  }

  async stop(): Promise<Recording> {
    if (this.timer) clearInterval(this.timer);
    await this.bridge.run(
      `const __hars = [];
for (const tab of globalThis.__recTabs || []) { try { __hars.push(await tab.network.har()); await tab.network.stop(); } catch {} }
globalThis.__recTabs = []; globalThis.__recIds = new Set();
globalThis.__recStop = JSON.stringify(__hars);
globalThis.__recStop.length`,
      { session: SESSION + "-passive", timeoutMs: 180_000 },
    );
    const text = await readInChunks(
      this.bridge,
      SESSION + "-passive",
      "globalThis.__recStop",
      180_000,
    );
    return {
      har: mergeHars(JSON.parse(text) as Recording["har"][]),
      startUrl: `https://${this.domains[0] ?? ""}/`,
    };
  }
}
