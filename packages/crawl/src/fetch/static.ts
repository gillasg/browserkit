import { readSession } from "../registry.js";
import { passGate } from "./gate.js";
import type { SessionFile } from "../session.js";
import { fetch as proxiedFetch, ProxyAgent } from "undici";
import type { ScrapeOptions } from "../types.js";
import type { Fetched, Fetcher, Validators } from "./types.js";

// Plain HTTP with a current browser's headers, the user's cookies when they exported a session
// (site-to-api's `session` command) or passed cookies, HTTP auth and conditional requests.

export const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";

function browserHeaders(
  url: URL,
  options: ScrapeOptions,
  session?: SessionFile,
): Record<string, string> {
  return {
    "user-agent": session?.userAgent ?? USER_AGENT,
    accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "accept-language": options.language ?? session?.language ?? "en-US,en;q=0.9",
    "sec-ch-ua": '"Chromium";v="141", "Not?A_Brand";v="8", "Google Chrome";v="141"',
    "sec-ch-ua-mobile": options.mobile ? "?1" : "?0",
    "sec-ch-ua-platform": '"Windows"',
    "sec-fetch-dest": "document",
    "sec-fetch-mode": "navigate",
    "sec-fetch-site": "none",
    "sec-fetch-user": "?1",
    "upgrade-insecure-requests": "1",
    referer: url.origin + "/",
  };
}

function cookieHeader(url: URL, options: ScrapeOptions, session?: SessionFile): string | undefined {
  if (typeof options.cookies === "string") return options.cookies;
  const given = options.cookies ? Object.entries(options.cookies).map(([k, v]) => `${k}=${v}`) : [];
  const now = Date.now() / 1000;
  const stored = (session?.cookies ?? [])
    .filter((c) => {
      const domain = c.domain.replace(/^\./, "");
      const matches = url.hostname === domain || url.hostname.endsWith("." + domain);
      return (
        matches &&
        url.pathname.startsWith(c.path || "/") &&
        (!c.expires || c.expires <= 0 || c.expires > now)
      );
    })
    .map((c) => `${c.name}=${c.value}`);
  const all = [...stored, ...given];
  return all.length ? all.join("; ") : undefined;
}

export class StaticFetcher implements Fetcher {
  readonly name = "static" as const;
  private readonly sessions = new Map<string, Promise<SessionFile | undefined>>();

  /** The session exported for this site with site-to-api, if any. */
  private session(url: URL): Promise<SessionFile | undefined> {
    const site = url.host.replace(/^www\./, "");
    if (!this.sessions.has(site))
      this.sessions.set(
        site,
        readSession(site).catch(() => undefined),
      );
    return this.sessions.get(site) as Promise<SessionFile | undefined>;
  }

  async fetch(input: string, options: ScrapeOptions, validators?: Validators): Promise<Fetched> {
    await passGate(input);
    const url = new URL(input);
    const session = await this.session(url);
    const headers = requestHeaders(url, options, session, validators);
    const proxy = options.proxy ?? process.env.BROWSER_CRAWL_PROXY;
    // undici's own fetch, so the agent and the fetch are the same version.
    const send = (proxy ? proxiedFetch : fetch) as typeof fetch;
    const response = await send(url, {
      headers,
      ...(proxy ? ({ dispatcher: proxyAgent(proxy) } as object) : {}),
      redirect: "follow",
      signal: AbortSignal.timeout(options.timeoutMs ?? 30_000),
    });
    // A redirect onto a blocked site is refused before its body is read.
    if (response.url && response.url !== input) await passGate(response.url);
    const body = Buffer.from(await response.arrayBuffer());
    return {
      url: input,
      finalUrl: response.url || input,
      status: response.status,
      headers: Object.fromEntries(response.headers),
      contentType: response.headers.get("content-type") ?? "",
      body,
      fetchedBy: "static",
      ...(response.status === 304 ? { notModified: true } : {}),
    };
  }
}

function requestHeaders(
  url: URL,
  options: ScrapeOptions,
  session: SessionFile | undefined,
  validators: Validators | undefined,
): Record<string, string> {
  const headers: Record<string, string> = {
    ...browserHeaders(url, options, session),
    ...(options.headers ?? {}),
  };
  const cookie = cookieHeader(url, options, session);
  if (cookie) headers.cookie = cookie;
  if (options.auth)
    headers.authorization =
      "Basic " +
      Buffer.from(`${options.auth.username}:${options.auth.password}`).toString("base64");
  if (validators?.etag) headers["if-none-match"] = validators.etag;
  if (validators?.lastModified) headers["if-modified-since"] = validators.lastModified;
  return headers;
}

const agents = new Map<string, ProxyAgent>();

function proxyAgent(proxy: string): ProxyAgent {
  let agent = agents.get(proxy);
  if (!agent) agents.set(proxy, (agent = new ProxyAgent(proxy)));
  return agent;
}

/** Fetches sitemaps and robots.txt the same way. */
export function rawFetcher(fetcher: StaticFetcher) {
  return async (url: string): Promise<{ status: number; body: Buffer; contentType: string }> => {
    const result = await fetcher.fetch(url, {});
    return { status: result.status, body: result.body, contentType: result.contentType };
  };
}
