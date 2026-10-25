import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  syncSite,
  writeOutput,
  type CheckReport,
  type Format,
  type PageResult,
  type SiteCheck,
} from "@browserkit/tools/browser-crawl";
import { crawlTool, type CrawlToolInput } from "@browserkit/tools/definitions";
import { flag, has, list, type Args } from "../args.js";
import { cliModel } from "../host.js";
import { out, printJson, printRows } from "../output.js";
import type { Command } from "../usage.js";

// Reading the web: one page, a site or section, its URL list, a Google search, or a list built
// from results. Plain HTTP first; the browser (with its logins) when a page needs one.

const ACTIONS = ["scrape", "map", "search", "find"] as const;
type Action = (typeof ACTIONS)[number] | "crawl";

const DEFAULT_FORMATS: Format[] = ["markdown", "metadata"];

function action(args: Args): { action: Action; target: string } {
  const [first, second] = args.positional;
  if (first && (ACTIONS as readonly string[]).includes(first))
    return { action: first as Action, target: second ?? "" };
  return { action: "crawl", target: first ?? "" };
}

function render(args: Args): "auto" | "static" | "browser" {
  const value = flag(args, "render");
  return value === "static" || value === "browser" ? value : "auto";
}

function formats(args: Args): Format[] {
  const chosen = list(args, "formats");
  return chosen.length ? (chosen as Format[]) : DEFAULT_FORMATS;
}

function crawlOptions(args: Args): CrawlToolInput {
  const start = action(args).target;
  const wholeSite = has(args, "site") ? new URL(start).origin : start;
  const include = list(args, "include");
  const exclude = list(args, "exclude");
  const query = flag(args, "query");
  const api = flag(args, "api");
  return {
    action: "crawl",
    url: wholeSite,
    limit: Number(flag(args, "limit") ?? 25),
    formats: formats(args),
    render: render(args),
    ...(flag(args, "depth") ? { maxDepth: Number(flag(args, "depth")) } : {}),
    ...(include.length ? { include } : {}),
    ...(exclude.length ? { exclude } : {}),
    ...(query ? { query } : {}),
    ...(api ? { api: { site: api.split(":")[0] ?? "", operation: api.split(":")[1] ?? "" } } : {}),
  };
}

async function runScrape(target: string, args: Args): Promise<number> {
  const query = flag(args, "query");
  printJson(
    await crawlTool.run(
      {
        action: "scrape",
        url: target,
        formats: formats(args),
        render: render(args),
        ...(query ? { query } : {}),
      },
      {},
    ),
  );
  return 0;
}

async function runMap(target: string, args: Args): Promise<number> {
  const query = flag(args, "query");
  const urls = (await crawlTool.run(
    {
      action: "map",
      url: target,
      limit: Number(flag(args, "limit") ?? 500),
      ...(query ? { query } : {}),
    },
    {},
  )) as { url: string; title?: string }[];
  if (has(args, "json")) printJson(urls);
  else printRows(urls.map((item) => [item.url, item.title]));
  return 0;
}

async function runSearch(target: string, args: Args): Promise<number> {
  const results = (await crawlTool.run(
    { action: "search", query: target, limit: Number(flag(args, "limit") ?? 10) },
    {},
  )) as { url: string; title?: string; snippet?: string }[];
  if (has(args, "json")) printJson(results);
  else printRows(results.map((item) => [item.url, item.title, item.snippet]));
  return 0;
}

async function runFind(target: string, args: Args): Promise<number> {
  const columns: Record<string, string> = {};
  for (const pair of list(args, "columns")) {
    const [name, ...what] = pair.split("=");
    if (name) columns[name] = what.join("=") || name;
  }
  const criteria = flag(args, "criteria");
  const model = await cliModel();
  const rows = (await crawlTool.run(
    {
      action: "find",
      query: target,
      columns: Object.keys(columns).length ? columns : { name: "name" },
      ...(criteria ? { criteria } : {}),
    },
    model ? { model: async () => model } : {},
  )) as { url: string; values: Record<string, unknown> }[];
  if (has(args, "json")) printJson(rows);
  else printRows(rows.map((row) => [row.url, ...Object.values(row.values).map(String)]));
  return 0;
}

async function runCrawl(args: Args): Promise<number> {
  const { action: kind, target } = action(args);
  if (!target)
    throw new Error(
      "Usage: browserkit crawl <url> | browserkit crawl <scrape|map|search|find> <target>",
    );
  if (kind === "scrape") return runScrape(target, args);
  if (kind === "map") return runMap(target, args);
  if (kind === "search") return runSearch(target, args);
  if (kind === "find") return runFind(target, args);
  const outDir = flag(args, "out");
  const pages = (await crawlTool.run(crawlOptions(args), {})) as PageResult[];
  if (outDir) {
    await writeOutput(pages, resolve(outDir));
    out(`Wrote ${pages.length} pages to ${outDir}`);
    return 0;
  }
  if (has(args, "json")) printJson(pages);
  else printRows(pages.map((page) => [page.url, page.status, page.markdown?.length ?? 0]));
  return 0;
}

async function runSync(args: Args): Promise<number> {
  const [url, dir] = args.positional;
  if (!url || !dir) throw new Error("Usage: browserkit sync <url> <folder> [--limit n]");
  const report = await syncSite({
    url,
    dir: resolve(dir),
    limit: Number(flag(args, "limit") ?? 500),
    render: render(args),
  });
  if (has(args, "json")) printJson(report);
  else
    out(
      `${report.added.length} added, ${report.changed.length} changed, ${report.unchanged.length} unchanged, ${report.removed.length} removed, ${report.failed.length} failed`,
    );
  return 0;
}

async function runCheck(args: Args): Promise<number> {
  const urls = args.positional;
  const file = flag(args, "file");
  if (!urls.length && !file)
    throw new Error(
      "Usage: browserkit check <urls...|--file f> [--via http] [--paths p] [--expect t]",
    );
  const via = flag(args, "via") === "http" ? "http" : "auto";
  const paths = list(args, "paths");
  const expect = flag(args, "expect");
  const report = (await crawlTool.run(
    {
      action: "check",
      urls,
      ...(file ? { file } : {}),
      via,
      ...(paths.length ? { paths } : {}),
      ...(expect ? { expect } : {}),
      ...(has(args, "ready") ? { readiness: true } : {}),
    },
    { workspace: process.cwd() },
  )) as CheckReport;
  const saved = await saveCheck(report.results);
  if (has(args, "json")) printJson(report);
  else {
    printRows(Object.entries(report.counts).map(([verdict, count]) => [verdict, String(count)]));
    for (const line of report.paths ?? [])
      out(`paths: ${line.host} ${line.ok} ok, ${line.failed} failed of ${line.probes.length}`);
    out(
      `spotCheck: ${report.spotCheck.checked} checked, ${report.spotCheck.disagreed.length} disagreed`,
    );
    out(`Saved evidence in ${saved}`);
  }
  return 0;
}

async function saveCheck(results: readonly SiteCheck[]): Promise<string> {
  const folder = join("checks", new Date().toISOString().replace(/[:.]/g, "-"));
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, "results.json"), JSON.stringify(results, null, 2));
  const rows = results.map((result) =>
    [
      result.host,
      result.verdict,
      result.via,
      result.status ?? "",
      result.title ?? "",
      result.reason ?? "",
    ]
      .map((cell) => `"${String(cell).replace(/"/g, '""')}"`)
      .join(","),
  );
  await writeFile(
    join(folder, "results.csv"),
    ["host,verdict,via,status,title,reason", ...rows].join("\n"),
  );
  return folder.replace(/\\/g, "/");
}

export const checkCommand: Command = {
  name: "check",
  group: "Read the web",
  summary: "check which of many sites load, with evidence for each verdict",
  help: `Usage: browserkit check <urls...|--file f> [--via http] [--paths p,p] [--expect t] [--json]

  --file <path>     a file listing hosts or URLs (JSON array/object or one per line)
  --via http        never start Chrome; otherwise plain HTTP first, then Chrome for the rest
  --paths <paths>   paths to probe on every host, comma separated ('/api/x,/stream.m3u8')
  --expect <what>   what those paths should answer: json, html, m3u8, xml, text or a type
  --json            the whole report as JSON

Checks up to 5000 sites, prints the verdict counts and the spot-check line, and saves
checks/<timestamp>/results.json and results.csv in the current folder. With --paths, every
host is asked the same paths and each answer is typed by its content type and real shape (a
JSON endpoint is told apart from a site answering its HTML catch-all page with 200).`,
  run: runCheck,
};

export const syncCommand: Command = {
  name: "sync",
  group: "Read the web",
  summary: "keep a Markdown mirror of a site: adds, changes and removals only",
  help: `Usage: browserkit sync <url> <folder> [--limit n] [--render mode] [--json]

Writes each page as Markdown under the folder and remembers what it wrote, so the next run only
touches what changed.`,
  run: runSync,
};

export const crawlCommand: Command = {
  name: "crawl",
  group: "Read the web",
  summary: "crawl a page's site or section as Markdown and data",
  help: `Usage: browserkit crawl <url> [--limit n] [--depth n] [--formats f,f] [--site]
       browserkit crawl scrape <url>
       browserkit crawl map <url>
       browserkit crawl search <query>
       browserkit crawl find <query> --columns name=what

  --limit <n>            pages to fetch (default 25; 500 for map)
  --depth <n>            link levels to follow
  --include <patterns>   only these URL patterns, comma separated ('/docs/**')
  --exclude <patterns>   never these
  --formats <list>       markdown (default), fitMarkdown, text, links, metadata, tables, pageData
  --render <mode>        auto (default), static, browser
  --query <text>         rank pages and keep the relevant parts
  --site                 start from the site's root instead of this page
  --api <site>:<op>      read a mapped site's operation instead of pages
  --out <dir>            write every page there
  --json                 the whole answer as JSON

Subcommands: scrape one page, map a site's URLs, search Google, or find rows that meet criteria
(find needs a model from the caller). Plain HTTP is tried first; pages that need JavaScript or a
sign-in go through your browser.`,
  run: runCrawl,
};

export const scrapeCommand: Command = {
  name: "scrape",
  group: "Read the web",
  summary: "read one page as Markdown, text or data",
  help: `Usage: browserkit scrape <url> [--formats f,f] [--render auto|static|browser] [--query text] [--json]`,
  run: (args) => {
    const target = args.positional[0];
    if (!target) throw new Error("Usage: browserkit scrape <url>");
    return runScrape(target, args);
  },
};

export const urlMapCommand: Command = {
  name: "map-urls",
  group: "Read the web",
  summary: "list a site's URLs (sitemaps and links)",
  help: `Usage: browserkit map-urls <url> [--limit n] [--query text] [--json]`,
  run: (args) => {
    const target = args.positional[0];
    if (!target) throw new Error("Usage: browserkit map-urls <url>");
    return runMap(target, args);
  },
};

export const searchCommand: Command = {
  name: "search",
  group: "Read the web",
  summary: "search Google through your browser",
  help: `Usage: browserkit search <query> [--limit n] [--json]`,
  run: (args) => {
    const target = args.positional.join(" ");
    if (!target) throw new Error("Usage: browserkit search <query>");
    return runSearch(target, args);
  },
};

export const findCommand: Command = {
  name: "find",
  group: "Read the web",
  summary: "build a list from the web that meets criteria (needs a model)",
  help: `Usage: browserkit find <query> --columns <name=what,...> [--criteria text] [--json]

  --columns name=what,price=what it costs   the fields to fill in for every row
  --criteria "under 500"                    what every row must be

Searches, reads the results, and keeps pages that meet the criteria. Needs a model from the
caller, which a standalone CLI does not have: call findList() in code for that.`,
  run: (args) => {
    const target = args.positional.join(" ");
    if (!target) throw new Error("Usage: browserkit find <query> --columns name=what");
    return runFind(target, args);
  },
};
