import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { join } from "node:path";
import { changeOf, isFresh, PageCache, validators } from "./cache.js";
import type { ModelLike } from "./extract/model.js";
import { AutoFetcher } from "./fetch/auto.js";
import { rawFetcher, StaticFetcher } from "./fetch/static.js";
import { FetchError, type Fetched } from "./fetch/types.js";
import { Frontier, type FrontierItem } from "./frontier.js";
import { linkScore, Saturation } from "./relevance.js";
import { buildResult, DEFAULT_FORMATS } from "./scrape.js";
import { readSitemaps } from "./sitemap.js";
import { JobStore, crawlHome, type JobRecord } from "./store.js";
import { allowedConcurrency, HostThrottle, RETRYABLE, sleep } from "./throttle.js";
import type {
  CrawlEvent,
  CrawlEventType,
  CrawlOptions,
  CrawlStats,
  JobState,
  PageResult,
  PageStatus,
} from "./types.js";
import { isFetchable, normalizeUrl, Scope } from "./url.js";
import { sendWebhook } from "./webhook.js";

// A crawl job: discovery (sitemaps and links), scope rules, a frontier with BFS/DFS/best-first,
// adaptive stopping, mixed fetching with per-host throttling and retries, caching and change
// tracking, events and webhooks, and state on disk so it can pause, resume and be read by cursor.

export interface CrawlHooks {
  /** Change the options for one URL, or return false to skip it. */
  beforeFetch?(
    url: string,
    options: CrawlOptions,
  ): CrawlOptions | false | Promise<CrawlOptions | false>;
  /** Change a result, or return undefined to drop it. */
  onPage?(result: PageResult): PageResult | undefined | Promise<PageResult | undefined>;
  /** Choose which links to follow from a page. */
  onLinks?(links: string[], result: PageResult): string[] | Promise<string[]>;
}

export interface CrawlDeps {
  fetcher?: AutoFetcher;
  model?: ModelLike;
  hooks?: CrawlHooks;
  id?: string;
}

const MAX_LIMIT = 100_000;

export class Crawl extends EventEmitter {
  readonly id: string;
  readonly store: JobStore;
  state: JobState = "running";
  private readonly options: CrawlOptions;
  private readonly fetcher: AutoFetcher;
  private readonly frontier: Frontier;
  private readonly urls = new Map<string, PageStatus>();
  private readonly throttle: HostThrottle;
  private readonly cache: PageCache;
  private readonly saturation?: Saturation;
  private scope!: Scope;
  private fetched = 0;
  private active = 0;
  private stopped = false;
  private initialized = false;
  private createdAt = new Date().toISOString();
  private done?: Promise<void>;

  constructor(
    options: CrawlOptions,
    private readonly deps: CrawlDeps = {},
  ) {
    super();
    this.options = {
      limit: 100,
      maxDepth: 5,
      source: "all",
      strategy: options.query ? "best" : "bfs",
      concurrency: 4,
      retries: 2,
      ...options,
    };
    this.options.limit = Math.min(this.options.limit ?? 100, MAX_LIMIT);
    this.id = deps.id ?? randomUUID();
    this.store = new JobStore(this.id, options.stateDir);
    this.fetcher = deps.fetcher ?? new AutoFetcher({ workers: this.options.concurrency ?? 4 });
    this.frontier = new Frontier(this.options.strategy);
    this.throttle = new HostThrottle(
      this.options.delayMs ?? 250,
      this.options.autoThrottle !== false,
    );
    this.cache = new PageCache(join(crawlHome(), "cache"));
    const adaptive = this.options.adaptive;
    if (adaptive && this.options.query)
      this.saturation = new Saturation(
        typeof adaptive === "object" ? adaptive.window : undefined,
        typeof adaptive === "object" ? adaptive.threshold : undefined,
      );
  }

  get stats(): CrawlStats {
    const stats: CrawlStats = {
      queued: this.frontier.size,
      completed: 0,
      skipped: 0,
      errored: 0,
      cancelled: 0,
    };
    for (const status of this.urls.values()) if (status !== "queued") stats[status]++;
    return stats;
  }

  private startUrls(): string[] {
    const urls = [this.options.url, ...(this.options.seeds ?? [])].filter(
      (url): url is string => !!url,
    );
    if (!urls.length && !this.options.api)
      throw new Error("A crawl needs a url (or seeds, or an api).");
    return urls.map((url) => normalizeUrl(url, this.options.ignoreQuery));
  }

  private emitEvent(type: CrawlEventType, extra: Partial<CrawlEvent> = {}): void {
    const event: CrawlEvent = {
      type,
      jobId: this.id,
      at: new Date().toISOString(),
      stats: this.stats,
      ...extra,
    };
    this.emit("event", event);
    this.emit(type, event);
    if (this.options.webhook) void sendWebhook(this.options.webhook, event);
  }

  private async saveRecord(error?: string): Promise<void> {
    const record: JobRecord = {
      id: this.id,
      state: this.state,
      options: this.options,
      stats: this.stats,
      createdAt: this.createdAt,
      updatedAt: new Date().toISOString(),
      ...(error ? { error } : {}),
    };
    await this.store.saveRecord(record);
  }

  private async saveState(): Promise<void> {
    await this.store.saveState({
      frontier: this.frontier.snapshot(),
      urls: Object.fromEntries(this.urls),
    });
  }

  /** Runs the crawl to the end (or until paused or cancelled). Safe to call again to resume. */
  start(): Promise<void> {
    this.done ??= this.run().finally(() => (this.done = undefined));
    return this.done;
  }

  private async run(): Promise<void> {
    await this.store.init();
    try {
      if (!this.initialized && !(await this.restore())) await this.seed();
      this.initialized = true;
      this.state = "running";
      await this.saveRecord();
      this.emitEvent("started");
      if (this.options.api) await this.crawlApi();
      else await this.workers();
      await this.finish();
    } catch (error) {
      this.state = "failed";
      const message = error instanceof Error ? error.message : String(error);
      await this.saveRecord(message);
      this.emitEvent("failed", { error: message });
      throw error;
    }
  }

  private async finish(): Promise<void> {
    await this.saveState();
    if (this.state === "paused") {
      await this.saveRecord();
      this.emitEvent("paused");
      return;
    }
    if (this.state === "cancelled") {
      for (const item of this.drain()) this.urls.set(item.url, "cancelled");
      await this.saveRecord();
      this.emitEvent("cancelled");
      return;
    }
    this.state = "completed";
    await this.saveRecord();
    this.emitEvent("completed");
    if (!this.deps.fetcher) await this.fetcher.close();
  }

  private drain(): FrontierItem[] {
    const items: FrontierItem[] = [];
    for (let item = this.frontier.next(); item; item = this.frontier.next()) items.push(item);
    return items;
  }

  /** Picks up a paused or interrupted crawl from its state directory. */
  private async restore(): Promise<boolean> {
    const saved = await this.store.readState();
    if (!saved) return false;
    this.scope = new Scope(this.startUrls(), this.options);
    this.frontier.restore(saved.frontier);
    for (const [url, status] of Object.entries(saved.urls)) this.urls.set(url, status);
    this.fetched = [...this.urls.values()].filter(
      (s) => s === "completed" || s === "errored",
    ).length;
    const record = await this.store.readRecord();
    if (record) this.createdAt = record.createdAt;
    return true;
  }

  private async seed(): Promise<void> {
    const starts = this.startUrls();
    this.scope = new Scope(starts, this.options);
    for (const url of starts) this.enqueue({ url, depth: 0, score: 1 });
    if (this.options.source === "links") return;
    const fetcher = rawFetcher(
      this.deps.fetcher?.static instanceof StaticFetcher
        ? this.deps.fetcher.static
        : new StaticFetcher(),
    );
    for (const origin of new Set(starts.map((url) => new URL(url).origin))) {
      const entries = await readSitemaps(
        origin,
        fetcher,
        this.options.limit ? this.options.limit * 20 : undefined,
      ).catch(() => []);
      for (const entry of entries)
        this.enqueue({
          url: entry.url,
          depth: 1,
          score: this.score(entry.url, ""),
          ...(entry.lastmod ? { lastmod: entry.lastmod } : {}),
        });
    }
  }

  private score(url: string, anchor: string): number {
    return this.options.query ? linkScore(url, anchor, this.options.query) : 0;
  }

  private enqueue(item: FrontierItem): void {
    let url: string;
    try {
      url = normalizeUrl(item.url, this.options.ignoreQuery);
    } catch {
      return;
    }
    if (this.frontier.has(url) || !isFetchable(url) || this.scope.reject(url)) return;
    if (this.frontier.push({ ...item, url })) this.urls.set(url, "queued");
  }

  pause(): void {
    if (this.state === "running") this.state = "paused";
  }

  async resume(): Promise<void> {
    if (this.state !== "paused") return;
    this.state = "running";
    await this.start();
  }

  cancel(): void {
    if (this.state === "running" || this.state === "paused") this.state = "cancelled";
    this.stopped = true;
  }

  private canContinue(): boolean {
    if (this.state !== "running" || this.stopped) return false;
    if (this.saturation?.saturated) return false;
    return this.fetched < (this.options.limit ?? 100);
  }

  private async workers(): Promise<void> {
    const limit = this.options.concurrency ?? 4;
    const loops = Array.from({ length: limit }, (_, index) => this.loop(index, limit));
    await Promise.all(loops);
  }

  private async loop(index: number, limit: number): Promise<void> {
    while (this.canContinue()) {
      if (index >= allowedConcurrency(limit)) {
        await sleep(200);
        continue;
      }
      const item = this.frontier.next();
      if (!item) {
        if (!this.active) return;
        await sleep(50);
        continue;
      }
      this.active++;
      this.fetched++;
      try {
        await this.visit(item);
      } finally {
        this.active--;
      }
    }
  }

  private async visit(item: FrontierItem): Promise<void> {
    const options = await this.optionsFor(item);
    if (!options) return this.skip(item, "skipped by a hook");
    if (
      this.options.modifiedSince &&
      item.lastmod &&
      Date.parse(item.lastmod) < Date.parse(this.options.modifiedSince)
    )
      return this.skip(item, "not modified since " + this.options.modifiedSince);
    try {
      const result = await this.fetchPage(item, options);
      await this.record(item, result);
    } catch (error) {
      await this.record(item, this.failure(item, error));
    }
  }

  private async optionsFor(item: FrontierItem): Promise<CrawlOptions | false> {
    const options: CrawlOptions = { ...this.options, formats: this.formats() };
    return this.deps.hooks?.beforeFetch ? this.deps.hooks.beforeFetch(item.url, options) : options;
  }

  private formats(): CrawlOptions["formats"] {
    const formats = new Set(this.options.formats ?? DEFAULT_FORMATS);
    formats.add("links");
    formats.add("metadata");
    return [...formats];
  }

  private skip(item: FrontierItem, reason: string): void {
    this.fetched--;
    this.urls.set(item.url, "skipped");
    this.emitEvent("page", {
      page: {
        url: item.url,
        finalUrl: item.url,
        status: 0,
        depth: item.depth,
        fetchedBy: "static",
        fetchedAt: new Date().toISOString(),
        error: reason,
      },
    });
  }

  private failure(item: FrontierItem, error: unknown): PageResult {
    return {
      url: item.url,
      finalUrl: item.url,
      status: 0,
      depth: item.depth,
      fetchedBy: "static",
      fetchedAt: new Date().toISOString(),
      error: error instanceof Error ? error.message : String(error),
    };
  }

  /** One fetch with the host's throttle, retried on network errors and on 429/5xx answers. */
  private async fetchWithRetries(
    url: string,
    options: CrawlOptions,
    cached: Awaited<ReturnType<PageCache["get"]>>,
  ): Promise<Fetched> {
    const host = new URL(url).host;
    const retries = options.retries ?? 2;
    for (let attempt = 0; ; attempt++) {
      await this.throttle.wait(host);
      const started = Date.now();
      let fetched: Fetched;
      try {
        fetched = await this.fetcher.fetch(url, options, validators(cached));
      } catch (error) {
        if (attempt >= retries || isBlocked(error)) throw error;
        continue;
      }
      this.throttle.observe(
        host,
        Date.now() - started,
        fetched.status,
        fetched.headers["retry-after"],
      );
      if (!RETRYABLE.has(fetched.status) || attempt >= retries) return fetched;
    }
  }

  /** Fetches with retries and the host's throttle; serves fresh cached copies. */
  private async fetchPage(item: FrontierItem, options: CrawlOptions): Promise<PageResult> {
    const cached = await this.cache.get(item.url);
    if (cached && isFresh(cached, options.maxAge))
      return { ...cached.result, depth: item.depth, fetchedBy: "cache" };
    const fetched = await this.fetchWithRetries(item.url, options, cached);
    if (fetched.notModified && cached)
      return {
        ...cached.result,
        depth: item.depth,
        fetchedAt: new Date().toISOString(),
        change: { status: "same" },
      };
    const result = await buildResult(fetched, options, item.depth, {
      fetcher: this.fetcher,
      ...(this.deps.model ? { model: this.deps.model } : {}),
    });
    result.change = changeOf(cached, result);
    if (fetched.status < 400) await this.cache.put(item.url, result, fetched.headers);
    return result;
  }

  private async record(item: FrontierItem, fetchedResult: PageResult): Promise<void> {
    const result = this.deps.hooks?.onPage
      ? await this.deps.hooks.onPage(fetchedResult)
      : fetchedResult;
    const failed = !!fetchedResult.error || fetchedResult.status >= 400;
    this.urls.set(item.url, failed ? "errored" : "completed");
    if (fetchedResult.score !== undefined) this.saturation?.add(fetchedResult.score);
    if (!failed) await this.follow(item, fetchedResult);
    if (!result) return;
    const output = this.trim(result);
    await this.store.append(output);
    this.emitEvent("page", { page: output });
    if (this.fetched % 20 === 0) await this.saveState();
  }

  /** Removes the formats that were only added for crawling. */
  private trim(result: PageResult): PageResult {
    const asked = new Set(this.options.formats ?? DEFAULT_FORMATS);
    const out = { ...result };
    if (!asked.has("links")) delete out.links;
    if (!asked.has("metadata")) delete out.metadata;
    return out;
  }

  /** A page's canonical URL counts as seen, so the same page under another URL is not fetched again. */
  private markCanonical(item: FrontierItem, result: PageResult): void {
    const canonical = result.metadata?.canonical;
    if (typeof canonical !== "string" || canonical === item.url) return;
    try {
      this.frontier.markSeen(normalizeUrl(canonical, this.options.ignoreQuery));
    } catch {
      // An unusable canonical link is ignored.
    }
  }

  private async follow(item: FrontierItem, result: PageResult): Promise<void> {
    this.markCanonical(item, result);
    if (this.options.source === "sitemaps" || item.depth >= (this.options.maxDepth ?? 5)) return;
    const links = result.links ?? [];
    const found = links.map((link) => link.url);
    const chosen = this.deps.hooks?.onLinks ? await this.deps.hooks.onLinks(found, result) : found;
    const anchors = new Map(links.map((link) => [link.url, link.text]));
    for (const url of chosen)
      this.enqueue({
        url,
        depth: item.depth + 1,
        score: this.score(url, anchors.get(url) ?? ""),
        parent: item.url,
      });
  }

  /** Crawls a mapped API: every item of a paginated operation becomes a result. */
  private async crawlApi(): Promise<void> {
    const api = this.options.api as NonNullable<CrawlOptions["api"]>;
    let index = 0;
    for await (const item of this.fetcher.api.items(
      api.site,
      api.operation,
      api.params,
      api.maxItems ?? this.options.limit,
    )) {
      if (!this.canContinue()) break;
      const url = `api://${api.site}/${api.operation}#${index++}`;
      const result: PageResult = {
        url,
        finalUrl: url,
        status: 200,
        depth: 0,
        fetchedBy: "api",
        fetchedAt: new Date().toISOString(),
        json: item,
      };
      this.fetched++;
      this.urls.set(url, "completed");
      await this.store.append(result);
      this.emitEvent("page", { page: result });
    }
  }

  /** Every result so far, a page at a time. */
  results(cursor = 0, limit = 50): ReturnType<JobStore["results"]> {
    return this.store.results(cursor, limit);
  }
}

/** Runs a crawl to completion and returns every result. */
export async function crawl(options: CrawlOptions, deps: CrawlDeps = {}): Promise<PageResult[]> {
  const job = new Crawl(options, deps);
  const pages: PageResult[] = [];
  job.on("page", (event: CrawlEvent) => {
    if (event.page && job.state === "running") pages.push(event.page);
  });
  await job.start();
  return pages.filter((page) => !page.error || page.status > 0);
}

/** A site the user blocked stays blocked: never retried. */
function isBlocked(error: unknown): boolean {
  return error instanceof FetchError && error.status === 451;
}
