import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Crawl, crawl, mapSite, signature, readSitemaps, StaticFetcher } from "../dist/index.js";
import { startCrawlSite } from "./fixture-site.mjs";
import { fakeAuto, tempHome } from "./helpers.mjs";

async function site(t) {
  await tempHome(t);
  const s = await startCrawlSite();
  t.after(() => s.close());
  return s;
}

const paths = (pages) =>
  pages.map((page) => new URL(page.url).pathname + new URL(page.url).search).sort();
const fast = { delayMs: 0, concurrency: 4 };

test("sitemaps: robots.txt points the way (its rules are ignored), index files and gzip are followed", async (t) => {
  const { origin } = await site(t);
  const fetcher = new StaticFetcher();
  const entries = await readSitemaps(origin, async (url) => {
    const r = await fetcher.fetch(url, {});
    return { status: r.status, body: r.body, contentType: r.contentType };
  });
  assert.equal(entries.length, 16);
  assert.equal(entries.find((e) => e.url.endsWith("/docs/intro")).lastmod, "2026-01-01");
});

test("a crawl follows sitemaps and links within the site, once per page", async (t) => {
  const { origin } = await site(t);
  const { fetcher } = fakeAuto();
  const pages = await crawl({ url: origin + "/", limit: 50, ...fast }, { fetcher });
  const found = paths(pages);
  assert.ok(
    found.includes("/blog/post-12") &&
      found.includes("/pricing") &&
      found.includes("/product/lamp"),
  );
  assert.ok(!found.some((path) => path.includes("utm_source")), "tracking parameters are dropped");
  assert.equal(new Set(found).size, found.length, "no page twice");
  assert.ok(
    !pages.some((page) => page.url.includes("elsewhere.example")),
    "other sites are not followed",
  );
  assert.ok(
    pages.find((page) => page.url.endsWith("/files/report.pdf")).markdown.includes("Annual report"),
  );
});

test("scope: limit, depth, include and exclude, links only", async (t) => {
  const { origin } = await site(t);
  const { fetcher } = fakeAuto();
  assert.equal((await crawl({ url: origin + "/", limit: 5, ...fast }, { fetcher })).length, 5);
  const blog = await crawl(
    {
      url: origin + "/blog/",
      include: ["/blog/**"],
      exclude: ["/blog/post-1"],
      source: "links",
      ...fast,
    },
    { fetcher },
  );
  assert.ok(blog.every((page) => new URL(page.url).pathname.startsWith("/blog")));
  assert.ok(!paths(blog).includes("/blog/post-1"), "post-1 is excluded");
  assert.ok(paths(blog).includes("/blog/post-10"), "globs match whole paths");
  const shallow = await crawl(
    { url: origin + "/blog/", source: "links", maxDepth: 1, include: ["/blog/**"], ...fast },
    { fetcher },
  );
  assert.ok(shallow.every((page) => page.depth <= 1));
  assert.equal(shallow.length, 13, "the blog page and the twelve posts it links to");
});

test("best-first with a query reaches relevant pages first and stops when the topic is covered", async (t) => {
  const { origin } = await site(t);
  const { fetcher } = fakeAuto();
  const pages = await crawl(
    {
      url: origin + "/blog/",
      source: "links",
      query: "pricing plans discounts",
      adaptive: { window: 4, threshold: 0.95 },
      limit: 30,
      concurrency: 1,
      delayMs: 0,
    },
    { fetcher },
  );
  assert.ok(pages.length < 13, `stopped early after ${pages.length} pages`);
  const posts = pages.filter((page) => /post-\d+$/.test(page.url));
  assert.ok(
    posts.slice(0, 3).every((page) => /post-(\d*[02468])$/.test(page.url)),
    "even posts are about pricing, and come first",
  );
});

test("politeness: 429s are retried after Retry-After; a session cookie opens member pages", async (t) => {
  const { origin } = await site(t);
  const { fetcher } = fakeAuto();
  const [flaky] = await crawl(
    { url: origin + "/flaky", source: "links", maxDepth: 0, ...fast },
    { fetcher },
  );
  assert.equal(flaky.status, 200);
  const [member] = await crawl(
    {
      url: origin + "/private/report",
      source: "links",
      maxDepth: 0,
      cookies: { session: "ok" },
      ...fast,
    },
    { fetcher },
  );
  assert.match(member.markdown, /members-only report/);
});

test("events, stats, cursor-paged results and signed webhooks", async (t) => {
  const { origin } = await site(t);
  const { fetcher } = fakeAuto();
  const received = [];
  const hook = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString();
    received.push({
      type: req.headers["x-browser-crawl-event"],
      valid: req.headers["x-browser-crawl-signature"] === signature(body, "s3cret"),
    });
    res.end("ok");
  });
  await new Promise((resolve) => hook.listen(0, "127.0.0.1", resolve));
  t.after(() => hook.close());
  const job = new Crawl(
    {
      url: origin + "/docs/intro",
      source: "links",
      limit: 3,
      ...fast,
      webhook: {
        url: `http://127.0.0.1:${hook.address().port}/`,
        secret: "s3cret",
        events: ["started", "completed"],
      },
    },
    { fetcher },
  );
  const types = [];
  job.on("event", (event) => types.push(event.type));
  await job.start();
  assert.equal(types[0], "started");
  assert.equal(types.at(-1), "completed");
  assert.equal(job.state, "completed");
  assert.equal(job.stats.completed, 3);
  const first = await job.results(0, 1);
  assert.equal(first.results.length, 1);
  assert.equal(first.next, 1);
  assert.equal((await job.results(first.next, 10)).next, undefined);
  for (let i = 0; i < 50 && received.length < 2; i++) await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(
    received.map((r) => r.type),
    ["started", "completed"],
  );
  assert.ok(received.every((r) => r.valid));
});

test("hooks change, skip and drop pages", async (t) => {
  const { origin } = await site(t);
  const { fetcher } = fakeAuto();
  const pages = await crawl(
    { url: origin + "/blog/", source: "links", maxDepth: 1, ...fast },
    {
      fetcher,
      hooks: {
        beforeFetch: (url, options) => (url.endsWith("post-3") ? false : options),
        onPage: (page) =>
          page.url.endsWith("post-4") ? undefined : { ...page, title: page.title?.toUpperCase() },
        onLinks: (links) => links.filter((link) => !link.endsWith("post-5")),
      },
    },
  );
  const found = paths(pages);
  assert.ok(
    !found.includes("/blog/post-3") &&
      !found.includes("/blog/post-4") &&
      !found.includes("/blog/post-5"),
  );
  assert.equal(pages.find((page) => page.url.endsWith("post-2")).title, "POST 2");
});

test("modifiedSince skips pages whose sitemap lastmod is older", async (t) => {
  const { origin } = await site(t);
  const { fetcher } = fakeAuto();
  const pages = await crawl(
    { url: origin + "/", source: "sitemaps", modifiedSince: "2026-06-01", limit: 50, ...fast },
    { fetcher },
  );
  assert.ok(!paths(pages).some((path) => path.startsWith("/docs/")));
  assert.ok(paths(pages).includes("/pricing"));
});

test("pause, then resume from the state folder in a new process, with no page twice", async (t) => {
  const { origin } = await site(t);
  const stateDir = await mkdtemp(join(tmpdir(), "crawl-state-"));
  const first = new Crawl(
    { url: origin + "/blog/", source: "links", limit: 13, concurrency: 1, delayMs: 0, stateDir },
    { fetcher: fakeAuto().fetcher },
  );
  let seen = 0;
  first.on("page", () => ++seen === 4 && first.pause());
  await first.start();
  assert.equal(first.state, "paused");
  const again = new Crawl(
    { url: origin + "/blog/", source: "links", limit: 13, concurrency: 1, delayMs: 0, stateDir },
    { fetcher: fakeAuto().fetcher, id: first.id },
  );
  await again.start();
  assert.equal(again.state, "completed");
  const all = (await again.results(0, 100)).results;
  assert.equal(all.length, 13);
  assert.equal(new Set(all.map((page) => page.url)).size, 13);
});

test("cancel stops the crawl and marks what was left", async (t) => {
  const { origin } = await site(t);
  const job = new Crawl(
    { url: origin + "/blog/", source: "links", limit: 50, concurrency: 1, delayMs: 0 },
    { fetcher: fakeAuto().fetcher },
  );
  job.on("page", () => job.cancel());
  await job.start();
  assert.equal(job.state, "cancelled");
  assert.ok(job.stats.cancelled > 0);
});

test("freshness: maxAge serves the cache, ETags give 304s, changes come with a diff", async (t) => {
  const { origin, state } = await site(t);
  const { fetcher } = fakeAuto();
  const once = (path, extra = {}) =>
    crawl(
      { url: origin + path, source: "links", maxDepth: 0, ...fast, ...extra },
      { fetcher },
    ).then((pages) => pages[0]);
  assert.equal((await once("/changing")).change.status, "new");
  assert.equal((await once("/changing", { maxAge: 60_000 })).fetchedBy, "cache");
  assert.equal((await once("/changing")).change.status, "same");
  state.version = 2;
  const changed = await once("/changing");
  assert.equal(changed.change.status, "changed");
  assert.match(changed.change.diff, /- Version 1\n\+ Version 2/);
  await once("/etag");
  const before = state.hits.get("/etag");
  const revalidated = await once("/etag");
  assert.equal(revalidated.change.status, "same");
  assert.equal(state.hits.get("/etag"), before + 1, "asked the server, which answered 304");
});

test("map lists URLs fast and ranks them by a phrase", async (t) => {
  const { origin } = await site(t);
  const all = await mapSite(origin + "/");
  assert.ok(all.length >= 16);
  const ranked = await mapSite(origin + "/", { search: "setup" });
  assert.equal(new URL(ranked[0].url).pathname, "/docs/setup");
});

test("include patterns written as whole URLs match", async () => {
  const { Scope } = await import("../dist/index.js");
  const scope = new Scope(["https://docs.example.com/uv/"], {
    include: ["https://docs.example.com/uv/**"],
  });
  assert.equal(scope.reject("https://docs.example.com/uv/guides/"), undefined);
  assert.equal(scope.reject("https://docs.example.com/other/"), "not included");
  const paths = new Scope(["https://docs.example.com/"], { include: ["/uv/**"] });
  assert.equal(paths.reject("https://docs.example.com/uv/guides/"), undefined);
});
