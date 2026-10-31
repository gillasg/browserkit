// browser-crawl: crawl anything, including behind logins.
export * from "./types.js";
export { scrape, buildResult, DEFAULT_FORMATS, type ScrapeContext } from "./scrape.js";
export { Crawl, crawl, type CrawlHooks, type CrawlDeps } from "./crawler.js";
export { mapSite, type MapOptions, type MappedUrl } from "./map.js";
export {
  prefersGoogle,
  search,
  searchAndScrape,
  type SearchEngine,
  type SearchResult,
} from "./search.js";
export { searchWeb, WEB_PROVIDERS, type WebProvider, type WebResult } from "./web-search.js";
export { findList, type FindOptions, type FoundRow } from "./find.js";
export { syncSite, type SyncReport } from "./sync.js";
export { startServer, type CrawlServer, type ServerOptions } from "./server.js";
export { runMcpServer } from "./mcp.js";
export { writeOutput, writeDataset, toCsv, toJsonl } from "./output.js";
export { AutoFetcher, needsBrowser, type AutoOptions } from "./fetch/auto.js";
export { botCheck, isNetworkRefusal, isDnsFailure } from "./challenge.js";
export {
  checkSites,
  applyRedirect,
  originGated,
  judge,
  siteUrl,
  shapeOf,
  expectationOf,
  type SiteCheck,
  type SiteVerdict,
  type CheckOptions,
  type CheckReport,
  type PageShape,
  type PathProbe,
} from "./check.js";
export { StaticFetcher } from "./fetch/static.js";
export { BrowserFetcher, pageCode } from "./fetch/browser.js";
export { ApiFetcher } from "./fetch/api.js";
export type { Fetched, Fetcher, Validators } from "./fetch/types.js";
export { readSitemaps } from "./sitemap.js";
export { normalizeUrl, patternToRegex, Scope } from "./url.js";
export { fitMarkdown, pageScore, linkScore, Bm25 } from "./relevance.js";
export { extractCss } from "./extract/css.js";
export {
  extractJson,
  summarize,
  generateCssSchema,
  optionsFromPrompt,
  requireModel,
  type ModelLike,
} from "./extract/model.js";
export { signature } from "./webhook.js";
export { listJobs, pruneJobs, JobStore, crawlHome } from "./store.js";
export { lineDiff } from "./cache.js";
// Apps that drive a browser themselves can plug it in for every browser fetch.
export { useBrowser, closeSharedBridge, type Bridge } from "./bridge.js";
// Hosts with site-to-api installed plug it in to read mapped sites through their API.
export { useSiteApi, type SiteApiAdapter } from "./fetch/site-api.js";
export { useWebGate, type WebGate } from "./fetch/gate.js";
