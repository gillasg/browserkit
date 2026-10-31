import type { ScrapeOptions } from "../types.js";
import { passGate } from "./gate.js";
import type { Fetched, Fetcher } from "./types.js";
import { siteApiAdapter, type MappedApi, type MappedModel } from "./site-api.js";

// Sites mapped with site-to-api: their pages come back as the structured data the page is built
// from, and whole collections are walked through the API's own pagination. No HTML parsing.
//
// The adapter is installed by the host (`useSiteApi`); without one, there is no API path.

function matchTemplate(template: string, path: string): Record<string, string> | undefined {
  const pattern = template.split("/");
  const parts = path.split("/");
  if (pattern.length !== parts.length) return undefined;
  const params: Record<string, string> = {};
  for (let i = 0; i < pattern.length; i++) {
    const name = /^\{(.+)\}$/.exec(pattern[i] ?? "")?.[1];
    if (name) params[name] = decodeURIComponent(parts[i] ?? "");
    else if (pattern[i] !== parts[i]) return undefined;
  }
  return params;
}

export class ApiFetcher implements Fetcher {
  readonly name = "api" as const;
  private readonly models = new Map<string, Promise<MappedModel | undefined>>();
  private readonly apis = new Map<string, Promise<MappedApi>>();
  private readonly direct = new Map<string, Promise<MappedApi>>();

  /** Whether a host has installed a site-to-api adapter. */
  get available(): boolean {
    return siteApiAdapter() !== undefined;
  }

  private model(url: URL): Promise<MappedModel | undefined> {
    const adapter = siteApiAdapter();
    if (!adapter) return Promise.resolve(undefined);
    const site = adapter.siteName(url.href);
    if (!this.models.has(site))
      this.models.set(
        site,
        adapter.loadModel(site).catch(() => undefined),
      );
    return this.models.get(site) as Promise<MappedModel | undefined>;
  }

  api(site: string): Promise<MappedApi> {
    const adapter = siteApiAdapter();
    if (!adapter) throw new Error("No site API adapter is installed.");
    if (!this.apis.has(site)) this.apis.set(site, adapter.siteApi(site));
    return this.apis.get(site) as Promise<MappedApi>;
  }

  /** The page endpoint that serves this URL, if the site is mapped. */
  async endpoint(
    input: string,
  ): Promise<
    { page: NonNullable<MappedModel["pages"]>[number]; params: Record<string, string> } | undefined
  > {
    const adapter = siteApiAdapter();
    if (!adapter) return undefined;
    const url = new URL(input);
    const model = await this.model(url);
    for (const page of model?.pages ?? []) {
      if (page.origin !== url.origin) continue;
      const params = matchTemplate(page.path, url.pathname);
      if (params) return { page, params };
    }
    return undefined;
  }

  async fetch(url: string, options: ScrapeOptions): Promise<Fetched> {
    void options;
    await passGate(url);
    const adapter = siteApiAdapter();
    if (!adapter) throw new Error(`No mapped API serves ${url}`);
    const match = await this.endpoint(url);
    if (!match) throw new Error(`No mapped API serves ${url}`);
    const site = adapter.siteName(url);
    let json: unknown;
    try {
      json = await (await this.api(site)).fetchPage(match.page.id, match.params);
    } catch (error) {
      // No browser: pages read from embedded data still work over plain HTTP.
      if (!adapter.isBrowserNotConnected(error) || match.page.extractor) throw error;
      if (!this.direct.has(site))
        this.direct.set(site, adapter.siteApi(site, { transport: "direct" }));
      json = await (
        await (this.direct.get(site) as Promise<MappedApi>)
      ).fetchPage(match.page.id, match.params);
    }
    const body = Buffer.from(JSON.stringify(json));
    return {
      url,
      finalUrl: url,
      status: 200,
      headers: {},
      contentType: "application/json",
      body,
      fetchedBy: "api",
      json,
    };
  }

  /** Every item of a mapped, paginated operation. */
  async *items(
    site: string,
    operation: string,
    params: Record<string, unknown> = {},
    maxItems?: number,
  ): AsyncGenerator<unknown> {
    const api = await this.api(site);
    yield* api.paginate(operation, params, maxItems ? { maxItems } : {});
  }
}
