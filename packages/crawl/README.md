# browser-crawl

**Crawl anything, including behind your logins.** Turn a site into Markdown, JSON or a dataset: plain HTTP where it works, your own browser where a page needs JavaScript or a sign-in, and a site's own API when a host has mapped it with site-to-api.

```bash
npx browser-crawl crawl https://docs.example.com --limit 200 --out docs/
npx browser-crawl scrape https://example.com/pricing --formats markdown,tables
npx browser-crawl sync https://wiki.internal.example mirror/   # keeps a local copy current
```

```ts
import { crawl, scrape } from "browser-crawl";

const pages = await crawl({ url: "https://docs.example.com", limit: 100, include: ["/guides/**"] });
const page = await scrape("https://shop.example/p/lamp", { formats: ["markdown", "product"] });
```

## Why it is different

- **Behind logins.** Pages that need a sign-in are fetched in your own browser, with your sessions, SSO and two-factor already done. When a page asks you to sign in or verify, that one page waits for you (up to five minutes) while the rest of the crawl continues.
- **Rarely blocked.** The browser is a real one, and plain requests carry a current browser's headers. It never announces itself as a bot.
- **Fast by default.** Every page is tried over plain HTTP first; only pages that need JavaScript (or a site that checks for bots) go to the browser, and the crawler remembers which sites need it.
- **Through APIs when it can.** For a site mapped with site-to-api, pages come back as the data they are built from, and whole collections are paged through the site's own API: no HTML parsing, many times faster.
- **The page's own data.** Besides Markdown, you get the JSON the page loaded itself and its embedded state (Next.js, Nuxt, Apollo, Redux, JSON-LD).
- **Polite.** robots.txt is not consulted (it is read only to find sitemaps). Requests to each host are spaced out, slow down when the site does, and back off on 429 and 503 answers, honouring `Retry-After`.

## Requirements

- Node.js 22.19 or newer.
- For browser fetching: Chrome or Edge with the [browserkit](https://github.com/gillasg/browserkit) (set up once with `npx browserkit setup`). Without it, everything runs over plain HTTP. Apps that already drive a browser can use theirs instead: `useBrowser({ run, status, close })`, where `run(code, { session, timeoutMs })` runs browser code.

## Commands

| Command                          | What it does                                                                                                           |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `scrape <url>`                   | One page in any formats.                                                                                               |
| `map <url>`                      | A fast list of a site's URLs from its sitemaps and links. `--search` ranks them by a phrase.                           |
| `crawl <url>`                    | A whole site, or the part you choose. Ctrl+C pauses; `--resume` continues.                                             |
| `crawl --prompt "<request>"`     | Describe the crawl in plain English (needs a model).                                                                   |
| `crawl --api <site>:<operation>` | Every item of a paginated operation of a site mapped with site-to-api (needs a host that installs the adapter).        |
| `sync <url> <folder>`            | A Markdown mirror that only re-fetches pages that changed and removes pages that are gone.                             |
| `search "<query>"`               | Google in your browser (your region and language). `--scrape` reads the results too.                                   |
| `find "<query>"`                 | Build a list: search, keep results that meet `--criteria`, fill `--columns name,founded=year founded` (needs a model). |
| `schema <url> "<what>"`          | Writes a CSS extraction schema from one page (needs a model), to reuse with `--css` and no model.                      |
| `jobs`                           | Lists crawls.                                                                                                          |
| `serve`                          | The REST job server.                                                                                                   |
| `mcp`                            | A stdio MCP server with `scrape`, `map`, `crawl` and `search` tools.                                                   |

Pages fetched in the browser include the content of open shadow roots (web components) and same-origin iframes.

## Choosing pages

| Option                          | Meaning                                                                                                                                                           |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--source all\|sitemaps\|links` | Where URLs come from. Sitemap index files, gzipped sitemaps and sitemaps named in robots.txt are followed.                                                        |
| `--limit`, `--max-depth`        | How many pages, and how many links away from the start.                                                                                                           |
| `--include`, `--exclude`        | Globs (`/blog/**`) or regexes (`re:^/docs/v2/`), on the path, or the whole URL with `--match-full-url`.                                                           |
| `--subdomains`, `--external`    | Follow links to subdomains, or to other sites.                                                                                                                    |
| `--ignore-query`                | Treat URLs that differ only in their query as one page (or list parameters to ignore). Tracking parameters are always ignored, and canonical links are respected. |
| `--strategy bfs\|dfs\|best`     | Breadth-first, depth-first, or most relevant first (with `--query`).                                                                                              |
| `--query "<topic>" --adaptive`  | Crawl toward a topic and stop once it is well covered.                                                                                                            |
| `--seeds`                       | Extra start URLs.                                                                                                                                                 |
| `--modified-since <date>`       | Skip pages whose sitemap date is older.                                                                                                                           |

## Fetching

| Option                                              | Meaning                                                                                                               |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `--render auto\|static\|browser`                    | `auto` (default) uses plain HTTP and switches to the browser when a page needs it.                                    |
| `--wait-until networkidle`, `--wait-for <selector>` | Wait for the page to finish loading, or for an element.                                                               |
| `--scroll infinite`                                 | Scroll until no new content appears (infinite feeds, lazy loading).                                                   |
| `--expand`                                          | Click "show more" and "read more" first.                                                                              |
| actions (library and API)                           | Click, write, press, scroll, wait, run JavaScript, take screenshots, in order.                                        |
| `--block-resources image,media,font`                | Load pages faster in the browser.                                                                                     |
| `--mobile`, `--language hi-IN`                      | Fetch as a phone, or in another language.                                                                             |
| `--cookies`, `--header`, HTTP auth                  | For plain fetches. Cookies exported with `site-to-api session <site>` are used automatically.                         |
| `proxy` option, `BROWSER_CRAWL_PROXY`               | Send plain fetches through your proxy (`http://user:pass@host:port`), for example to see a site from another country. |
| `--max-age <ms>`                                    | Use the cached copy when it is this fresh. Otherwise pages are re-checked with ETag and Last-Modified.                |
| `--concurrency`, `--delay-ms`, `--retries`          | Throughput. Concurrency also drops by itself when memory runs short.                                                  |

## Formats

`markdown` (main content, the default), `mainMarkdown`, `fitMarkdown` (only the parts relevant to `--query`), `html`, `cleanedHtml`, `rawHtml`, `text`, `links`, `images`, `metadata`, `tables` (rows keyed by header), `pageData` (embedded state and the page's own JSON requests), `product` (normalised from JSON-LD), `screenshot` (full page), `pdf`, `mhtml`, `json` (extraction) and `summary`.

PDF, Word (DOCX) and Excel (XLSX) files are turned into Markdown too.

Every result also says whether the page is `new`, `same` or `changed` since the last crawl, with a line diff.

## Extraction

- **CSS schemas, no model:** `--css schema.json`, with `baseSelector` for repeated items and fields of type `text`, `html`, `attr`, `number`, `list` or `nested`.
- **With a model:** `--schema schema.json` (a JSON Schema) and/or `--extract "what to pull out"`.
- **Write once, reuse free:** `schema <url> "<what>"` writes a CSS schema from one page, to extract every similar page without a model.

## Output

`--out pages.jsonl`, `--out pages.csv`, `--out pages.json`, or `--out folder/` for a dataset (one Markdown and one JSON file per page, plus `index.json`). Without `--out`, results print as JSON lines.

Hooks (`--hooks hooks.mjs`) let your code change options per URL, transform or drop results, and choose which links to follow:

```js
export default {
  beforeFetch: (url, options) => (url.includes("/archive/") ? false : options),
  onPage: (page) => ({ ...page, markdown: page.markdown?.replace(/Advertisement/g, "") }),
  onLinks: (links) => links.filter((link) => !link.includes("?sort=")),
};
```

## Jobs, the server and webhooks

Crawls run as jobs with an id, states (`running`, `paused`, `completed`, `failed`, `cancelled`), per-URL states and results you can read a page at a time. With `--state <folder>` a crawl survives restarts.

```bash
npx browser-crawl serve --port 8787     # prints its token
```

| Request                                    |                                                                       |
| ------------------------------------------ | --------------------------------------------------------------------- |
| `POST /v1/crawl`                           | Start a crawl (the same options as JSON). Returns `{ id }`.           |
| `GET /v1/crawl/:id?cursor=0&limit=50`      | State, stats and results; `next` is the following cursor.             |
| `DELETE /v1/crawl/:id`                     | Cancel. `POST /v1/crawl/:id/pause` and `/resume`.                     |
| `GET /v1/crawl/:id/events`                 | Live events (server-sent events). `/v1/crawl/:id/ws` for a WebSocket. |
| `GET /v1/crawls`                           | Every job. Finished jobs are kept for seven days.                     |
| `POST /v1/scrape`, `/v1/map`, `/v1/search` | One page, a URL list, a search.                                       |

Every request needs `Authorization: Bearer <token>` (set it with `--token` or `BROWSER_CRAWL_TOKEN`).

Webhooks: `{ "webhook": { "url": "...", "secret": "...", "events": ["page", "completed"] } }`. Each event is POSTed as JSON with `x-browser-crawl-event` and, with a secret, `x-browser-crawl-signature: sha256=<HMAC of the body>`.

A `Dockerfile` runs the server with plain-HTTP fetching. Build it from this folder: `docker build -f Dockerfile -t browser-crawl .`

## Optional AI features

Crawling and CSS extraction never need a model. JSON extraction from a schema or prompt, summaries, schema writing and plain-English crawl requests take a model from the caller: the library, server and MCP accept a `ModelLike` (`{ complete(context) }`). Nothing in browser-crawl signs in or picks one for you.

## Development

```bash
node scripts/link-repos.mjs   # clones and builds the repos it links to, next to this one
pnpm install
pnpm check
```

browser-crawl has no sibling packages: a change here is committed only here. `node scripts/link-repos.mjs --revisions` prints the revision of each linked repo.

The end-to-end test drives a private, headless Chrome for Testing with browserkit. It runs when it finds the extension (`BUE_DIR`, default `../browserkit`) and Chrome (`CHROME_PATH`), and always in CI.

## License

MIT
