import type { CrawlOptions } from "./types.js";

// URL normalisation for deduplication, and the rules that decide which URLs a crawl follows.

const TRACKING = /^(utm_\w+|gclid|fbclid|msclkid|mc_cid|mc_eid|_ga|_gl|ref_src|igshid|yclid)$/i;

/** One spelling per page: no fragment, no tracking parameters, sorted query, no default port. */
export function normalizeUrl(input: string, ignoreQuery: boolean | string[] = false): string {
  const url = new URL(input);
  url.hash = "";
  url.hostname = url.hostname.toLowerCase();
  if (
    (url.protocol === "http:" && url.port === "80") ||
    (url.protocol === "https:" && url.port === "443")
  )
    url.port = "";
  if (ignoreQuery === true) url.search = "";
  else {
    const drop = new Set(Array.isArray(ignoreQuery) ? ignoreQuery : []);
    const params = [...url.searchParams].filter(([key]) => !TRACKING.test(key) && !drop.has(key));
    params.sort(([a], [b]) => a.localeCompare(b));
    url.search = new URLSearchParams(params).toString();
  }
  if (url.pathname !== "/" && url.pathname.endsWith("/"))
    url.pathname = url.pathname.replace(/\/+$/, "/");
  return url.href;
}

/** `/blog/**` style globs, or `re:` regexes. */
export function patternToRegex(pattern: string): RegExp {
  if (pattern.startsWith("re:")) return new RegExp(pattern.slice(3), "i");
  let out = "";
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i] as string;
    if (char === "*" && pattern[i + 1] === "*") {
      out += ".*";
      i++;
    } else if (char === "*") out += "[^/]*";
    else if (char === "?") out += "[^/]";
    else out += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${out}$`, "i");
}

/** The registrable-ish domain: the last two labels (three for common two-part suffixes). */
export function baseDomain(hostname: string): string {
  const parts = hostname.split(".");
  if (parts.length <= 2 || /^\d+$/.test(parts[parts.length - 1] ?? "")) return hostname;
  const twoPart =
    /^(co|com|org|net|gov|ac|edu)$/.test(parts[parts.length - 2] ?? "") &&
    (parts[parts.length - 1] ?? "").length === 2;
  return parts.slice(twoPart ? -3 : -2).join(".");
}

export class Scope {
  private readonly includes: RegExp[];
  private readonly excludes: RegExp[];
  private readonly hosts: Set<string>;

  constructor(
    start: string[],
    private readonly options: Pick<
      CrawlOptions,
      "include" | "exclude" | "matchFullUrl" | "subdomains" | "external" | "ignoreQuery"
    >,
  ) {
    this.includes = (options.include ?? []).map(patternToRegex);
    this.excludes = (options.exclude ?? []).map(patternToRegex);
    this.hosts = new Set(start.map((url) => new URL(url).host));
  }

  private onSite(url: URL): boolean {
    if (this.options.external) return true;
    if (this.hosts.has(url.host)) return true;
    if (!this.options.subdomains) return false;
    return [...this.hosts].some(
      (host) => baseDomain(url.hostname) === baseDomain(host.split(":")[0] ?? host),
    );
  }

  /** Why a URL is out of scope, or undefined when it should be crawled. */
  reject(input: string): string | undefined {
    let url: URL;
    try {
      url = new URL(input);
    } catch {
      return "invalid URL";
    }
    if (!/^https?:$/.test(url.protocol)) return "not a web page";
    if (!this.onSite(url)) return "another site";
    const target = this.options.matchFullUrl ? url.href : url.pathname + url.search;
    const path = this.options.matchFullUrl ? url.href : url.pathname;
    // A pattern written as a whole URL (https://site/docs/**) is matched against the whole URL.
    const matches = (re: RegExp) => re.test(target) || re.test(path) || re.test(url.href);
    if (this.includes.length && !this.includes.some(matches)) return "not included";
    if (this.excludes.some(matches)) return "excluded";
    return undefined;
  }
}

const BINARY =
  /\.(png|jpe?g|gif|webp|avif|svg|ico|mp4|webm|mp3|wav|zip|gz|tgz|rar|7z|exe|dmg|iso|woff2?|ttf|css|js|mjs|map)(\?|$)/i;

/** Pages worth fetching: not images, scripts or archives. Documents (PDF, DOCX, XLSX) are kept. */
export function isFetchable(url: string): boolean {
  try {
    return !BINARY.test(new URL(url).pathname);
  } catch {
    return false;
  }
}
