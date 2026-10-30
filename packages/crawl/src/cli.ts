#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { closeSharedBridge } from "./bridge.js";
import { Crawl, type CrawlHooks } from "./crawler.js";
import { generateCssSchema, optionsFromPrompt } from "./extract/model.js";
import { AutoFetcher } from "./fetch/auto.js";
import { mapSite } from "./map.js";
import { writeOutput } from "./output.js";
import { scrape } from "./scrape.js";
import { search, searchAndScrape, type SearchEngine } from "./search.js";
import { findList } from "./find.js";
import { startServer } from "./server.js";
import { listJobs, JobStore } from "./store.js";
import { syncSite } from "./sync.js";
import { runMcpServer } from "./mcp.js";
import type { CrawlEvent, CrawlOptions, PageResult } from "./types.js";

const usage = `browser-crawl: crawl anything, including behind your logins.

  scrape <url>               one page    [--formats markdown,links,...] [--render auto|static|browser]
  map <url>                  list URLs   [--search phrase] [--limit n]
  crawl <url>                a site      [--limit n] [--max-depth n] [--include /blog/**] [--exclude ...]
                                         [--query text --adaptive] [--strategy bfs|dfs|best] [--source all|sitemaps|links]
                                         [--out results.jsonl|.csv|.json|folder] [--state dir] [--hooks file.mjs]
  crawl --prompt "<request>" describe the crawl in plain English (needs a model)
  crawl --api <site>:<operation>         every item of a site mapped with site-to-api
  crawl --resume <job id or state dir>   continue a paused or interrupted crawl
  sync <url> <folder>        keep a Markdown mirror up to date (only changed pages are fetched)
  search "<query>"           web search: keyless providers, or Google in your browser for local, live and personal queries [--engine auto|web|google] [--scrape] [--limit n]
  find "<query>"             build a list: search, keep matches, fill columns (needs a model)
                             --columns "name,founded=year founded" [--criteria text] [--also "q2|q3"]
  schema <url> "<what>"      write a reusable CSS extraction schema from one page (needs a model)
  jobs                       list crawls
  serve                      REST job server [--port n] [--host h] [--token t]
  mcp                        stdio MCP server

Common options: --render, --formats, --wait-for <selector>, --scroll infinite, --expand, --mobile,
--language hi-IN, --cookies "a=1; b=2", --header "Name: value", --max-age <ms>, --modified-since <date>,
--concurrency n, --delay-ms n, --css schema.json, --schema schema.json, --extract "what to pull out" (model),
--no-main-content`;

type Flags = Record<string, string | true>;
const out = (text: string): void => void process.stdout.write(text + "\n");

function parse(argv: string[]): { positional: string[]; flags: Flags } {
  const positional: string[] = [];
  const flags: Flags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const name = arg.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags[name] =
        name === "header" && typeof flags.header === "string" ? `${flags.header}\n${next}` : next;
      i++;
    } else flags[name] = true;
  }
  return { positional, flags };
}

const camel = (name: string) => name.replace(/-([a-z])/g, (_, char: string) => char.toUpperCase());
const LISTS = new Set(["formats", "include", "exclude", "seeds", "blockResources", "ignoreQuery"]);
const NUMBERS = new Set([
  "limit",
  "maxDepth",
  "concurrency",
  "delayMs",
  "retries",
  "maxAge",
  "timeoutMs",
]);
const SKIP = new Set([
  "out",
  "state",
  "hooks",
  "css",
  "schema",
  "prompt",
  "api",
  "resume",
  "header",
  "no-main-content",
  "adaptive",
  "port",
  "host",
  "token",
  "search",
  "scrape",
  "columns",
  "criteria",
  "also",
  "extract",
]);

function flagValue(key: string, value: string | true): unknown {
  if (value === true) return true;
  if (LISTS.has(key)) return value.split(",").map((item) => item.trim());
  if (NUMBERS.has(key) || (key === "scroll" && value !== "infinite")) return Number(value);
  return value;
}

function headers(text: string): Record<string, string> {
  return Object.fromEntries(
    text
      .split("\n")
      .map((line) => [
        line.slice(0, line.indexOf(":")).trim(),
        line.slice(line.indexOf(":") + 1).trim(),
      ]),
  );
}

async function extraction(flags: Flags): Promise<Record<string, unknown> | undefined> {
  const extract: Record<string, unknown> = {};
  if (typeof flags.css === "string") extract.css = JSON.parse(await readFile(flags.css, "utf8"));
  if (typeof flags.schema === "string")
    extract.schema = JSON.parse(await readFile(flags.schema, "utf8"));
  if (typeof flags.extract === "string") extract.prompt = flags.extract;
  return Object.keys(extract).length ? extract : undefined;
}

async function options(flags: Flags): Promise<CrawlOptions> {
  const result: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(flags))
    if (!SKIP.has(name)) result[camel(name)] = flagValue(camel(name), value);
  if (flags["no-main-content"]) result.onlyMainContent = false;
  if (flags.adaptive) result.adaptive = true;
  if (typeof flags.state === "string") result.stateDir = resolve(flags.state);
  if (typeof flags.header === "string") result.headers = headers(flags.header);
  const extract = await extraction(flags);
  if (extract) result.extract = extract;
  return result as CrawlOptions;
}

async function loadHooks(path: string | true | undefined): Promise<CrawlHooks | undefined> {
  if (typeof path !== "string") return undefined;
  const module = (await import(pathToFileURL(resolve(path)).href)) as {
    default?: CrawlHooks;
  } & CrawlHooks;
  return module.default ?? module;
}

function progress(event: CrawlEvent): void {
  const page = event.page;
  if (event.type === "page" && page)
    process.stderr.write(
      `${page.error ? "✗" : "✓"} ${page.status || "-"} ${page.fetchedBy.padEnd(7)} ${page.url}${page.error ? `  (${page.error})` : ""}\n`,
    );
  else if (event.type !== "page")
    process.stderr.write(`${event.type}: ${JSON.stringify(event.stats)}\n`);
}

async function crawlOptions(
  positional: string[],
  flags: Flags,
): Promise<{ crawl: CrawlOptions; id?: string }> {
  if (typeof flags.resume === "string") {
    const looksLikeDir = /[\\/]/.test(flags.resume);
    const store = looksLikeDir
      ? new JobStore("resumed", resolve(flags.resume))
      : new JobStore(flags.resume);
    const record = await store.readRecord();
    if (!record) throw new Error(`No crawl found at ${flags.resume}`);
    return {
      crawl: { ...record.options, ...(looksLikeDir ? { stateDir: store.dir } : {}) },
      id: record.id,
    };
  }
  let crawl = await options(flags);
  if (typeof flags.prompt === "string" && !crawl.extract)
    crawl = { ...(await optionsFromPrompt(flags.prompt)), ...crawl };
  if (positional[1]) crawl.url = positional[1];
  if (typeof flags.api === "string") {
    const [site = "", operation = ""] = flags.api.split(":");
    crawl.api = { site, operation };
  }
  return { crawl };
}

async function runCrawl(positional: string[], flags: Flags): Promise<void> {
  const { crawl, id } = await crawlOptions(positional, flags);
  const hooks = await loadHooks(flags.hooks);
  const job = new Crawl(crawl, { ...(hooks ? { hooks } : {}), ...(id ? { id } : {}) });
  const pages: PageResult[] = [];
  job.on("event", progress);
  job.on(
    "page",
    (event: CrawlEvent) =>
      event.page && !(event.page.status === 0 && event.page.error) && pages.push(event.page),
  );
  const stop = () => job.pause();
  process.once("SIGINT", stop);
  await job.start();
  process.off("SIGINT", stop);
  if (job.state === "paused")
    out(`Paused. Resume with: browser-crawl crawl --resume ${crawl.stateDir ?? job.id}`);
  if (typeof flags.out === "string") {
    await writeOutput(pages, resolve(flags.out));
    out(`Wrote ${pages.length} pages to ${flags.out}`);
  } else out(pages.map((page) => JSON.stringify(page)).join("\n"));
}

async function runScrape(positional: string[], flags: Flags): Promise<void> {
  const url = positional[1];
  if (!url) throw new Error("Usage: browser-crawl scrape <url>");
  const page = await scrape(url, await options(flags));
  if (typeof flags.out === "string") await writeOutput([page], resolve(flags.out));
  else if (!flags.formats && page.markdown !== undefined) out(page.markdown);
  else out(JSON.stringify(page, null, 2));
}

const COMMANDS: Record<string, (positional: string[], flags: Flags) => Promise<void>> = {
  scrape: runScrape,
  crawl: runCrawl,
  map: async (positional, flags) => {
    const urls = await mapSite(positional[1] ?? "", {
      ...(await options(flags)),
      ...(typeof flags.search === "string" ? { search: flags.search } : {}),
    });
    for (const item of urls) out(item.url);
  },
  sync: async (positional, flags) => {
    const [, url, dir] = positional;
    if (!url || !dir) throw new Error("Usage: browser-crawl sync <url> <folder>");
    const report = await syncSite({
      ...(await options(flags)),
      url,
      dir: resolve(dir),
      stateDir: resolve(dir, ".state"),
    });
    out(
      `added ${report.added.length}, changed ${report.changed.length}, unchanged ${report.unchanged.length}, removed ${report.removed.length}, failed ${report.failed.length}`,
    );
  },
  search: async (positional, flags) => {
    const query = positional.slice(1).join(" ");
    const limit = Number(typeof flags.limit === "string" ? flags.limit : 10);
    const engine = (typeof flags.engine === "string" ? flags.engine : "auto") as SearchEngine;
    out(
      JSON.stringify(
        flags.scrape
          ? await searchAndScrape(query, { ...(await options(flags)), limit, engine })
          : await search(query, { limit, engine }),
        null,
        2,
      ),
    );
  },
  find: async (positional, flags) => {
    const columns = Object.fromEntries(
      String(flags.columns ?? "name")
        .split(",")
        .map((column) => {
          const [name = "", what] = column.split("=", 2);
          return [name.trim(), (what ?? name).trim()];
        }),
    );
    const rows = await findList(positional.slice(1).join(" "), {
      columns,
      ...(typeof flags.criteria === "string" ? { criteria: flags.criteria } : {}),
      ...(typeof flags.also === "string" ? { queries: flags.also.split("|") } : {}),
    });
    out(JSON.stringify(rows, null, 2));
  },
  schema: async (positional) => {
    const [, url, description] = positional;
    if (!url || !description)
      throw new Error('Usage: browser-crawl schema <url> "<what to extract>"');
    const fetcher = new AutoFetcher();
    const page = await scrape(url, { formats: ["rawHtml"] }, { fetcher });
    await fetcher.close();
    out(JSON.stringify(await generateCssSchema(page.rawHtml ?? "", description), null, 2));
  },
  jobs: async () => {
    for (const job of await listJobs())
      out(
        `${job.id}\t${job.state}\t${job.stats.completed} pages\t${job.options.url ?? job.options.api?.site ?? ""}`,
      );
  },
  serve: async (_positional, flags) => {
    const server = await startServer({
      ...(typeof flags.port === "string" ? { port: Number(flags.port) } : {}),
      ...(typeof flags.host === "string" ? { host: flags.host } : {}),
      ...(typeof flags.token === "string" ? { token: flags.token } : {}),
    });
    out(`browser-crawl server at ${server.url}\nAuthorization: Bearer ${server.token}`);
    await new Promise(() => undefined);
  },
  mcp: () => runMcpServer(),
};

async function main(argv: string[]): Promise<number> {
  const { positional, flags } = parse(argv);
  const command = COMMANDS[positional[0] ?? ""];
  if (!command) {
    out(usage);
    return positional[0] && positional[0] !== "help" ? 1 : 0;
  }
  await command(positional, flags);
  return 0;
}

main(process.argv.slice(2)).then(
  async (code) => {
    await closeSharedBridge();
    process.exit(code);
  },
  async (error: unknown) => {
    process.stderr.write((error instanceof Error ? error.message : String(error)) + "\n");
    await closeSharedBridge();
    process.exit(1);
  },
);
