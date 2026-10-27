# browserkit

Let coding agents and any MCP client use **your real Chrome**: your tabs, your logins, while you watch.

Most browser-automation tools start a separate, empty browser. This one runs inside the Chrome you already use, through an extension, so an agent can work on sites you are signed in to, in tabs you can see and take over.

## What agents get

- **A persistent JavaScript REPL in the browser.** One tool call runs a whole workflow (open, read, click, type, extract) instead of one call per click. Variables and tabs survive between calls.
- **Compact page state.** `bu.state()` prints numbered interactive elements and visible text; `bu.click(id)` and `bu.type(id, text)` act on them. Raw `page.evaluate`, `page.cdp` and screenshots (optionally labelled with ids) are there when needed.
- **Site APIs.** Record a site's own requests while doing a task once (`page.network.start()`), with full headers, bodies and the script that made each call, and export them as HAR. Then call them from inside the page with `page.replay(id, changes)` or `page.request(url)`, so cookies, CSRF tokens and request signing all work: often many times faster than clicking.
- **Data without scraping.** `page.data()` returns a page's embedded JSON (JSON-LD, `__NEXT_DATA__`, app state) and metadata; `page.markdown()` returns its main content as clean Markdown.
- **Many pages at once.** `browser.fetch(url)` fetches with your cookies and no tab; `browser.pool(urls, fn)` works through pages in parallel tabs, with retries and back-off.
- **Site skills.** Flows an agent works out are saved per site and offered to every later session.
- **Hand-off.** When a step needs you (signing in, a 2FA code, a choice), the agent calls `bu.handoff("…")`. The tab comes forward with the request and **Done / Cancel**, and the agent continues from there.
- **Many agents, one browser.** Each session owns the tabs it opens; sessions do not interfere with each other or with your own tabs.
- **Visible work.** An on-page cursor shows where the agent clicks.
- **Boosts.** `browser.boosts.save({ name, sites, css, zaps, actions, network, js })` saves a lasting change to a site that applies on every visit, from the [Site Boosts](https://github.com/gillasg/site-boosts) engine built in.
- **Crawling and site APIs.** The `crawl` tool reads pages and whole sites as Markdown (the crawler in `packages/crawl`); `site_mapper` turns sites mapped from your own traffic into APIs (the mapper in `packages/site-mapper`).

## Setup

Requires Node.js 22+ and Chrome, Edge or Brave.

```sh
pnpm install
pnpm build
node apps/bridge/dist/cli.js setup
```

`setup` registers the native messaging host and prints the remaining steps:

1. Open `chrome://extensions`, turn on **Developer mode**, choose **Load unpacked**, and select `apps/extension/build`.
2. Add the MCP server to your agent: the command is `node /path/to/apps/bridge/dist/cli.js mcp` (stdio). `setup` prints ready-to-paste config.

The bridge starts on demand and stays in the background. The extension's toolbar popup shows whether it is connected.

## Connecting an agent (MCP)

The MCP server speaks stdio. Point any MCP client at it:

```json
{
  "mcpServers": {
    "browserkit": {
      "command": "node",
      "args": ["/path/to/browserkit/apps/bridge/dist/cli.js", "mcp"]
    }
  }
}
```

For Codex, add to `~/.codex/config.toml`:

```toml
[mcp_servers.browserkit]
command = "node"
args = ["/path/to/browserkit/apps/bridge/dist/cli.js", "mcp"]
```

It exposes four tools:

| Tool           | Arguments                                 | What it does                                                                                                                |
| -------------- | ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `browser_code` | `code` (required), `session`, `timeoutMs` | Runs JavaScript in a persistent REPL inside the browser. The last expression is returned; `console.log` output is included. |
| `browser_tabs` | none                                      | Lists open tabs.                                                                                                            |
| `crawl`        | `action`, `url`, `query`, `limit`, …      | Scrapes a page, crawls a site or section, maps a site's URLs, or searches Google, as Markdown and data.                     |
| `site_mapper`  | `action`, `site`, `operation`, `params`   | Lists mapped sites and their operations, calls one, or maps a site from captures saved with `page.network.save()`.          |

The tool description carries the full API, so agents can use it without extra setup. [docs/agent-guide.md](docs/agent-guide.md) is the longer reference with examples, for agents and people writing prompts.

Agents without MCP can use the CLI below; `repl` takes the same code.

## CLI

```sh
browserkit setup                                  # native host, then load apps/extension/build
browserkit repl "page = await browser.openTab('https://example.com'); await bu.state()"
browserkit tabs
browserkit status
browserkit crawl https://docs.example.com --limit 100 --out docs/
browserkit scrape https://example.com/pricing --formats markdown,tables
browserkit sync https://wiki.example mirror/         # only what changed, next time
browserkit search "chrome devtools protocol"
browserkit map https://shop.example               # use the site once; its API is built from it
browserkit ops shop.example
browserkit call shop.example searchProducts '{"q":"headphones"}'
browserkit watch shop.example listOrders --key id
browserkit federate shop.example:searchProducts other.example:search
browserkit heal shop.example
browserkit rest                                   # local REST API over every mapped site
browserkit boosts list
browserkit workflow save flows/read-thread.json
browserkit workflow run read-thread --inputs '{"url":"https://x.com/a/status/1"}'
browserkit recipe install x.com
browserkit recipe run x.com thread --inputs '{"url":"https://x.com/a/status/1"}' --feed
browserkit recipe draft shop.example --save
browserkit recipe list x.com
browserkit workflow runs read-thread
browserkit sessions create research --url https://x.com/home
browserkit sessions list
browserkit cookies list --domain example.com
browserkit network list --origin https://api.example.com
browserkit check example.com --ready
```

Every command prints what it needs with `--help`, and takes `--json` where the answer is data.
Exit codes say what went wrong: 1 failed, 2 a needed input was missing, 3 signed out, 4 no browser
connected, 5 the site's API broke, 6 a bot wall answered.
Run `browserkit mcp` for the MCP server and `browserkit rest` for a local REST API over every
mapped site.

Agents bring their own model: this extension does not sign in to model providers and does not provide a model to other extensions. A companion asking for one is told that none is available.

## Workflows and recipes

Three layers, one recipe system:

- **Site pack**: everything about one site. Its mapped API, named **recipes**, field mappings,
  health and the browser skills and boosts written for it. A recipe runs in order: the captured
  API with cursor paging, then the page (rows by selector, with expand buttons and scrolling),
  then a script. Records are mapped, filtered and de-duplicated; a write recipe keeps receipts so
  a repeat is skipped. `browserkit recipe install x.com` adds the built-in thread and feed
  recipes; `recipe draft <site>` turns a mapped operation and its sample into a recipe.
- **Workflow**: a saved, reusable sequence that can span sites. Typed inputs with defaults,
  templated arguments (`{{steps.<id>.field}}`), repeat/each/until, retries, delays, timeouts,
  conditional steps, dry-run and on-error handling. Runs are recorded per step and kept under the
  data folder (`browserkit workflow runs <name>`). The workflow engine is host-agnostic: browserkit
  supplies the browser actions, and other hosts can supply their own.
- **Skill**: the code escape hatch when a recipe or a workflow is not enough.

Recipes are carried in site packs (`browserkit pack export/import`); workflows and recipes move
with `workflow export/import` and `recipe export/import`.

## Sessions, network, cookies and readiness

- **Named sessions** (`browserkit sessions`): a name owns one quiet tab or its own window, keeps
  its own FIFO of cells, and survives a bridge restart. `create`, `ensure`, `reopen`, `info`,
  `cleanup` and `delete`; `list` shows live tabs, busy cells and queued work. Sessions run in
  parallel; writes across sessions are serialized by the engine's browser-wide write lock, and
  every step of one tab runs in order.
- **Host-wide network store** (`browserkit network`): every finished request from every tab the
  session used, kept for an hour in a bounded ring, so a capture survives the tab closing. Filter
  by match, origin, method, type, status, static/dynamic and time; `get`, `body`, `curl` (secrets
  redacted unless asked), `origins`, `stats`, `clear`, `export` (HAR).
- **Cookies** (`browserkit cookies`): list, set, delete and clear by domain or URL. Values are
  hidden unless `--values` is passed, so a listing does not put a session token in a terminal.
- **Typed readiness**: `page.readiness()` and `page.waitReady()` return one of ready, empty,
  loading, login, challenge, not-found or error with the evidence behind it. `browserkit check
--ready` adds it to a site check, so a walled or empty site is named instead of guessed.
- **Private network (opt-in)**: `chrome.storage.local.set({"private-network": true})` makes agent
  fetches, opens and navigations refuse private, loopback and metadata destinations. The bridge
  resolves every hostname before the request, and a tab also gets literal DNR rules in the
  `790000-798999` band for addresses a redirect or subresource might reach. Loopback on the
  `private-network-ports` allowlist (default 3000, 5173, 8080) stays open for local development.
  Chrome has no per-tab proxy, so an extension cannot block a hostname that resolves private
  before the first connection: the network store marks such a response with `privateNetwork`
  when it comes back from a private `remoteIPAddress`, which reports DNS rebinding instead of
  silently allowing it. A request that resolves private only after the preflight can still reach
  the network; it is reported after the first response, not blocked before it.

## How it fits together

```
agent ──MCP/CLI──▶ bridge (local, 127.0.0.1) ◀──WebSocket── extension (your Chrome)
```

- `packages/engine`: the browser engine: code runtime, tab ownership, input, observation, hand-off, network recording. It can be embedded in other extensions.
- `packages/boosts`: the Site Boosts engine, with its own extension build, embedded in the engine as `browser.boosts`.
- `apps/extension`: the extension that connects Chrome to the bridge.
- `apps/bridge`: the bridge, native messaging host, CLI and MCP server.
- `packages/protocol`: the messages the engine speaks.
- `packages/tools`: the `crawl` and `site_mapper` tools built on the packages below.
- `packages/site-mapper`: the site mapping and calling library (the site-to-api engine, maintained here).
- `packages/crawl`: the crawler, as its own package: plain HTTP first, a browser when a page needs one. It installs and runs on its own, without the extension.

`node scripts/link-repos.mjs --revisions` prints the revision of each linked repo.

## Development

```sh
pnpm check                    # format, types, and an end-to-end test in real Chrome (set CHROME_PATH)
pnpm test:boosts              # Site Boosts unit tests
pnpm test:site-mapper         # site API unit tests
pnpm test:crawl               # crawler tests (real Chrome too when CHROME_PATH is set)
CHROME_PATH=... pnpm test:boosts:e2e   # Site Boosts in headless Chrome for Testing
```
