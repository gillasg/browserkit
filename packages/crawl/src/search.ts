import { sharedBridge, type Bridge } from "./bridge.js";
import { AutoFetcher } from "./fetch/auto.js";
import { scrape } from "./scrape.js";
import { searchWeb, type WebProvider } from "./web-search.js";
import type { PageResult, ScrapeOptions } from "./types.js";

// Search, then read the results. Two engines: keyless web search providers (fast, no browser,
// good for facts, docs and research) and a real Google search in the user's browser (their
// region, language and personalisation: local places, live scores, prices, anything "near me"
// or about the user). auto picks Google for those queries and the providers for the rest, and
// falls back to the other engine when one gives nothing.

export interface SearchResult {
  title: string;
  url: string;
  snippet?: string;
  /** google, or the web provider that answered (exa, parallel, tinyfish, tavily, firecrawl). */
  source?: string;
}

export type SearchEngine = "auto" | "google" | "web";

export interface SearchOptions {
  limit?: number;
  engine?: SearchEngine;
  bridge?: () => Promise<Bridge>;
}

// Queries whose answer depends on where the user is, what is happening now, or who they are.
const GOOGLE_FIRST =
  /\b(near me|nearby|near|open now|hours|directions|weather|today|tonight|tomorrow|now|live|score|scores|price|prices|cost|deal|deals|buy|cheap|flights?|hotels?|restaurants?|delivery|stock|showtimes|tickets|traffic|my|mine|me)\b/i;

export function prefersGoogle(query: string): boolean {
  return GOOGLE_FIRST.test(query);
}

async function googleSearch(query: string, options: SearchOptions): Promise<SearchResult[]> {
  const bridge = await (options.bridge ?? sharedBridge)();
  const results = (await bridge.run(
    `await google.search(${JSON.stringify(query)}, { limit: ${options.limit ?? 10} })`,
    { session: "browser-crawl-search" },
  )) as SearchResult[];
  return (results ?? []).map((item) => ({
    title: item.title,
    url: item.url,
    ...(item.snippet ? { snippet: item.snippet } : {}),
    source: "google",
  }));
}

async function webSearch(query: string, options: SearchOptions): Promise<SearchResult[]> {
  const found = await searchWeb(query, { limit: options.limit ?? 10 });
  const provider: WebProvider | undefined = found.provider;
  return found.results
    .filter((item) => item.url)
    .map((item) => ({
      title: item.title ?? item.url,
      url: item.url,
      ...(item.content ? { snippet: item.content.slice(0, 500) } : {}),
      ...(provider ? { source: provider } : {}),
    }));
}

/** One engine, then the other when the first fails or finds nothing. */
export async function search(query: string, options: SearchOptions = {}): Promise<SearchResult[]> {
  const engine = options.engine ?? "auto";
  if (engine === "google") return googleSearch(query, options);
  if (engine === "web") return webSearch(query, options);
  const [first, second] = prefersGoogle(query)
    ? [googleSearch, webSearch]
    : [webSearch, googleSearch];
  const found = await first(query, options).catch(() => []);
  return found.length ? found : second(query, options);
}

/** Searches and scrapes the top results. */
export async function searchAndScrape(
  query: string,
  options: ScrapeOptions &
    SearchOptions & {
      fetcher?: AutoFetcher;
    } = {},
): Promise<(SearchResult & { page?: PageResult })[]> {
  const found = await search(query, options);
  const fetcher = options.fetcher ?? new AutoFetcher();
  try {
    return await Promise.all(
      found.map(async (result) => {
        const page = await scrape(
          result.url,
          { ...options, query: options.query ?? query },
          { fetcher },
        ).catch(() => undefined);
        return page ? { ...result, page } : result;
      }),
    );
  } finally {
    if (!options.fetcher) await fetcher.close();
  }
}
