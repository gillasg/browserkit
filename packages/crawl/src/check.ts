import { sharedBridge } from "./bridge.js";
import { botCheck, isDnsFailure, isNetworkRefusal } from "./challenge.js";

// Which of many sites load, with evidence for every verdict. Plain HTTP answers first (fast,
// many at once); anything it cannot settle (a refused connection, a bot check, 401/403/429/503, a
// timeout) is asked again through the user's Chrome, whose network stack, IP and cookies are what
// the user actually gets. A few plain-HTTP successes are re-checked in Chrome too, and the
// disagreement is reported, so a wrong rule shows up before anyone trusts the numbers.

export type SiteVerdict =
  | "ok"
  | "js-shell"
  | "challenge"
  | "login"
  | "blocked"
  | "rate-limited"
  | "server-error"
  | "not-found"
  | "parked"
  | "dead"
  | "refused"
  | "redirected"
  | "origin-gated"
  | "unchecked";

export interface SiteCheck {
  url: string;
  host: string;
  verdict: SiteVerdict;
  via: "http" | "chrome";
  status?: number;
  finalUrl?: string;
  title?: string;
  /** The answer's content type, and the shape its body really is. */
  contentType?: string;
  shape?: PageShape;
  /** What `paths` found on this host, when paths were given. */
  paths?: PathProbe[];
  /** Why: the status, the bot-check vendor, the network error, or what made it parked. */
  reason?: string;
  /** What the page is, when a browser opened it: ready, empty, loading, login, challenge, not-found, error. */
  readiness?: {
    state: string;
    evidence: string[];
    textLength?: number;
  };
}

/** What a body really is: parsed JSON, a page, the site's catch-all page, nothing, or something else. */
export type PageShape =
  "json-object" | "json-array" | "html-page" | "catch-all" | "empty" | "other";

export interface PathProbe {
  path: string;
  url: string;
  status?: number;
  contentType?: string;
  shape: PageShape;
  /** Whether the answer is what `expect` asked for (a status under 400 when nothing was asked). */
  ok: boolean;
  bytes?: number;
  reason?: string;
}

export interface CheckOptions {
  concurrency?: number;
  timeoutMs?: number;
  /** Plain-HTTP successes re-checked in Chrome (default 5). */
  spotChecks?: number;
  /** Use the user's browser for what plain HTTP cannot settle (default true). */
  browser?: boolean;
  /** "http" never starts Chrome; auto (default) settles uncertain sites there. */
  via?: "auto" | "http";
  /** Extra paths to probe on every host, e.g. ["/api/x", "/stream.m3u8"]. */
  paths?: readonly string[];
  /** What those paths should answer: "json", "html", "m3u8", "xml", "text" or a content type. */
  expect?: string;
  /** Also open each site and report its typed readiness (needs the browser). */
  readiness?: boolean;
  onProgress?(done: number, total: number): void;
}

export interface CheckReport {
  results: SiteCheck[];
  counts: Partial<Record<SiteVerdict, number>>;
  spotCheck: { checked: number; disagreed: string[] };
  browserUsed: boolean;
  /** Pages loaded in Chrome, including spot checks. */
  chromePages: number;
  /** What the paths check found, when paths were given: one line per host. */
  paths?: { host: string; probes: PathProbe[]; ok: number; failed: number; expectation?: string }[];
}

interface Answer {
  status: number;
  finalUrl: string;
  headers: Record<string, string>;
  html: string;
}

const HEADERS = {
  "user-agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36",
  accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "accept-language": "en-US,en;q=0.9",
};
const BODY_LIMIT = 60_000;
const SETTLED: ReadonlySet<SiteVerdict> = new Set([
  "ok",
  "js-shell",
  "not-found",
  "parked",
  "dead",
  "server-error",
  "redirected",
  "origin-gated",
]);

export async function checkSites(
  inputs: readonly string[],
  options: CheckOptions = {},
): Promise<CheckReport> {
  const urls = [...new Set(inputs.map(siteUrl).filter((u): u is string => Boolean(u)))];
  let done = 0;
  const results = await mapLimit(urls, options.concurrency ?? 40, async (url) => {
    const result = await checkOverHttp(url, options.timeoutMs ?? 8000);
    options.onProgress?.(++done, urls.length);
    return result;
  });
  const browserUsed =
    options.via !== "http" && options.browser !== false && (await browserAvailable());
  const spotCheck = { checked: 0, disagreed: [] as string[] };
  let chromePages = 0;
  if (browserUsed) chromePages = await settleInChrome(results, options, spotCheck);
  else
    for (const result of results)
      if (!SETTLED.has(result.verdict)) {
        result.reason = `${result.reason ?? result.verdict}; not checked in Chrome (${options.via === "http" ? "via http" : "no browser"})`;
      }
  const paths = await probeEveryHost(results, options);
  await addReadinessIfAsked(results, options, browserUsed);
  return {
    results,
    counts: countVerdicts(results),
    spotCheck,
    browserUsed,
    chromePages,
    ...(paths.length ? { paths } : {}),
  };
}

async function addReadinessIfAsked(
  results: SiteCheck[],
  options: CheckOptions,
  browserUsed: boolean,
): Promise<void> {
  if (options.readiness !== true || !browserUsed) return;
  await addReadiness(results);
}

/**
 * Opens each site in its own tab and asks what the page is, then closes it. The check already
 * knows whether a site answers; readiness says whether the answer is a usable page, a sign-in
 * wall, a bot check, an empty shell or a not-found. Best effort: a site that will not open keeps
 * its verdict without readiness.
 */
async function addReadiness(results: SiteCheck[]): Promise<void> {
  if (!results.length) return;
  const bridge = await sharedBridge();
  const answers = (await bridge
    .run(readinessCode(results.map((result) => result.finalUrl ?? result.url)), {
      session: "browser-crawl-check",
      timeoutMs: 120_000,
    })
    .catch(() => [])) as ({ state?: string; evidence?: string[]; textLength?: number } | null)[];
  results.forEach((result, index) => {
    const answer = answers[index];
    if (!answer || typeof answer !== "object" || !answer.state) return;
    result.readiness = {
      state: String(answer.state),
      evidence: (answer.evidence ?? []).map((line) => String(line)).slice(0, 8),
      ...(answer.textLength === undefined ? {} : { textLength: Number(answer.textLength) }),
    };
  });
}

/** One cell that visits each URL, waits out loading, records readiness, and closes the tab. */
function readinessCode(urls: readonly string[]): string {
  return `(async () => {
  const urls = ${JSON.stringify(urls)};
  const answers = [];
  for (const url of urls) {
    try {
      await browser.openTab(url, { newTab: true, quiet: true });
      answers.push(await page.waitReady({ timeoutMs: 8000 }));
    } catch (error) {
      answers.push({ state: "error", evidence: [String((error && error.message) || error)] });
    }
    try { await page.close(); } catch {}
  }
  return answers;
})()`;
}

/**
 * `paths` probes on every host: the same paths asked of each site, so one that answers JSON where
 * another answers its HTML catch-all page is obvious. Plain HTTP only; fast and many at once.
 */
async function probeEveryHost(
  results: readonly SiteCheck[],
  options: CheckOptions,
): Promise<NonNullable<CheckReport["paths"]>> {
  const paths = (options.paths ?? [])
    .map((path) => String(path).trim())
    .filter(Boolean)
    .slice(0, 20);
  if (!paths.length) return [];
  const lines: NonNullable<CheckReport["paths"]> = await mapLimit(
    results,
    Math.min(options.concurrency ?? 40, 20),
    async (result) => {
      const probes = await probePaths(result.url, paths, options);
      result.paths = probes;
      const ok = probes.filter((probe) => probe.ok).length;
      return {
        host: result.host,
        probes,
        ok,
        failed: probes.length - ok,
        ...(options.expect ? { expectation: options.expect } : {}),
      };
    },
  );
  return lines;
}

async function probePaths(
  url: string,
  paths: readonly string[],
  options: CheckOptions,
): Promise<PathProbe[]> {
  const origin = new URL(url).origin;
  const timeoutMs = options.timeoutMs ?? 8000;
  const catchAll = await answersAnyPath(origin, timeoutMs);
  const probes: PathProbe[] = [];
  for (const path of paths)
    probes.push(await probePath(origin, path, catchAll, timeoutMs, options));
  return probes;
}

/** A site that answers a nonsense path with its HTML page has a catch-all: paths cannot be typed. */
async function answersAnyPath(origin: string, timeoutMs: number): Promise<boolean> {
  const probe = await get(`${origin}/__browserkit_missing_${Date.now()}`, timeoutMs);
  return Boolean(probe && probe.status === 200 && /html/i.test(probe.contentType));
}

async function probePath(
  origin: string,
  path: string,
  catchAll: boolean,
  timeoutMs: number,
  options: CheckOptions,
): Promise<PathProbe> {
  const target = new URL(path, origin).href;
  const answer = await get(target, timeoutMs);
  if (!answer)
    return {
      path,
      url: target,
      shape: "empty",
      ok: false,
      reason: "no answer (the name does not resolve, or the connection failed)",
    };
  const raw = shapeOf(answer.contentType, answer.body);
  const shape = raw === "html-page" && catchAll && answer.status === 200 ? "catch-all" : raw;
  const probe: PathProbe = {
    path,
    url: target,
    status: answer.status,
    contentType: answer.contentType,
    shape,
    ok: false,
    bytes: answer.body.length,
  };
  const expectation = expectationOf(options.expect, probe);
  probe.ok = expectation.ok;
  if (expectation.reason) probe.reason = expectation.reason;
  return probe;
}

interface Answer2 {
  status: number;
  contentType: string;
  body: string;
}

async function get(url: string, timeoutMs: number): Promise<Answer2 | undefined> {
  try {
    const response = await fetch(url, {
      headers: HEADERS,
      redirect: "follow",
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body = (await response.text()).slice(0, BODY_LIMIT);
    return {
      status: response.status,
      contentType: response.headers.get("content-type") ?? "",
      body,
    };
  } catch {
    return undefined;
  }
}

/** What a body really is: JSON parses (an object or an array), HTML, nothing, or other bytes. */
export function shapeOf(contentType: string, body: string): PageShape {
  const text = body.trim();
  if (!text) return "empty";
  if (/json/i.test(contentType) || text.startsWith("{") || text.startsWith("[")) {
    try {
      return Array.isArray(JSON.parse(text) as unknown) ? "json-array" : "json-object";
    } catch {
      // A broken or partial JSON body is not JSON.
    }
  }
  if (/html/i.test(contentType) || /^<(!doctype html|html[\s>])/i.test(text)) return "html-page";
  return "other";
}

/** Whether an answer is what `expect` asked for, and why not when it is not. */
export function expectationOf(
  expect: string | undefined,
  probe: PathProbe,
): { ok: boolean; reason?: string } {
  const failed = `HTTP ${probe.status ?? 0}`;
  if (!expect) {
    const ok = probe.status !== undefined && probe.status < 400;
    return ok ? { ok } : { ok, reason: failed };
  }
  if (expectationMatches(expect.toLowerCase(), probe)) return { ok: true };
  const got = `${probe.status !== undefined ? "HTTP " + probe.status + ", " : ""}${probe.contentType || "no content type"}, ${probe.shape}`;
  const catchAll =
    probe.shape === "catch-all"
      ? ` — the site answers any path with its HTML page (catch-all), so ${probe.path} is probably not an endpoint`
      : "";
  return { ok: false, reason: `expected ${expect}, got ${got}${catchAll}` };
}

function expectationMatches(expect: string, probe: PathProbe): boolean {
  const type = (probe.contentType ?? "").toLowerCase();
  if (expect === "json") return probe.shape === "json-object" || probe.shape === "json-array";
  if (expect === "json-array") return probe.shape === "json-array";
  if (expect === "json-object") return probe.shape === "json-object";
  if (expect === "html") return probe.shape === "html-page";
  if (expect === "text") return /^text\//.test(type);
  if (expect === "xml" || expect === "rss") return /xml/.test(type);
  return Boolean(type) && type.includes(expect);
}

/** "example.com", "https://example.com/x" → "https://example.com/x"; junk → undefined. */
export function siteUrl(input: string): string | undefined {
  const text = input.trim();
  if (!text) return undefined;
  try {
    const url = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`);
    return url.hostname.includes(".") ? url.href : undefined;
  } catch {
    return undefined;
  }
}

async function checkOverHttp(url: string, timeoutMs: number): Promise<SiteCheck> {
  const host = new URL(url).hostname;
  try {
    const response = await fetch(url, {
      headers: HEADERS,
      redirect: "follow",
      signal: AbortSignal.timeout(timeoutMs),
    });
    const html = (await response.text()).slice(0, BODY_LIMIT);
    const contentType = response.headers.get("content-type") ?? "";
    const answer = {
      status: response.status,
      finalUrl: response.url || url,
      headers: Object.fromEntries(response.headers),
      html,
    };
    return applyRedirect({
      url,
      host,
      via: "http",
      contentType,
      shape: shapeOf(contentType, html),
      ...judge(answer),
    });
  } catch (error) {
    if (isDnsFailure(error))
      return { url, host, via: "http", verdict: "dead", reason: "the name does not resolve" };
    const reason = isNetworkRefusal(error) ? networkReason(error) : String(error);
    return { url, host, via: "http", verdict: "refused", reason };
  }
}

function networkReason(error: unknown): string {
  const code = (error as { cause?: { code?: string } })?.cause?.code;
  return `plain HTTP failed (${code ?? String((error as Error)?.message ?? error)})`;
}

/** The verdict for one answer, with its evidence. */
export function judge(answer: Answer): Omit<SiteCheck, "url" | "host" | "via"> {
  const title = titleOf(answer.html);
  const base = { status: answer.status, finalUrl: answer.finalUrl, ...(title ? { title } : {}) };
  const vendor = botCheck(answer.headers, answer.html);
  if (vendor) return { ...base, verdict: "challenge", reason: `${vendor} bot check` };
  const byStatus = statusVerdict(answer.status);
  if (byStatus) return { ...base, verdict: byStatus, reason: `HTTP ${answer.status}` };
  if (isParked(answer.html, title))
    return { ...base, verdict: "parked", reason: "a parked or for-sale domain page" };
  if (readableText(answer.html).length < 200)
    return { ...base, verdict: "js-shell", reason: "little text until JavaScript runs" };
  return { ...base, verdict: "ok" };
}

function statusVerdict(status: number): SiteVerdict | undefined {
  if (status === 401 || status === 407) return "login";
  if (status === 403 || status === 451) return "blocked";
  if (status === 429) return "rate-limited";
  if (status === 404 || status === 410) return "not-found";
  if (status >= 500) return "server-error";
  if (status >= 400) return "blocked";
  return undefined;
}

function titleOf(html: string): string | undefined {
  const title = /<title[^>]*>([^<]*)<\/title>/i.exec(html)?.[1]?.replace(/\s+/g, " ").trim();
  return title || undefined;
}

function readableText(html: string): string {
  return html
    .replace(/<(script|style|noscript|template)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isParked(html: string, title: string | undefined): boolean {
  return /this domain (?:is|may be) for sale|domain parking|sedoparking|parkingcrew|bodis\.com|buy this domain/i.test(
    `${title ?? ""} ${html.slice(0, 20_000)}`,
  );
}

async function browserAvailable(): Promise<boolean> {
  try {
    const status = await (await sharedBridge()).status();
    return status.browsers > 0;
  } catch {
    return false;
  }
}

/** Asks Chrome about what plain HTTP left open, and about a sample of what it called fine. */
async function settleInChrome(
  results: SiteCheck[],
  options: CheckOptions,
  spotCheck: { checked: number; disagreed: string[] },
): Promise<number> {
  const open = results.filter((result) => !SETTLED.has(result.verdict));
  const fine = results.filter((result) => result.verdict === "ok");
  const sample = pick(fine, options.spotChecks ?? 5);
  const urls = [...open, ...sample].map((result) => result.url);
  const answers = await askChrome(urls);
  for (const result of open) {
    const answer = answers.get(result.url);
    if (answer) Object.assign(result, chromeVerdict(result, answer));
  }
  const gated = open.filter((result) => result.status === 401 || result.status === 403);
  if (gated.length) {
    const gatedAnswers = await askChrome(
      gated.map((result) => result.url),
      true,
    );
    for (const result of gated) {
      const answer = gatedAnswers.get(result.url);
      const verdict = answer ? originGated(result, answer) : undefined;
      if (verdict) Object.assign(result, verdict);
    }
  }
  for (const result of sample) {
    const answer = answers.get(result.url);
    if (!answer) continue;
    spotCheck.checked++;
    const again = chromeVerdict(result, answer);
    if (again.verdict !== "ok" && again.verdict !== "js-shell")
      spotCheck.disagreed.push(`${result.host}: http ok, chrome ${again.verdict}`);
  }
  return urls.length + gated.length;
}

type ChromeAnswer = Answer | { error: string };

function chromeVerdict(result: SiteCheck, answer: ChromeAnswer): Partial<SiteCheck> {
  if ("error" in answer) {
    if (/SITE_BLOCKED/.test(answer.error))
      return { verdict: "blocked", via: "chrome", reason: "the user blocked this site for agents" };
    return {
      verdict: "refused",
      via: "chrome",
      reason: `Chrome could not load it either (${answer.error})`,
    };
  }
  return applyRedirect({
    ...judge(answer),
    via: "chrome",
    url: result.url,
    host: result.host,
    contentType: answer.headers["content-type"] ?? "",
    shape: shapeOf(answer.headers["content-type"] ?? "", answer.html),
  });
}

/** A different host after redirects is evidence, unless it is only a www/apex variant. */
export function applyRedirect(result: SiteCheck): SiteCheck {
  if (!result.finalUrl) return result;
  const requested = normalizeHost(result.host);
  let finalHost: string;
  try {
    finalHost = new URL(result.finalUrl).hostname;
  } catch {
    return result;
  }
  const final = normalizeHost(finalHost);
  if (!requested || !final || requested === final) return result;
  return {
    ...result,
    verdict: "redirected",
    reason: `redirected to ${result.finalUrl}`,
  };
}

/** Plain HTTP 401/403, but Chrome with the site's own Referer/Origin succeeds. */
export function originGated(
  result: SiteCheck,
  answer: ChromeAnswer,
): Partial<SiteCheck> | undefined {
  if (result.status !== 401 && result.status !== 403) return undefined;
  if ("error" in answer || answer.status >= 400) return undefined;
  return {
    verdict: "origin-gated",
    via: "chrome",
    status: answer.status,
    finalUrl: answer.finalUrl,
    reason: `plain HTTP ${result.status}; a request with the site's Referer/Origin succeeds`,
  };
}

function normalizeHost(host: string): string {
  return host.toLowerCase().replace(/^www\./, "");
}

const BATCH = 4;

async function askChrome(
  urls: readonly string[],
  origin = false,
): Promise<Map<string, ChromeAnswer>> {
  const answers = new Map<string, ChromeAnswer>();
  if (!urls.length) return answers;
  const bridge = await sharedBridge();
  for (let index = 0; index < urls.length; index += BATCH) {
    const batch = urls.slice(index, index + BATCH);
    const values = (await bridge
      .run(chromeCode(batch, origin), { session: "browser-crawl-check", timeoutMs: 45_000 })
      .catch((error: unknown) => batch.map(() => ({ error: String(error) })))) as ChromeAnswer[];
    batch.forEach((url, at) => answers.set(url, values[at] ?? { error: "no answer" }));
  }
  return answers;
}

/** One cell fetching a batch at once through the extension, i.e. Chrome's own network stack. */
function chromeCode(urls: readonly string[], origin = false): string {
  return `const urls = ${JSON.stringify(urls)};
await Promise.all(urls.map((url) => browser.fetch(url, { as: "text", timeoutMs: 15000, ${origin ? "headers: { referer: url, origin: new URL(url).origin }" : ""} })
  .then((r) => ({ status: r.status, finalUrl: r.url || url, headers: r.headers || {}, html: String(r.text || "").slice(0, ${BODY_LIMIT}) }))
  .catch((error) => ({ error: String(error && error.message || error) }))));`;
}

function pick<T>(items: readonly T[], count: number): T[] {
  const copy = [...items];
  for (let index = copy.length - 1; index > 0; index--) {
    const other = Math.floor(Math.random() * (index + 1));
    [copy[index], copy[other]] = [copy[other] as T, copy[index] as T];
  }
  return copy.slice(0, count);
}

function countVerdicts(results: readonly SiteCheck[]): Partial<Record<SiteVerdict, number>> {
  const counts: Partial<Record<SiteVerdict, number>> = {};
  for (const result of results) counts[result.verdict] = (counts[result.verdict] ?? 0) + 1;
  return counts;
}

async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  work: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next++;
      results[index] = await work(items[index] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
