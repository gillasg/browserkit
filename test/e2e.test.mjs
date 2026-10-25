// End to end: the built extension in real Chrome, the bridge, the CLI and the MCP server.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { createServer } from "node:http";
import { dataRoutes } from "./data-site.mjs";
import { LOGIN, fakeBitwarden, loginRoutes } from "./login-site.mjs";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { promisify } from "node:util";
import WebSocket from "ws";

const chromePath =
  process.env.CHROME_PATH ??
  resolve("../aeon-browser/.slice0-audit/chrome-for-testing-154.0.8037.57/chrome-win64/chrome.exe");
const extension = resolve("apps/extension/build");
const cli = resolve("apps/bridge/dist/cli.js");
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const run = promisify(execFile);
// A 1x1 PNG.
const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";

test(
  "agents drive real Chrome through the bridge, the CLI and MCP",
  {
    skip:
      !process.env.REQUIRE_E2E &&
      (!existsSync(chromePath) || !existsSync(extension) || !existsSync(cli)),
  },
  async (t) => {
    const home = await mkdtemp(join(tmpdir(), "bue-home-"));
    const bw = await fakeBitwarden("127.0.0.1");
    await writeFile(
      join(home, "password-manager.json"),
      JSON.stringify({ provider: "bitwarden", bitwardenSession: "test" }),
    );
    const env = {
      ...process.env,
      PATH: bw + delimiter + process.env.PATH,
      BROWSER_USE_EXTENSION_HOME: home,
      SITE_TO_API_HOME: join(home, "site-to-api"),
    };
    const site = createServer((request, response) => {
      if (request.url?.startsWith("/catalog")) {
        response.setHeader("content-type", "text/html");
        response.end(
          `<title>Catalog</title><h1>Catalog</h1><input id="q" placeholder="Search">
          <ul><li>Alpha</li><li>Beta</li><li>Gamma</li></ul>
          <button onclick="document.getElementById('out').textContent='added'">Add</button><p id="out"></p>
          <table><tr><th>Model</th><th>Price</th></tr><tr><td>iPhone 16</td><td>69,900</td></tr><tr><td>iPhone 16 Plus</td><td>79,900</td></tr></table>
          <a href="/catalog?page=2">Next page</a>`,
        );
        return;
      }
      if (request.url?.startsWith("/form")) {
        response.setHeader("content-type", "text/html");
        response.end(
          `<title>Signup</title>
          <div id="consent" style="position:fixed;bottom:0;left:0;right:0;height:120px;background:#eee">We use cookies to improve your experience.
          <button onclick="document.getElementById('consent').remove();document.title+=' rejected'">Reject all</button>
          <button onclick="document.getElementById('consent').remove();document.title+=' accepted'">Accept all</button></div>
          <form onsubmit="event.preventDefault();var f=this;setTimeout(function(){document.getElementById('done').textContent='Thanks, '+f.email.value+' from '+f.country.value+(f.terms.checked?' (agreed)':'')+' '+document.querySelector('[aria-label=Notes]').innerText},300)">
          <label>Email <input name="email" type="email" required></label>
          <label for="country">Country</label><select id="country" name="country"><option value="">Choose</option><option value="in">India</option><option value="fr">France</option></select>
          <fieldset><legend>Plan</legend><label><input type="radio" name="plan" value="free" checked> Free</label><label><input type="radio" name="plan" value="pro"> Pro</label></fieldset>
          <label><input type="checkbox" name="terms" style="display:none"> I agree to the terms</label>
          <input type="range" aria-label="Seats" min="1" max="10" step="1" value="3">
          <div contenteditable="true" aria-label="Notes" style="min-height:20px;border:1px solid"></div>
          <div contenteditable="true" aria-label="Message" style="min-height:20px;border:1px solid" onbeforeinput="event.preventDefault()" onpaste="event.preventDefault();this.textContent=event.clipboardData.getData('text/plain')"></div>
          <button>Continue</button></form><p id="done"></p>
          <video width="160" height="90" muted></video>`,
        );
        return;
      }
      if (request.url?.startsWith("/challenge")) {
        response.setHeader("content-type", "text/html");
        response.end(
          `<title>Just a moment...</title><div id="challenge-stage">Verify you are human</div>`,
        );
        return;
      }
      if (request.url?.startsWith("/collapsed")) {
        // A narrow-layout search box folded behind a toggle, like Wikipedia in Split View.
        response.setHeader("content-type", "text/html");
        response.end(
          `<title>Collapsed</title><header><button class="search-toggle" aria-label="Search"
          onclick="document.getElementById('box').hidden=false">S</button>
          <div id="box" hidden><input name="search" placeholder="Search"></div></header>`,
        );
        return;
      }
      if (request.url?.startsWith("/media/photo.png")) {
        response.setHeader("content-type", "image/png");
        response.end(Buffer.from(PNG, "base64"));
        return;
      }
      if (request.url?.startsWith("/media")) {
        response.setHeader("content-type", "text/html");
        response.end(
          `<title>Media</title><img id="photo" src="/media/photo.png">
          <div id="drop" style="border:1px dashed">Drop photos here<input type="file" accept="image/*" multiple style="display:none"></div>`,
        );
        return;
      }
      if (request.url?.startsWith("/api/origin")) {
        response.setHeader("content-type", "application/json");
        response.end(
          JSON.stringify({
            referer: request.headers.referer ?? null,
            origin: request.headers.origin ?? null,
          }),
        );
        return;
      }
      if (request.url?.startsWith("/api/echo")) {
        let body = "";
        request.on("data", (chunk) => (body += chunk));
        request.on("end", () => {
          response.setHeader("content-type", "application/json");
          response.end(JSON.stringify({ method: request.method, body }));
        });
        return;
      }
      if (request.url?.startsWith("/slow")) {
        setTimeout(() => {
          response.setHeader("content-type", "text/html");
          response.end("<title>Slow</title>slow");
        }, 3000);
        return;
      }
      if (request.url?.startsWith("/media/stream.m3u8")) {
        response.setHeader("content-type", "application/vnd.apple.mpegurl");
        response.end("#EXTM3U\n#EXT-X-VERSION:3\n");
        return;
      }
      if (request.url?.startsWith("/hls")) {
        response.setHeader("content-type", "text/html");
        response.end(
          `<title>HLS</title><video id="v" muted></video>
          <script>fetch("/media/stream.m3u8").catch(() => {}); window.publicFunction = (a, b) => a + b;</script>`,
        );
        return;
      }
      if (request.url?.startsWith("/provider")) {
        response.setHeader("content-type", "text/html");
        response.end(
          `<title>Provider</title>
          <div class="ql-editor" contenteditable="true"></div>
          <button aria-label="Send message" onclick="setTimeout(() => {
            document.querySelector('message-content').textContent = 'answer: ' + document.querySelector('.ql-editor').innerText;
          }, 200)">Send</button>
          <model-response><message-content></message-content></model-response>`,
        );
        return;
      }
      if (request.url?.startsWith("/api/language")) {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ language: request.headers["accept-language"] }));
        return;
      }
      if (request.url?.startsWith("/api/forbidden")) {
        response.writeHead(403, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "forbidden" }));
        return;
      }
      if (request.url?.startsWith("/api/items")) {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ items: ["a", "b", "c"] }));
        return;
      }
      if (request.url?.startsWith("/popunder")) {
        response.setHeader("content-type", "text/html");
        response.end(
          `<title>Popunder</title><button onclick="window.open('/catalog?popup', '_blank')">open</button>`,
        );
        return;
      }
      if (request.url?.startsWith("/autoplay")) {
        response.setHeader("content-type", "text/html");
        response.end(
          `<title>Autoplay</title><video id="v" autoplay loop></video><audio id="a" autoplay loop></audio>
          <script>for (const m of document.querySelectorAll('video,audio')) m.play().catch(() => {});</script>`,
        );
        return;
      }
      if (request.url?.startsWith("/job")) {
        const number = new URL(request.url, "http://localhost").searchParams.get("i") ?? "0";
        setTimeout(() => {
          response.setHeader("content-type", "text/html");
          response.end(`<title>Job ${number}</title><h1>Job ${number}</h1><p>done</p>`);
        }, 250);
        return;
      }
      if (dataRoutes(request, response)) return;
      if (loginRoutes(request, response)) return;
      response.setHeader("content-type", "text/html");
      response.end(
        `<title>Shop</title><h1>Shop</h1><button onclick="document.title='bought'">Buy</button>`,
      );
    });
    await new Promise((done) => site.listen(0, "127.0.0.1", done));
    const siteUrl = `http://127.0.0.1:${site.address().port}/`;
    const bridge = spawn(process.execPath, [cli, "serve"], { env, stdio: "ignore" });
    const profile = await mkdtemp(join(tmpdir(), "bue-chrome-"));
    let chrome;
    try {
      const state = await waitFor(async () =>
        JSON.parse(await readFile(join(home, "bridge.json"), "utf8")),
      );

      await t.test("the native host answers the extension with the bridge endpoint", async () => {
        const reply = await nativeBootstrap(env);
        assert.equal(reply.ok, true);
        assert.equal(reply.endpoint, `ws://127.0.0.1:${state.port}/aeon/v1`);
        assert.equal(reply.connectionGrant, state.token);
      });

      chrome = spawn(
        chromePath,
        [
          `--user-data-dir=${profile}`,
          "--remote-debugging-port=0",
          `--load-extension=${extension}`,
          `--disable-extensions-except=${extension}`,
          "--no-first-run",
          "--no-default-browser-check",
          "--headless=new",
          // Linux CI runners forbid the user namespaces Chrome's sandbox needs.
          ...(process.platform === "linux" && process.env.CI ? ["--no-sandbox"] : []),
          "about:blank",
        ],
        { stdio: "ignore" },
      );
      const worker = await connectExtension(profile, env);

      await t.test("the CLI runs a cell that opens a tab and acts on it", async () => {
        const { stdout } = await run(
          process.execPath,
          [
            cli,
            "repl",
            `page = await browser.openTab(${JSON.stringify(siteUrl)}); const s = await bu.state(); await bu.click(/\\[(\\d+)\\] button "Buy"/.exec(s)[1]); await page.evaluate(() => document.title)`,
          ],
          { env },
        );
        assert.match(stdout, /button "Buy"/);
        assert.match(stdout, /→ bought/);
      });

      await t.test("the CLI session keeps its variables and tabs between calls", async () => {
        const { stdout } = await run(process.execPath, [cli, "repl", "page.url"], { env });
        assert.match(stdout, new RegExp("→ " + siteUrl.replaceAll(".", "\\.")));
      });

      await t.test("a timed-out cell keeps its variables and tabs for the next cell", async () => {
        const timed = await run(
          process.execPath,
          [
            cli,
            "repl",
            "--session",
            "deadline",
            "--timeout",
            "1000",
            `page = await browser.openTab(${JSON.stringify(siteUrl)});
            kept = 42;
            await new Promise((done) => setTimeout(done, 8000));
            kept`,
          ],
          { env },
        ).catch((error) => error);
        const output = String(timed.stdout ?? "") + String(timed.stderr ?? "");
        assert.match(output, /deadline/i, output);
        const after = await run(
          process.execPath,
          [cli, "repl", "--session", "deadline", "kept + 1"],
          { env },
        );
        assert.match(after.stdout, /→ 43/, after.stdout);
        const pageAfter = await run(
          process.execPath,
          [cli, "repl", "--session", "deadline", "page.url"],
          { env },
        );
        assert.match(
          pageAfter.stdout,
          new RegExp(siteUrl.replaceAll(".", "\\.")),
          pageAfter.stdout,
        );
      });

      await t.test("openTab makes the new tab current and bu.use takes a tab id", async () => {
        const { stdout } = await run(
          process.execPath,
          [
            cli,
            "repl",
            `const first = page.target.tabId; await browser.openTab(${JSON.stringify(siteUrl + "api/items")}, {newTab: true}); const opened = page.url; await bu.use(first); [opened.endsWith("/api/items"), page.target.tabId === first]`,
          ],
          { env },
        );
        assert.match(stdout, /→ \[\s*true,\s*true\s*\]/);
      });

      await t.test(
        "common Playwright habits work: getTab, page.playwright, load states, wheel scrolls",
        async () => {
          const { stdout } = await run(
            process.execPath,
            [
              cli,
              "repl",
              `const tab = await browser.getTab(page.target.tabId); await tab.playwright.waitForLoadState('domcontentloaded'); await tab.waitForLoadState('load', { timeout: 20000 }); await tab.scroll({ deltaY: 300 }); await tab.scroll({ direction: 'up', amount: 300 }); await tab.title()`,
            ],
            { env },
          );
          assert.match(stdout, /→ "Shop"|→ Shop|bought/);
        },
      );

      await t.test("agent tabs are grouped, and rules, history and bookmarks work", async () => {
        const cell = (code) =>
          run(process.execPath, [cli, "repl", "--session", "tools", code], { env });
        const opened = await cell(
          `page = await browser.openTab(${JSON.stringify(siteUrl)}); page.target.tabId`,
        );
        assert.match(opened.stdout, /→ \d+/, opened.stdout + opened.stderr);
        const tabId = Number(/→ (\d+)/.exec(opened.stdout)[1]);
        const grouped = await worker("Runtime.evaluate", {
          expression: `chrome.tabs.get(${tabId}).then(async (t) => t.groupId === -1 ? null : (await chrome.tabGroups.get(t.groupId)).title)`,
          awaitPromise: true,
          returnByValue: true,
        });
        assert.equal(String(grouped.result.result.value).replace(/\u2063.*$/, ""), "Agent");

        const { stdout } = await cell(`
          await page.rules.block({ urls: ["/api/items"] });
          await page.rules.mock("/api/mocked", { mocked: true });
          await page.rules.headers({ "Accept-Language": "hi-IN" });
          const blocked = await page.evaluate(() => fetch("/api/items").then(() => "loaded", () => "blocked"));
          const mocked = await page.evaluate(() => fetch("/api/mocked").then((r) => r.json()));
          const language = (await page.fetchJson("/api/language")).language;
          const rules = (await page.rules.list()).length;
          await page.rules.clear();
          const after = await page.evaluate(() => fetch("/api/items").then(() => "loaded", () => "blocked"));
          const visited = (await browser.history.search("Shop", { days: 1 })).length > 0;
          const mark = await browser.bookmarks.create({ title: "bue-test", url: ${JSON.stringify(siteUrl)} });
          const found = (await browser.bookmarks.search("bue-test")).length;
          await browser.bookmarks.remove(mark.id);
          console.log("RESULT " + JSON.stringify({ blocked, mocked, language, rules, after, visited, found }))`);
        assert.match(stdout, /RESULT /, stdout);
        assert.deepEqual(JSON.parse(/RESULT (.*)/.exec(stdout)[1]), {
          blocked: "blocked",
          mocked: { mocked: true },
          language: "hi-IN",
          rules: 3,
          after: "loaded",
          visited: true,
          found: 1,
        });
      });

      await t.test("only the agent's own tabs join its group", async () => {
        const cell = (code) =>
          run(process.execPath, [cli, "repl", "--session", "tab-groups", code], { env });
        const opened = await cell(
          `page = await browser.openTab(${JSON.stringify(siteUrl + "?grouped")}, { newTab: true }); console.log("AGENT " + page.target.tabId)`,
        );
        const agentId = Number(/AGENT (\d+)/.exec(opened.stdout)[1]);
        const info = async (id) =>
          (
            await worker("Runtime.evaluate", {
              expression: `chrome.tabs.get(${id}).then((t) => ({ groupId: t.groupId, windowId: t.windowId }))`,
              awaitPromise: true,
              returnByValue: true,
            })
          ).result.result.value;
        const agent = await info(agentId);
        assert.ok(agent.groupId >= 0, opened.stdout);

        // A tab Chrome creates for a link or window.open: it inherits the opener's group on its
        // own, and the guard has to take it back out.
        const linked = (
          await worker("Runtime.evaluate", {
            expression: `chrome.tabs.create({ windowId: ${agent.windowId}, openerTabId: ${agentId}, url: ${JSON.stringify(siteUrl + "?linked")}, active: false }).then((t) => t.id)`,
            awaitPromise: true,
            returnByValue: true,
          })
        ).result.result.value;
        await new Promise((done) => setTimeout(done, 600));
        assert.equal((await info(linked)).groupId, -1, "a link tab stays out of the group");

        // A real target=_blank click and window.open from the agent's page.
        const popups = await cell(`
          const before = new Set((await browser.tabs()).map((tab) => tab.id));
          await page.evaluate(() => {
            const a = document.createElement("a");
            a.id = "blank-link"; a.href = "/next"; a.target = "_blank"; a.textContent = "next";
            const b = document.createElement("button");
            b.id = "win-button"; b.textContent = "win";
            b.onclick = () => window.open("/next2", "_blank");
            document.body.append(a, b);
          });
          // A real click carries user activation, so Chrome opens the tab.
          await page.locator("#blank-link").click();
          await new Promise((done) => setTimeout(done, 900));
          await page.locator("#win-button").click();
          await new Promise((done) => setTimeout(done, 900));
          const fresh = (await browser.tabs()).filter((tab) => !before.has(tab.id));
          console.log("NEW " + JSON.stringify({
            tabs: fresh.map((tab) => ({ id: tab.id, groupId: tab.groupId, url: tab.url })),
          }));`);
        const fresh = JSON.parse(/NEW (.*)/.exec(popups.stdout)[1]);
        assert.ok(fresh.tabs.length >= 2, popups.stdout);
        for (const tab of fresh.tabs) assert.equal(tab.groupId, -1, popups.stdout);

        // A plain new tab in the same window (Ctrl+T) is not the agent's.
        const plain = (
          await worker("Runtime.evaluate", {
            expression: `chrome.tabs.create({ windowId: ${agent.windowId}, active: false }).then((t) => t.id)`,
            awaitPromise: true,
            returnByValue: true,
          })
        ).result.result.value;
        await new Promise((done) => setTimeout(done, 300));
        assert.equal((await info(plain)).groupId, -1);

        // The user's own group is left alone.
        const user = (
          await worker("Runtime.evaluate", {
            expression: `(async () => {
              const windowId = ${agent.windowId};
              const a = await chrome.tabs.create({ windowId, url: ${JSON.stringify(siteUrl + "?user-a")}, active: false });
              const b = await chrome.tabs.create({ windowId, url: ${JSON.stringify(siteUrl + "?user-b")}, active: false });
              const groupId = await chrome.tabs.group({ tabIds: [a.id, b.id], createProperties: { windowId } });
              await chrome.tabGroups.update(groupId, { title: "User picks" });
              return { groupId, tabs: [a.id, b.id] };
            })()`,
            awaitPromise: true,
            returnByValue: true,
          })
        ).result.result.value;
        await cell(`await page.getByRole("button", { name: "Buy" }).click(); null`);
        await new Promise((done) => setTimeout(done, 400));
        for (const id of user.tabs) assert.equal((await info(id)).groupId, user.groupId);

        // The setting turns grouping off for tabs opened afterwards.
        const off = await cell(`
          const before = await browser.tabGrouping();
          await browser.tabGrouping(false);
          const tab = await browser.openTab(${JSON.stringify(siteUrl + "?ungrouped")}, { newTab: true });
          const grouped = (await browser.tabs()).find((item) => item.id === tab.target.tabId)?.groupId;
          await browser.tabGrouping(true);
          console.log("OFF " + JSON.stringify({ before, grouped }));`);
        const setting = JSON.parse(/OFF (.*)/.exec(off.stdout)[1]);
        assert.equal(setting.before, true, off.stdout);
        assert.equal(setting.grouped, -1, off.stdout);

        await worker("Runtime.evaluate", {
          expression: `chrome.tabs.remove([${user.tabs.join(",")}, ${linked}, ${plain}])`,
          awaitPromise: true,
        });
      });

      await t.test("the agent feedback conveniences answer in one cell", async () => {
        const cell = (code) =>
          run(process.execPath, [cli, "repl", "--session", "feedback", code], { env });
        const { stdout } = await cell(`
          page = await browser.openTab(${JSON.stringify(siteUrl + "?feedback")});
          const mine = await browser.myTabs();
          const filtered = await browser.tabs({ mine: true });
          const failure = await page.navigate("http://127.0.0.1:1/nope").then(() => null, (error) => String(error.message || error));
          const lastError = page.lastError;
          const forbidden = await browser.fetch(${JSON.stringify(siteUrl + "api/forbidden")}).then((result) => ({ status: result.status, hint: result.hint }), (error) => ({ error: String(error.message || error) }));
          console.log("FEEDBACK " + JSON.stringify({
            mine: mine.map((tab) => tab.id),
            filtered: filtered.map((tab) => tab.id),
            failure,
            lastError,
            forbidden,
          }));`);
        const value = JSON.parse(/FEEDBACK (.*)/.exec(stdout)[1]);
        assert.ok(value.mine.length >= 1, stdout);
        assert.deepEqual(value.filtered, value.mine, stdout);
        assert.ok(value.failure, stdout);
        assert.equal(value.lastError.url, "http://127.0.0.1:1/nope", stdout);
        assert.ok(value.lastError.code, stdout);
        assert.equal(value.lastError.stage, "navigate", stdout);
        assert.equal(value.forbidden.status, 403, stdout);
        assert.match(String(value.forbidden.hint), /referer|origin/i, stdout);

        // A cell from a file, and --quiet keeps stdout empty.
        const file = join(home, "cell.js");
        await writeFile(file, "6 * 7");
        const quiet = await run(
          process.execPath,
          [cli, "repl", "@" + file, "--session", "feedback-file", "--quiet"],
          { env },
        );
        assert.equal(quiet.stdout.trim(), "");
        const loud = await run(
          process.execPath,
          [cli, "repl", "@" + file, "--session", "feedback-file"],
          { env },
        );
        assert.match(loud.stdout, /42/);

        const summary = await run(process.execPath, [cli, "commands", "--summary"], { env });
        assert.match(summary.stdout, /ask: /);

        // Providers are listed without touching a provider, and a bad name says so.
        const listed = JSON.parse(
          (await run(process.execPath, [cli, "providers", "--json"], { env })).stdout,
        );
        assert.equal(listed.providers.length, 5, JSON.stringify(listed));
        const unknown = await run(process.execPath, [cli, "ask", "nope", "hello", "--json"], {
          env,
        }).then(
          () => "",
          (error) =>
            String(error.stdout ?? "") + String(error.stderr ?? "") + String(error.message ?? ""),
        );
        assert.match(unknown, /PROVIDER_UNKNOWN/);
      });

      await t.test(
        "the browser surfaces answer DNS, media, functions and workspace reads",
        async () => {
          const cell = (code) =>
            run(process.execPath, [cli, "repl", "--session", "surfaces", code], { env });
          const { stdout } = await cell(`
          page = await browser.openTab(${JSON.stringify(siteUrl + "hls")});
          await page.waitForTimeout(1200);
          const manifest = await page.media.manifest();
          const funcs = await page.functions();
          const dns = await page.dns();
          await page.setExtraHTTPHeaders({ "accept-language": "fr-FR" });
          const language = await page.evaluate(() => fetch("/api/language").then((reply) => reply.json()));
          const origin = await browser.fetch(${JSON.stringify(siteUrl + "api/origin")}, { asOrigin: true }).then((reply) => reply.json);
          const echo = await browser.fetch(${JSON.stringify(siteUrl + "api/echo")}, { method: "POST", json: { hello: "world" } }).then((reply) => reply.json);
          const exported = await page.network.export({ match: "stream.m3u8" });
          await artifact("hello.txt", "from the workspace");
          const read = await browser.workspace.read("hello.txt");
          const listed = await browser.workspace.list("");
          const slow = await page.navigate(${JSON.stringify(siteUrl + "slow")}, { timeoutMs: 900 });
          console.log("SURFACES " + JSON.stringify({
            manifest,
            funcs: funcs.filter((fn) => fn.name === "publicFunction"),
            dns,
            language,
            origin,
            echo,
            exported: exported.requests.map((item) => ({ method: item.method, url: item.url })),
            read,
            listed: listed.map((entry) => entry.name),
            slow,
          }));`);
          const value = JSON.parse(/SURFACES (.*)/.exec(stdout)[1]);
          assert.equal(value.manifest.kind, "hls", stdout);
          assert.match(value.manifest.url, /stream\.m3u8/, stdout);
          assert.deepEqual(value.funcs, [{ name: "publicFunction", arity: 2 }], stdout);
          assert.equal(value.dns.address, "127.0.0.1", stdout);
          assert.equal(value.language.language, "fr-FR", stdout);
          assert.match(String(value.origin.referer), /127\.0\.0\.1/, stdout);
          assert.equal(value.echo.body, JSON.stringify({ hello: "world" }), stdout);
          assert.ok(
            value.exported.some((item) => item.url.includes("stream.m3u8")),
            stdout,
          );
          assert.equal(value.read, "from the workspace", stdout);
          assert.ok(value.listed.includes("hello.txt"), stdout);
          assert.ok(value.slow?.timedOut === true || value.slow?.data?.timedOut === true, stdout);

          const kept = await cell(
            `page = await browser.keepPage(${JSON.stringify(siteUrl + "?kept-warm")}); page.target.tabId`,
          );
          const keptId = Number(/(\d+)\s*$/.exec(kept.stdout)?.[1]);
          assert.ok(Number.isInteger(keptId), kept.stdout);
          const again = await cell(
            `page = await browser.keepPage(${JSON.stringify(siteUrl + "?kept-warm")}); page.target.tabId`,
          );
          assert.match(again.stdout, new RegExp(`\\b${keptId}\\b`), again.stdout);
        },
      );

      await t.test(
        "browser results count the tabs a run owns, and reset keeps only kept tabs",
        async () => {
          const cell = (code) =>
            run(process.execPath, [cli, "repl", "--session", "tabs-reset", code], { env });
          const opened = await cell(
            `page = await browser.openTab(${JSON.stringify(siteUrl + "?tab-line")}); page.target.tabId`,
          );
          assert.match(
            opened.stdout,
            /tabs: opened \d+, closed \d+, mine \d+ \(\d+\), total \d+/,
            opened.stdout,
          );
          const reset = await cell(`
          const kept = await browser.openTab(${JSON.stringify(siteUrl + "?kept")}, { newTab: true });
          await kept.keep();
          await browser.openTab(${JSON.stringify(siteUrl + "?discard")}, { newTab: true });
          const result = await browser.reset();
          ({ result, urls: (await browser.tabs()).map((tab) => tab.url) });`);
          const parsed = JSON.parse(
            reset.stdout
              .slice(reset.stdout.indexOf("→ ") + 2, reset.stdout.lastIndexOf("\ntabs:"))
              .trim(),
          );
          const value = parsed.result;
          assert.ok(value.closed.length >= 1, reset.stdout);
          const urls = parsed.urls;
          assert.ok(
            urls.some((url) => url.endsWith("?kept")),
            reset.stdout,
          );
          assert.ok(!urls.some((url) => url.endsWith("?discard")), reset.stdout);
        },
      );

      await t.test("closeTab closes this chat's tabs and refuses the user's", async () => {
        const created = await worker("Runtime.evaluate", {
          expression: `chrome.tabs.create({ url: ${JSON.stringify(siteUrl + "?user-tab")}, active: false }).then((tab) => tab.id)`,
          awaitPromise: true,
          returnByValue: true,
        });
        const userTabId = created.result.result.value;
        const cell = (code) =>
          run(process.execPath, [cli, "repl", "--session", "close-tabs", code], { env });
        const closed = await cell(`
          const mine = await browser.openTab(${JSON.stringify(siteUrl + "?mine")}, { newTab: true });
          const mineId = mine.target.tabId;
          const listed = await browser.tabs();
          const mineIds = listed.filter((tab) => tab.mine).map((tab) => tab.id);
          const userMine = listed.find((tab) => tab.id === ${userTabId})?.mine;
          const result = await browser.closeTab(mineId);
          const gone = await (async () => {
            for (let i = 0; i < 50; i++) {
              if (!(await browser.tabs()).some((tab) => tab.id === mineId)) return true;
              await new Promise((done) => setTimeout(done, 50));
            }
            return false;
          })();
          const userError = await browser.closeTab(${userTabId}).then(() => null, (error) => String(error.message || error));
          const userStill = (await browser.tabs()).some((tab) => tab.id === ${userTabId});
          console.log("CLOSE " + JSON.stringify({ mineId, mineIds, userMine, result, gone, userError, userStill }));`);
        assert.match(closed.stdout, /CLOSE /, closed.stdout);
        const value = JSON.parse(/CLOSE (.*)/.exec(closed.stdout)[1]);
        assert.ok(value.mineIds.length >= 1, closed.stdout);
        assert.equal(value.userMine, false, closed.stdout);
        assert.deepEqual(value.result, { closed: value.mineId }, closed.stdout);
        assert.equal(value.gone, true, closed.stdout);
        assert.match(String(value.userError), /TAB_NOT_YOURS/, closed.stdout);
        assert.equal(value.userStill, true, closed.stdout);

        const splitSupport = await worker("Runtime.evaluate", {
          expression: "typeof chrome.tabs.createSplit",
          returnByValue: true,
        });
        if (splitSupport.result.result.value === "function") {
          const opened = await cell(`
            const first = await browser.openTab(${JSON.stringify(siteUrl + "?split-a")}, { newTab: true });
            const second = await browser.openTab(${JSON.stringify(siteUrl + "?split-b")}, { newTab: true });
            console.log("SPLIT " + JSON.stringify({ first: first.target.tabId, second: second.target.tabId }));`);
          const splitIds = JSON.parse(/SPLIT (.*)/.exec(opened.stdout)[1]);
          const split = await worker("Runtime.evaluate", {
            expression: `chrome.tabs.createSplit([${splitIds.first}, ${splitIds.second}]).then((id) => id)`,
            awaitPromise: true,
            returnByValue: true,
          });
          assert.equal(typeof split.result.result.value, "number", JSON.stringify(split));
          const after = await cell(`
            const result = await browser.closeTab(${splitIds.first});
            const firstGone = await (async () => {
              for (let i = 0; i < 50; i++) {
                if (!(await browser.tabs()).some((tab) => tab.id === ${splitIds.first})) return true;
                await new Promise((done) => setTimeout(done, 50));
              }
              return false;
            })();
            const tabs = await browser.tabs();
            console.log("SPLITCLOSE " + JSON.stringify({
              result,
              firstGone,
              secondThere: tabs.some((tab) => tab.id === ${splitIds.second}),
            }));`);
          const splitClosed = JSON.parse(/SPLITCLOSE (.*)/.exec(after.stdout)[1]);
          assert.deepEqual(splitClosed.result, { closed: splitIds.first }, after.stdout);
          assert.equal(splitClosed.firstGone, true, after.stdout);
          assert.equal(splitClosed.secondThere, true, after.stdout);
          const pair = await worker("Runtime.evaluate", {
            expression: `chrome.tabs.get(${splitIds.second}).then((tab) => tab.splitViewId)`,
            awaitPromise: true,
            returnByValue: true,
          });
          assert.equal(pair.result.result.value, -1, JSON.stringify(pair));
          await cell(`await browser.closeTab(${splitIds.second});`);
        }
        await worker("Runtime.evaluate", {
          expression: `chrome.tabs.remove(${userTabId})`,
          awaitPromise: true,
        });
      });

      await t.test(
        "popups park without joining the agent group, and a quiet tab blocks them",
        async () => {
          const cell = (code) =>
            run(process.execPath, [cli, "repl", "--session", "popups", code], { env });
          const parked = await cell(`
          page = await browser.openTab(${JSON.stringify(siteUrl + "popunder")}, { newTab: true });
          await page.getByRole("button", { name: "open" }).click();
          await new Promise((done) => setTimeout(done, 1200));
          const popups = (await page.popups()).data.tabs;
          const tabs = await browser.tabs();
          console.log("POPUPS " + JSON.stringify({
            popups: popups.map((tab) => ({ id: tab.target.tabId, url: tab.url, groupId: tab.groupId, active: tab.active })),
            active: tabs.filter((tab) => tab.active).map((tab) => tab.url),
          }));`);
          const seen = JSON.parse(/POPUPS (.*)/.exec(parked.stdout)[1]);
          assert.equal(seen.popups.length, 1, parked.stdout);
          assert.match(seen.popups[0].url, /popup/, parked.stdout);
          assert.equal(seen.popups[0].active, false, parked.stdout);
          assert.equal(seen.popups[0].groupId, -1, parked.stdout);

          const quiet = await cell(`
          page = await browser.openTab(${JSON.stringify(siteUrl + "popunder")}, { newTab: true, quiet: true });
          await page.getByRole("button", { name: "open" }).click();
          await new Promise((done) => setTimeout(done, 800));
          const popups = (await page.popups()).data.tabs;
          const media = await page.evaluate(() => Array.from(document.querySelectorAll("video,audio")).map((item) => ({
            paused: item.paused, muted: item.muted, autoplay: item.autoplay,
          })));
          console.log("QUIET " + JSON.stringify({ popups: popups.length, media }));`);
          const quietSeen = JSON.parse(/QUIET (.*)/.exec(quiet.stdout)[1]);
          assert.equal(quietSeen.popups, 0, quiet.stdout);
        },
      );

      await t.test("a quiet autoplay page is paused and muted", async () => {
        const { stdout } = await run(
          process.execPath,
          [
            cli,
            "repl",
            "--session",
            "quiet-media",
            `page = await browser.openTab(${JSON.stringify(siteUrl + "autoplay")}, { newTab: true, quiet: true });
            await new Promise((done) => setTimeout(done, 500));
            console.log("MEDIA " + JSON.stringify(await page.evaluate(() => Array.from(document.querySelectorAll("video,audio")).map((item) => ({ paused: item.paused, muted: item.muted, autoplay: item.autoplay })))));`,
          ],
          { env },
        );
        const media = JSON.parse(/MEDIA (.*)/.exec(stdout)[1]);
        assert.deepEqual(
          media.map((item) => [item.paused, item.muted, item.autoplay]),
          [
            [true, true, false],
            [true, true, false],
          ],
          stdout,
        );
      });

      await t.test("browser.job outlives the cell and reports per-item results", async () => {
        const cell = (code) =>
          run(process.execPath, [cli, "repl", "--session", "jobs", code], { env });
        const started = await cell(`
          job = await browser.job([
            ${JSON.stringify(siteUrl + "job?i=1")},
            ${JSON.stringify(siteUrl + "job?i=2")}
          ], async (tab, item) => ({ item, title: await tab.title() }), { concurrency: 1, timeoutMs: 15000 });
          console.log("JOB " + JSON.stringify(job));`);
        const job = JSON.parse(/JOB (.*)/.exec(started.stdout)[1]);
        assert.equal(job.status, "running", started.stdout);
        await sleep(4000);
        const result = await cell(`
          const state = await browser.job.status(job.jobId);
          const done = await browser.job.result(job.jobId);
          console.log("JOBRESULT " + JSON.stringify({ state, done }));`);
        const seen = JSON.parse(/JOBRESULT (.*)/.exec(result.stdout)[1]);
        assert.equal(seen.state.status, "complete", result.stdout);
        assert.equal(seen.done.results.length, 2, result.stdout);
        assert.deepEqual(
          seen.done.results.map((item) => item.value.title),
          ["Job 1", "Job 2"],
          result.stdout,
        );
      });

      await t.test("a tab the user closed is reopened fresh with a warning", async () => {
        const { stdout } = await run(
          process.execPath,
          [
            cli,
            "repl",
            "--session",
            "closed-tab",
            `page = await browser.openTab(${JSON.stringify(siteUrl + "?closed")}, { newTab: true });
            const first = page.target.tabId;
            await page.close();
            const fresh = await browser.openTab(${JSON.stringify(siteUrl + "?closed")}).then((tab) => tab.target.tabId, (error) => "error: " + error.message);
            const live = (await browser.tabs()).some((tab) => tab.id === fresh);
            console.log("CLOSED " + JSON.stringify({ first, fresh, live }));`,
          ],
          { env },
        );
        const value = JSON.parse(/CLOSED (.*)/.exec(stdout)[1]);
        assert.equal(typeof value.fresh, "number", stdout);
        assert.notEqual(value.fresh, value.first, stdout);
        assert.equal(value.live, true, stdout);
        assert.match(stdout, /opened a fresh tab/, stdout);
      });

      await t.test("activeTab returns a live active tab", async () => {
        const { stdout } = await run(
          process.execPath,
          [
            cli,
            "repl",
            "--session",
            "active-window",
            `const first = await browser.openTab(${JSON.stringify(siteUrl + "?window-one")}, { newTab: true, foreground: true });
            const active = await browser.activeTab();
            const tabs = await browser.tabs();
            console.log("ACTIVE " + JSON.stringify({
              active: active.target.tabId,
              live: tabs.some((tab) => tab.target.tabId === active.target.tabId && tab.active),
              first: first.target.tabId,
            }));`,
          ],
          { env },
        );
        const seen = JSON.parse(/ACTIVE (.*)/.exec(stdout)[1]);
        assert.equal(seen.live, true, stdout);
      });

      await t.test("tabs are reused, permissions preset, and the cursor shows", async () => {
        const { stdout } = await run(
          process.execPath,
          [
            cli,
            "repl",
            "--session",
            "reuse",
            `const a = await browser.openTab(${JSON.stringify(siteUrl)});
            const b = await browser.openTab(${JSON.stringify(siteUrl)});
            const flat = (await browser.tabs()).every((tab) => typeof tab.tabId === "number");
            await page.setLocation(28.61, 77.21);
            const latitude = await page.evaluate(() => new Promise((done) =>
              navigator.geolocation.getCurrentPosition((p) => done(p.coords.latitude), (e) => done("error " + e.code))));
            await page.getByRole("button", { name: "Buy" }).click();
            const cursor = await page.evaluate(() => Boolean(document.getElementById("aeon-agent-cursor")));
            console.log("RESULT " + JSON.stringify({ reused: a.target.tabId === b.target.tabId, flat, latitude, cursor }))`,
          ],
          { env },
        );
        assert.match(stdout, /RESULT /, stdout);
        assert.deepEqual(JSON.parse(/RESULT (.*)/.exec(stdout)[1]), {
          reused: true,
          flat: true,
          latitude: 28.61,
          cursor: true,
        });
      });

      await t.test(
        "quiet reads, moving tabs, network list without start, large artifacts in pieces",
        async () => {
          await run(
            process.execPath,
            [
              cli,
              "repl",
              "--session",
              "quiet",
              `await browser.openTab(${JSON.stringify(siteUrl)})`,
            ],
            { env },
          );
          const read = await run(
            process.execPath,
            [cli, "repl", "--session", "quiet", "await page.evaluate(() => document.title)"],
            { env },
          );
          assert.doesNotMatch(read.stdout, /\[ok\] evaluate/, read.stdout);
          const { stdout } = await run(
            process.execPath,
            [
              cli,
              "repl",
              "--session",
              "quiet",
              `const first = await browser.openTab(${JSON.stringify(siteUrl + "?a")}, { newTab: true });
            const second = await browser.openTab(${JSON.stringify(siteUrl + "?b")}, { newTab: true });
            const [moved] = await browser.moveTab(second, { index: 0 });
            const listed = await second.network.list();
            const saved = await artifact("big.txt", "x".repeat(2500000) + "é");
            console.log("RESULT " + JSON.stringify({
              movedFirst: moved.index === 0 && moved.tabId === second.target.tabId,
              listed: Array.isArray(listed),
              bytes: saved.bytes,
            }))`,
            ],
            { env },
          );
          assert.match(stdout, /RESULT /, stdout);
          assert.deepEqual(JSON.parse(/RESULT (.*)/.exec(stdout)[1]), {
            movedFirst: true,
            listed: true,
            bytes: 2500002,
          });
          // A tab picked from browser.tabs() is attached by its listed entry.
          const attached = await run(
            process.execPath,
            [
              cli,
              "repl",
              "--session",
              "quiet",
              `const [listed] = await browser.tabs(${JSON.stringify(siteUrl + "?a")});
            const borrowed = await browser.attachTab(listed);
            const active = await browser.activeTab().catch((error) => error.message);
            console.log("ATTACHED " + JSON.stringify(await borrowed.evaluate(() => location.search)));
            console.log("GUESSES " + JSON.stringify({
              id: listed.id === listed.tabId,
              listedTitle: await listed.evaluate(() => document.title),
              active: typeof active.tabId === "number" || /not a web page/.test(active),
              snapshot: typeof (await borrowed.domSnapshot()) === "string",
            }));
            await borrowed.goto(${JSON.stringify(siteUrl + "collapsed")});
            const hidden = await borrowed.locator("input[name=search]").fill("x").catch((error) => String(error.message));
            console.log("HIDDEN " + JSON.stringify(hidden))`,
            ],
            { env },
          );
          assert.match(attached.stdout, /ATTACHED "\?a"/, attached.stdout + attached.stderr);
          assert.deepEqual(JSON.parse(/GUESSES (.*)/.exec(attached.stdout)[1]), {
            id: true,
            listedTitle: "Shop",
            active: true,
            snapshot: true,
          });
          assert.match(
            attached.stdout,
            /HIDDEN .*TARGET_HIDDEN.*button\.search-toggle/,
            attached.stdout,
          );
        },
      );

      await t.test(
        "recording: own window, timed actions, hover, mouse steps, onCdp, recordTab",
        async () => {
          const { stdout } = await run(
            process.execPath,
            [
              cli,
              "repl",
              "--session",
              "record",
              `const p = await browser.openTab(${JSON.stringify(siteUrl)}, { window: { width: 900, height: 700 } });
            const recording = await p.recordTab({ fps: 30, name: "demo" });
            const hovered = await p.getByRole("button", { name: "Buy" }).hover();
            const clicked = await p.getByRole("button", { name: "Buy" }).click();
            const box = await p.getByRole("button", { name: "Buy" }).boundingBox();
            const moves = [];
            const stream = p.onCdp("Runtime.consoleAPICalled", (params) => moves.push(params.type));
            await stream.ready;
            await p.cdp("Runtime.enable", {});
            await p.evaluate(() => { console.log("one"); console.warn("two"); });
            const before = Date.now();
            await p.mouse.move(10, 10);
            await p.mouse.move(300, 200, { steps: 20 });
            const moveMs = Date.now() - before;
            await new Promise((done) => setTimeout(done, 1500));
            await stream.stop();
            const summary = await recording.stop();
            console.log("RESULT " + JSON.stringify({
              hovered: Boolean(hovered.box && hovered.box.width > 0 && hovered.tStart <= hovered.tEnd),
              clicked: Boolean(clicked.box && clicked.tEnd >= clicked.tStart),
              box: box.width > 0 && box.height > 0,
              logs: moves.includes("log") && moves.includes("warning"),
              fastMoves: moveMs < 4000,
              frames: summary.frames > 0,
              folder: summary.folder,
            }))`,
            ],
            { env },
          );
          assert.match(stdout, /RESULT /, stdout);
          assert.deepEqual(JSON.parse(/RESULT (.*)/.exec(stdout)[1]), {
            hovered: true,
            clicked: true,
            box: true,
            logs: true,
            fastMoves: true,
            frames: true,
            folder: "demo",
          });
        },
      );

      await t.test(
        "page.list reads every row of a virtualized list; tabs print compactly; unknown names get a useful hint",
        async () => {
          const { stdout } = await run(
            process.execPath,
            [
              cli,
              "repl",
              "--session",
              "lists",
              `page = await browser.openTab(${JSON.stringify(siteUrl + "virtual")});
            await page.evaluate(() => { document.getElementById("scroller").scrollTop = 3000; });
            const all = await page.list();
            const again = await page.list();
            const capped = await page.list(null, {max: 10});
            const open = all.items.filter((item) => /Yet to apply/.test(item.text)).map((item) => item.text);
            const scrolled = await page.evaluate(() => document.getElementById("scroller").scrollTop);
            const [tab] = await browser.tabs(${JSON.stringify(siteUrl + "virtual")});
            console.log("LIST " + JSON.stringify({count: all.count, complete: all.complete, partial: all.partial, againCount: again.count, againComplete: again.complete, cappedPartial: capped.partial, first: all.items[0].text, open, scrolled}));
            console.log("TAB " + JSON.stringify({keys: Object.keys(JSON.parse(JSON.stringify(tab))), hasTarget: Boolean(tab.target && tab.tabId)}));`,
            ],
            { env },
          );
          assert.deepEqual(
            JSON.parse(/LIST (.*)/.exec(stdout)[1]),
            {
              count: 150,
              complete: true,
              partial: false,
              againCount: 150,
              againComplete: true,
              cappedPartial: true,
              first: "Job 0 Applications closed",
              open: ["Job 120 Yet to apply"],
              scrolled: 3000,
            },
            stdout,
          );
          assert.deepEqual(JSON.parse(/TAB (.*)/.exec(stdout)[1]), {
            keys: ["id", "title", "url", "active", "mine"],
            hasTarget: true,
          });
          const missing = await run(
            process.execPath,
            [cli, "repl", "--session", "lists", "text(JSON.stringify(1))"],
            { env },
          ).catch((error) => error);
          const output = String(missing.stdout ?? "") + String(missing.stderr ?? "");
          assert.match(output, /nothing called text exists here/, output);
          assert.doesNotMatch(output, /WebGL/, output);
          // A top-level name that is also a browser global keeps the agent's value in its cell.
          const shadowed = await run(
            process.execPath,
            [
              cli,
              "repl",
              "--session",
              "lists",
              "const [history, name] = await Promise.all([Promise.resolve([1, 2, 3]), 'kept']); ({count: history.length, name})",
            ],
            { env },
          );
          assert.match(shadowed.stdout, /"count": ?3/, shadowed.stdout);
          assert.match(shadowed.stdout, /"name": ?"kept"/, shadowed.stdout);
          assert.match(shadowed.stdout, /browser global names/, shadowed.stdout);
          // A cell that works but goes the long way gets one tip, once per session.
          const tipCode = "await page.evaluate(() => localStorage.length)";
          const tipped = await run(process.execPath, [cli, "repl", "--session", "lists", tipCode], {
            env,
          });
          assert.match(tipped.stdout, /Tip: never read sign-in data/, tipped.stdout);
          const again = await run(process.execPath, [cli, "repl", "--session", "lists", tipCode], {
            env,
          });
          assert.doesNotMatch(again.stdout, /Tip:/, again.stdout);
          // A tab another session is driving: attaching gives this session its own copy.
          const copy = await run(
            process.execPath,
            [
              cli,
              "repl",
              "--session",
              "lists-other",
              `const [held] = await browser.tabs(${JSON.stringify(siteUrl + "virtual")});
            const mine = await browser.attachTab(held);
            console.log("COPY " + JSON.stringify({other: mine.target.tabId !== held.id, url: mine.url()}));`,
            ],
            { env },
          );
          assert.match(copy.stdout, /in use by another chat/, copy.stdout);
          assert.deepEqual(JSON.parse(/COPY (.*)/.exec(copy.stdout)[1]), {
            other: true,
            url: siteUrl + "virtual",
          });
        },
      );

      await t.test(
        "Playwright-style calls, extraction, one group for parallel tabs, Google parsing",
        async () => {
          const catalog = siteUrl + "catalog";
          const { stdout } = await run(
            process.execPath,
            [
              cli,
              "repl",
              "--session",
              "playwright",
              `page = await browser.openTab(${JSON.stringify(catalog)});
            const title = await page.title();
            const url = page.url();
            const count = await page.locator("li").count();
            const second = await page.locator("li").nth(1).innerText();
            const texts = await page.locator("li").allInnerTexts();
            const heading = await page.$eval("h1", (el) => el.textContent);
            const items = await page.$$eval("li", (els) => els.length);
            await page.getByRole("button", { name: "Add" }).click();
            const added = await page.textContent("#out");
            await page.fill("#q", "phones");
            const typed = await page.inputValue("#q");
            const rows = await page.table("table");
            const links = (await page.links()).map((link) => link.text);
            const regexText = await page.getByText(/^Gam/).innerText();
            await page.evaluate(() => { document.getElementById("out").textContent = ""; });
            await page.getByRole("button", { name: /^ad+$/i }).click();
            const regexClick = await page.textContent("#out");
            const viaTab = String((await browser.tab(page.target.tabId)).url);
            await page.evaluate(() => { const d = document.createElement("div"); d.setAttribute("role", "dialog"); d.setAttribute("aria-label", "Enter your origin"); d.style.cssText = "position:fixed;inset:0;background:#fff"; d.innerHTML = '<input aria-label="Where else?">'; document.body.append(d); });
            const blocked = await page.getByRole("button", { name: "Add" }).click().then(() => "clicked", (error) => String(error.message || error));
            await page.evaluate(() => document.querySelector("[role=dialog]").remove());
            await page.evaluate(() => { const d = document.createElement("div"); d.setAttribute("role", "dialog"); d.style.cssText = "position:fixed;inset:0;background:#fff;padding:40px"; d.onclick = (event) => { if (event.target === d) document.title = "dialog-clicked"; }; d.innerHTML = '<label style="display:block"><input id="inner" type="checkbox" style="pointer-events:none"> Option</label><div id="bare" style="pointer-events:none;width:40px;height:20px"><input id="plain" type="checkbox" style="pointer-events:none"></div>'; document.body.append(d); });
            const ancestorHit = await page.locator("#inner").click().then(() => "clicked", (error) => String(error.message || error));
            const innerChecked = await page.evaluate(() => document.querySelector("#inner").checked);
            const plainHit = await page.locator("#plain").click().then(() => "clicked", (error) => String(error.message || error));
            const plainChecked = await page.evaluate(() => document.querySelector("#plain").checked);
            const ancestorTitle = await page.title();
            await page.evaluate(() => document.querySelector("[role=dialog]").remove());
            const filtered = await page.locator("li").filter({ hasText: "Beta" }).first().textContent();
            const orTexts = await page.locator("li").filter({ hasText: "Gamma" }).or(page.locator("li").filter({ hasText: "Alpha" })).allInnerTexts();
            const andCount = await page.locator("li").and(page.locator("li").filter({ hasText: "Beta" })).count();
            await page.wait(50);
            await page.waitForSelector("body", { timeout: 20000 });
            await page.console({ clear: true });
            await page.evaluate(() => console.error("boom from page"));
            const consoleErrors = (await page.console({ errors: true })).map((entry) => entry.text).join(" ");
            await page.dialogs("dismiss");
            const confirmed = await page.evaluate(() => window.confirm("Remove item?"));
            const pdf = await page.pdf("catalog.pdf");
            await page.emulate({ device: "iPhone", colorScheme: "dark" });
            const mobile = await page.evaluate(() => ({ touch: matchMedia("(pointer: coarse)").matches, dark: matchMedia("(prefers-color-scheme: dark)").matches, ua: /iPhone/.test(navigator.userAgent) }));
            await page.emulate({ reset: true });
            const downloads = Array.isArray(await browser.downloads.list());
            const tabs = await Promise.all(["a", "b", "c"].map((q) => browser.openTab(${JSON.stringify(siteUrl)} + "?q=" + q)));
            const sample = '<div data-rpos="0"><a href="/url?q=https://example.com/one"><h3>One result</h3></a><span>First snippet</span></div>' +
              '<div data-rpos="1"><a href="https://www.google.com/x"><h3>Google itself</h3></a></div>';
            const parsed = __parseGoogle(sample, 5);
            console.log("RESULT " + JSON.stringify({ title, url, count, second, texts, heading, items, added, typed, rows, links, parsed, regexText, regexClick, viaTab, blocked, ancestorHit, innerChecked, plainHit, plainChecked, ancestorTitle, filtered, orTexts, andCount, consoleErrors, confirmed, pdf, mobile, downloads,
              tabIds: tabs.map((tab) => tab.target.tabId) }))`,
            ],
            { env },
          );
          assert.match(stdout, /RESULT /, stdout);
          const result = JSON.parse(/RESULT (.*)/.exec(stdout)[1]);
          assert.equal(result.title, "Catalog");
          assert.equal(result.url, catalog);
          assert.equal(result.count, 3);
          assert.equal(result.second, "Beta");
          assert.deepEqual(result.texts, ["Alpha", "Beta", "Gamma"]);
          assert.equal(result.heading, "Catalog");
          assert.equal(result.items, 3);
          assert.equal(result.added, "added");
          assert.equal(result.regexText, "Gamma");
          assert.equal(result.regexClick, "added");
          assert.equal(result.viaTab, catalog);
          assert.match(result.consoleErrors, /boom from page/);
          assert.equal(result.confirmed, false);
          assert.deepEqual(result.pdf, { saved: "catalog.pdf" });
          assert.deepEqual(result.mobile, { touch: true, dark: true, ua: true });
          assert.equal(result.downloads, true);
          assert.match(
            result.blocked,
            /TARGET_BLOCKED: covered by dialog "Enter your origin"; its fields: "Where else."/,
          );
          assert.equal(result.ancestorHit, "clicked");
          assert.equal(result.innerChecked, true);
          assert.equal(result.plainHit, "clicked");
          assert.equal(result.plainChecked, true);
          assert.notEqual(result.ancestorTitle, "dialog-clicked");
          assert.equal(result.filtered, "Beta");
          assert.deepEqual(result.orTexts, ["Alpha", "Gamma"]);
          assert.equal(result.andCount, 1);
          assert.equal(result.typed, "phones");
          assert.deepEqual(result.rows, [
            { Model: "iPhone 16", Price: "69,900" },
            { Model: "iPhone 16 Plus", Price: "79,900" },
          ]);
          assert.ok(result.links.includes("Next page"));
          assert.deepEqual(result.parsed, [
            {
              title: "One result",
              url: "https://example.com/one",
              source: "example.com",
              snippet: "First snippet",
            },
          ]);
          const groups = await worker("Runtime.evaluate", {
            expression: `Promise.all(${JSON.stringify(result.tabIds)}.map((id) => chrome.tabs.get(id))).then((tabs) => [...new Set(tabs.map((tab) => tab.groupId))])`,
            awaitPromise: true,
            returnByValue: true,
          });
          assert.equal(groups.result.result.value.length, 1, "parallel tabs share one group");
          assert.notEqual(groups.result.result.value[0], -1);
        },
      );

      await t.test("form controls, one-call batches, overlays, media and challenges", async () => {
        const { stdout } = await run(
          process.execPath,
          [
            cli,
            "repl",
            "--session",
            "controls",
            `page = await browser.openTab(${JSON.stringify(siteUrl + "form")});
            const overlay = await page.overlays.dismiss();
            const titleAfter = await page.title();
            const fields = await page.controls.inspect();
            const directory = (await page.controls.directory({ query: "continue" })).map((row) => row.role + " " + row.label);
            const unchecked = await page.batch([{ action: "click", target: { role: "button", name: "Continue" } }]).then(() => "ran", (error) => error.message);
            const ambiguous = await page.batch([{ action: "read", target: { role: "radio" } }]).then(() => "ran", (error) => error.message);
            const batch = await page.batch([
              { action: "fill", target: { label: "Email" }, value: "a@b.co" },
              { action: "select", target: { label: "Country" }, value: "France" },
              { action: "check", target: { label: "I agree to the terms" } },
              { action: "fill", target: { label: "Notes" }, value: "Ring twice" },
              { action: "fill", target: { label: "Message" }, value: "Pasted in" },
              { action: "click", target: { role: "button", name: "Continue" } },
              { action: "read", target: { css: "#done" }, expect: "Thanks, a@b.co" },
            ]);
            const done = await page.textContent("#done");
            const message = await page.textContent("[aria-label=Message]");
            const media = await page.media.inspect();
            const blocked = await browser.openTab(${JSON.stringify(siteUrl + "challenge")});
            const challenges = await blocked.challenges();
            const state = await bu.state();
            console.log("RESULT " + JSON.stringify({ overlay, titleAfter, fields, directory, unchecked, ambiguous, steps: batch.steps.map((step) => step.id), done, message,
              media: media.summary, challenges: challenges.map((c) => c.kind + " " + c.provider), noted: /challenge: bot-check/.test(state) }))`,
          ],
          { env },
        );
        assert.match(stdout, /RESULT /, stdout);
        const result = JSON.parse(/RESULT (.*)/.exec(stdout)[1]);
        assert.deepEqual(result.overlay, {
          dismissed: [{ kind: "cookie", clicked: "Reject all" }],
        });
        assert.equal(result.titleAfter, "Signup rejected");
        const field = (label) => result.fields.find((row) => row.label === label);
        assert.equal(field("Email").required, true);
        assert.equal(field("Country").value, "Choose");
        assert.ok(field("Country").options.includes("France [fr]"));
        assert.equal(field("Free").checked, true);
        assert.equal(field("Pro").group, "Plan");
        assert.equal(field("I agree to the terms").checked, false);
        assert.equal(field("I agree to the terms").hidden, undefined);
        assert.deepEqual(
          [field("Seats").value, field("Seats").min, field("Seats").max],
          ["3", "1", "10"],
        );
        assert.equal(field("Notes").role, "textbox");
        assert.deepEqual(result.directory, ["button Continue"]);
        assert.match(result.unchecked, /ends with a check/);
        assert.match(result.ambiguous, /AMBIGUOUS: 2 elements match/);
        assert.deepEqual(result.steps, ["1", "2", "3", "4", "5", "6", "7"]);
        assert.equal(result.message, "Pasted in");
        assert.equal(result.done, "Thanks, a@b.co from fr (agreed) Ring twice");
        assert.match(result.media, /nothing playing \(video paused/);
        assert.deepEqual(result.challenges, ["bot-check Cloudflare"]);
        assert.equal(result.noted, true);
      });

      await t.test(
        "network capture, page requests, page data, Markdown, fetch and the tab pool",
        async () => {
          const deals = siteUrl + "deals";
          const { stdout } = await run(
            process.execPath,
            [
              cli,
              "repl",
              "--session",
              "data",
              `page = await browser.openTab(${JSON.stringify(siteUrl)});
            await page.network.start();
            await page.goto(${JSON.stringify(deals)});
            await page.waitFor(() => document.readyState === "complete");
            let calls = [];
            for (let tries = 0; tries < 50 && !calls.some((call) => !call.loading); tries++) {
              calls = await page.network.list("/api/search");
              if (!calls.some((call) => !call.loading)) await new Promise((done) => setTimeout(done, 100));
            }
            const call = await page.network.get(calls[0].id);
            const body = await page.network.body(calls[0].id);
            const replayed = await page.replay(calls[0].id, { json: { page: 2 }, query: { q: "laptop" } });
            const requested = await page.request("/api/echo", { method: "POST", json: { a: 1 }, csrf: true });
            await page.network.stop();
            // A stopped recording can still be read and saved.
            const har = await page.network.har();
            const data = await page.data();
            const markdown = await page.markdown();
            const fetched = await browser.fetch(${JSON.stringify(siteUrl + "api/items")});
            const httpStatus = await page.status();
            const pooled = await browser.pool([1, 2, 3, 4].map((n) => ${JSON.stringify(siteUrl)} + "item/" + n),
              async (tab) => tab.title(), { concurrency: 2 });
            console.log("RESULT " + JSON.stringify({
              type: call.type, method: call.method, signature: call.requestHeaders["x-signature"],
              requestBody: JSON.parse(call.requestBody), initiator: call.initiator?.type,
              setCookie: Object.keys(call.responseHeaders).some((name) => name.toLowerCase() === "set-cookie"),
              bodyQuery: body.query, replayed: [replayed.json.query.q, replayed.json.body.page, replayed.json.body.q, replayed.json.signature],
              csrf: requested.json.csrf, harEntries: har.log.entries.some((entry) => entry.request.url.includes("/api/search")),
              jsonLd: data.jsonLd[0].name, next: data.nextData.props.pageProps.items[0].name,
              canonical: data.metadata.canonical, og: data.metadata.meta["og:title"],
              markdown, fetched: fetched.json.items.length, status: httpStatus,
              pooled: pooled.map((result) => result.ok && result.value),
            }));`,
            ],
            { env },
          );
          assert.match(stdout, /RESULT /, stdout);
          const result = JSON.parse(/RESULT (.*)/.exec(stdout)[1]);
          assert.equal(result.type, "Fetch");
          assert.equal(result.method, "POST");
          assert.equal(result.signature, "sig-1");
          assert.deepEqual(result.requestBody, { q: "phone", page: 1 });
          assert.equal(result.initiator, "script");
          assert.equal(result.setCookie, true);
          assert.deepEqual(result.bodyQuery, { q: "phone" });
          assert.deepEqual(result.replayed, ["laptop", 2, null, "sig-1"]);
          assert.equal(result.csrf, "token-123");
          assert.equal(result.harEntries, true);
          assert.equal(result.jsonLd, "Phone");
          assert.equal(result.next, "Phone");
          assert.equal(result.canonical, "https://shop.example/deals");
          assert.equal(result.og, "Deals page");
          assert.match(result.markdown, /^# Deals/);
          assert.match(result.markdown, /Prices from \*\*today\*\* ?, see \[terms\]\(http/);
          assert.match(result.markdown, /- Phone\n- Laptop/);
          assert.match(
            result.markdown,
            /\| Item \| Price \|\n\| --- \| --- \|\n\| Phone \| 699 \|/,
          );
          assert.match(result.markdown, /```\ncode block\n```/);
          assert.doesNotMatch(result.markdown, /Footer text|About/);
          assert.equal(result.fetched, 3);
          assert.equal(result.status, 200);
          assert.deepEqual(result.pooled, ["Item 1", "Item 2", "Item 3", "Item 4"]);
        },
      );

      await t.test(
        "page.read merges a thread, expands replies, waits and reports partial reads",
        async () => {
          const { stdout } = await run(
            process.execPath,
            [
              cli,
              "repl",
              "--session",
              "reading",
              `page = await browser.openTab(${JSON.stringify(siteUrl + "thread")});
            const markdown = await page.markdown();
            const cut = await page.markdown({max: 80});
            const read = await page.read({max: 4000});
            await page.evaluate(() => {
              const extra = document.createElement("p");
              extra.textContent = "Long content ".repeat(1200);
              document.querySelector("main").append(extra);
            });
            const small = await page.read({max: 2000});
            console.log("READ " + JSON.stringify({
              markdownReplies: markdown.includes("First reply") && markdown.includes("Second reply"),
              markdownLate: markdown.includes("Late reply"),
              markdownPartial: markdown.includes("[PARTIAL:") && markdown.includes("hidden behind Show more"),
              cutPartial: cut.includes("[PARTIAL:") && cut.includes("cut at 80"),
              readLate: read.markdown.includes("Late reply"),
              readHidden: read.markdown.includes("Hidden reply"),
              readCount: read.list && read.list.count,
              readComplete: read.list && read.list.complete,
              readPartial: read.partial,
              smallPartial: small.partial,
              smallArtifact: typeof small.artifact === "string",
              liked: await page.evaluate(() => document.title === "liked"),
            }));`,
            ],
            { env },
          );
          const result = JSON.parse(/READ (.*)/.exec(stdout)[1]);
          assert.equal(result.markdownReplies, true);
          assert.equal(result.markdownLate, false);
          assert.equal(result.markdownPartial, true);
          assert.equal(result.cutPartial, true);
          assert.equal(result.readLate, true);
          assert.equal(result.readHidden, true);
          assert.equal(result.readCount, 5);
          assert.equal(result.readComplete, true);
          assert.equal(result.readPartial, false);
          assert.equal(result.smallPartial, true);
          assert.equal(result.smallArtifact, true);
          assert.equal(result.liked, false);
        },
      );

      await t.test("page.data reports a partial source list", async () => {
        const { stdout } = await run(
          process.execPath,
          [
            cli,
            "repl",
            "--session",
            "partial-data",
            `page = await browser.openTab(${JSON.stringify(siteUrl + "partial-data")});
            const summary = await page.data({summary: true});
            console.log("DATA " + JSON.stringify({partial: summary.partial, notes: summary.notes}));`,
          ],
          { env },
        );
        const result = JSON.parse(/DATA (.*)/.exec(stdout)[1]);
        assert.equal(result.partial, true);
        assert.match(result.notes.join(" "), /JSON-LD|JSON script/);
      });

      await t.test("learned lines only name operations the cell caused", async () => {
        const first = await run(
          process.execPath,
          [
            cli,
            "repl",
            "--session",
            "learn",
            `page = await browser.openTab(${JSON.stringify(siteUrl + "learn")});
            await page.waitFor(() => window.__loaded);
            await page.getByRole("button", { name: "Load lamps" }).click();`,
          ],
          { env },
        );
        const second = await run(
          process.execPath,
          [
            cli,
            "repl",
            "--session",
            "learn",
            `const operations = await siteMapper.operations(new URL(page.url()).hostname);
            console.log("OPS " + JSON.stringify(operations.map((operation) => operation.id)));`,
          ],
          { env },
        );
        const stdout = first.stdout + second.stdout;
        const learned = stdout.split(/\r?\n/).filter((line) => line.startsWith("Learned on "));
        assert.ok(
          learned.some((line) => /search/i.test(line)),
          stdout,
        );
        assert.ok(
          learned.every((line) => !/checkout|animation/i.test(line)),
          `unrelated page-load operations were announced:\n${learned.join("\n")}`,
        );
        const operations = JSON.parse(/OPS (.*)/.exec(stdout)[1]);
        assert.ok(
          operations.some((id) => /checkout/i.test(id)),
          `the unrelated operations are still listed: ${stdout}`,
        );
        assert.ok(operations.some((id) => /animation/i.test(id)));
      });

      await t.test("MCP lists the tools and runs browser_code", async () => {
        const mcp = mcpClient(env);
        try {
          const init = await mcp.call("initialize", {
            protocolVersion: "2025-06-18",
            capabilities: {},
          });
          assert.equal(init.serverInfo.name, "browserkit");
          const listed = await mcp.call("tools/list", {});
          assert.deepEqual(
            listed.tools.map((tool) => tool.name),
            ["browser_code", "browser_tabs", "browser_action", "crawl", "site_mapper"],
          );
          const crawled = await mcp.call("tools/call", {
            name: "crawl",
            arguments: { action: "scrape", url: siteUrl, render: "static" },
          });
          assert.match(crawled.content[0].text, /Shop/, JSON.stringify(crawled));
          const called = await mcp.call("tools/call", {
            name: "browser_code",
            arguments: {
              code: `const p = await browser.openTab(${JSON.stringify(siteUrl)}); (await p.fetchJson('/api/items')).items.length`,
            },
          });
          assert.equal(called.isError, false, JSON.stringify(called));
          assert.match(called.content[0].text, /→ 3/);
          const tabs = await mcp.call("tools/call", { name: "browser_tabs", arguments: {} });
          assert.match(tabs.content[0].text, /127\.0\.0\.1/);
        } finally {
          mcp.close();
        }
      });

      await t.test(
        "media: images are saved to the workspace and uploaded through a drop zone",
        async () => {
          const { stdout } = await run(
            process.execPath,
            [
              cli,
              "repl",
              "--session",
              "media",
              `const p = await browser.openTab(${JSON.stringify(siteUrl + "media")});
            const saved = await p.saveMedia("#photo");
            const fromUrl = await p.saveMedia(${JSON.stringify(siteUrl + "media/photo.png")}, { name: "again.png" });
            await p.upload("#drop", [saved[0].saved, ${JSON.stringify(siteUrl + "media/photo.png")}]);
            const picked = await p.evaluate(() => [...document.querySelector("input[type=file]").files].map((f) => f.size));
            console.log("RESULT " + JSON.stringify({ saved: saved[0].saved, mime: saved[0].mime, again: fromUrl[0].saved, picked }))`,
            ],
            { env },
          );
          assert.match(stdout, /RESULT /, stdout);
          const result = JSON.parse(/RESULT (.*)/.exec(stdout)[1]);
          assert.equal(result.saved, "media/photo.png");
          assert.equal(result.mime, "image/png");
          assert.equal(result.again, "media/again.png");
          const size = Buffer.from(PNG, "base64").length;
          assert.deepEqual(result.picked, [size, size]);
        },
      );

      await t.test("browser code reaches mapped site APIs through siteMapper", async () => {
        const { stdout } = await run(
          process.execPath,
          [
            cli,
            "repl",
            "--session",
            "site-mapper",
            `const sites = await siteMapper.sites();
            const missing = await siteMapper.call("nope.example", "x").then(() => "called", (e) => String(e.message));
            console.log("RESULT " + JSON.stringify({ sites, missing }))`,
          ],
          { env },
        );
        assert.match(stdout, /RESULT /, stdout);
        const result = JSON.parse(/RESULT (.*)/.exec(stdout)[1]);
        // Nothing was mapped by hand: the fixture site's API was learned while the earlier
        // steps used it.
        assert.deepEqual(
          result.sites.map((site) => site.site),
          ["127.0.0.1"],
        );
        assert.ok(result.sites[0].operations > 0);
        assert.match(result.missing, /not mapped/);
      });

      await t.test(
        "readiness, cookies, the network store and the scheduler answer from one cell",
        async () => {
          const origin = new URL(siteUrl).origin;
          const { stdout } = await run(
            process.execPath,
            [
              cli,
              "repl",
              "--session",
              "phase2",
              `(async () => {
  await browser.openTab(${JSON.stringify(siteUrl)}, {newTab: true});
  const ready = await page.waitReady({timeoutMs: 8000});
  await browser.cookies.set({domain: '127.0.0.1', name: 'bk_phase2', value: '1', path: '/'});
  const listed = await browser.cookies.list({domain: '127.0.0.1'});
  const cleared = await browser.cookies.clear({domain: '127.0.0.1'});
  const network = await browser.network.list({origin: ${JSON.stringify(origin)}, limit: 5});
  const origins = await browser.network.origins();
  const scheduler = await browser.scheduler();
  const result = {
    ready,
    listed: {count: listed.count, valuesHidden: listed.valuesHidden},
    cleared: {cleared: cleared.cleared},
    network: {count: network.count, entries: network.entries.map((entry) => ({method: entry.method, status: entry.status, url: entry.url}))},
    origins: {count: origins.origins.length},
    scheduler: {write: scheduler.write},
  };
  console.log('RESULT ' + JSON.stringify(result));
  return 'done';
})()`,
            ],
            { env },
          );
          const result = JSON.parse(/RESULT (.*)/.exec(stdout)?.[1] ?? "null");
          assert.ok(result, stdout);
          assert.ok(
            ["ready", "empty"].includes(result.ready.state),
            `a loaded fixture page is not loading or broken: ${JSON.stringify(result.ready)}`,
          );
          assert.ok(Array.isArray(result.ready.evidence) && result.ready.evidence.length > 0);
          assert.ok(result.listed.count >= 1, "the cookie just set is listed");
          assert.equal(result.listed.valuesHidden, true, "values are hidden unless asked");
          assert.ok(result.cleared.cleared >= 1);
          assert.ok(result.network.count >= 1, "the page's own requests are in the host store");
          assert.ok(result.origins.count >= 1);
          assert.equal(typeof result.scheduler.write.busy, "boolean");
        },
      );

      await t.test("named sessions own a tab each and clean up after themselves", async () => {
        const first = JSON.parse(
          (
            await run(
              process.execPath,
              [cli, "sessions", "create", "phase2-a", "--url", siteUrl, "--json"],
              { env },
            )
          ).stdout,
        );
        const second = JSON.parse(
          (
            await run(
              process.execPath,
              [cli, "sessions", "create", "phase2-b", "--url", siteUrl, "--json"],
              { env },
            )
          ).stdout,
        );
        assert.equal(first.name, "phase2-a");
        assert.ok(first.tabs.length >= 1, JSON.stringify(first));
        assert.ok(second.tabs.length >= 1, JSON.stringify(second));
        assert.notDeepEqual(first.tabs, second.tabs, "each session has its own tab");

        const info = JSON.parse(
          (await run(process.execPath, [cli, "sessions", "info", "phase2-a", "--json"], { env }))
            .stdout,
        );
        assert.deepEqual(info.tabs, first.tabs);
        const listed = JSON.parse(
          (await run(process.execPath, [cli, "sessions", "list", "--json"], { env })).stdout,
        );
        assert.ok(listed.sessions.some((session) => session.name === "phase2-a"));
        assert.ok(listed.sessions.some((session) => session.name === "phase2-b"));

        const cleaned = JSON.parse(
          (await run(process.execPath, [cli, "sessions", "cleanup", "phase2-a", "--json"], { env }))
            .stdout,
        );
        assert.ok(cleaned.closed >= 1, JSON.stringify(cleaned));
        await run(process.execPath, [cli, "sessions", "delete", "phase2-b", "--json"], { env });
      });

      await t.test("check reports typed readiness", async () => {
        const { stdout } = await run(
          process.execPath,
          [cli, "check", siteUrl, "--ready", "--json"],
          { env, cwd: home },
        );
        const report = JSON.parse(stdout);
        const result = report.results?.[0];
        assert.ok(result, stdout);
        assert.ok(result.readiness, JSON.stringify(result));
        assert.ok(["ready", "empty"].includes(result.readiness.state));
        assert.ok(result.readiness.evidence.length > 0);
      });

      await t.test("the browser surface reads, searches, collects and emulates", async () => {
        const { stdout } = await run(
          process.execPath,
          [
            cli,
            "repl",
            "--session",
            "phase3",
            `(async () => {
  await browser.openTab(${JSON.stringify(siteUrl)}, {newTab: true});
  const steps = {};
  const attempt = async (name, fn) => { try { steps[name] = await fn(); } catch (error) { steps[name] = {error: String((error && error.message) || error)}; } };
  await attempt('html', () => page.html({stripScripts: true}));
  await attempt('state', () => page.state());
  await attempt('find', () => page.find('Shop'));
  await attempt('styles', () => page.styles('h1'));
  await attempt('frames', () => page.diagnoseFrames());
  await attempt('extract', () => page.extract({script: 'async (p) => ({title: await p.title()})'}));
  await attempt('collect', () => page.collect({row: 'h1, button', fields: {text: ''}}));
  await attempt('settle', () => page.settle({quietMs: 200, timeoutMs: 3000}));
  await attempt('cpu', () => page.emulateCPU(2));
  await attempt('viewport', () => page.emulateViewport({width: 900, height: 700}));
  await attempt('abort', () => page.abort(['*doubleclick*']));
  await attempt('perf', () => page.performance());
  await attempt('animations', () => page.animations());
  await attempt('windows', () => browser.windows.list());
  await attempt('zoom', () => browser.setZoom(1.2));
  await attempt('tiles', () => page.iconTiles({max: 2}));
  console.log('RESULT ' + JSON.stringify(steps));
  return 'done';
})()`,
          ],
          { env },
        );
        const result = JSON.parse(/RESULT (.*)/.exec(stdout)?.[1] ?? "null");
        assert.ok(result, stdout);
        for (const [name, value] of Object.entries(result))
          assert.equal(value.error, undefined, `${name} failed: ${value.error}`);
        assert.equal(result.html.html.includes("Shop"), true);
        assert.equal(
          result.html.html.includes("<script"),
          false,
          "scripts are stripped by default",
        );
        assert.equal(result.state.title, "Shop");
        assert.ok(result.state.headings.length >= 1);
        assert.ok(result.find.count >= 1, "page search finds the heading");
        assert.ok(result.styles.styles.display, "h1 has a computed display");
        assert.ok(result.frames.count >= 1);
        assert.equal(result.extract.ok, true);
        assert.equal(result.extract.data.title, "Shop");
        assert.ok(result.collect.count >= 1, "collect reads rows");
        assert.equal(typeof result.settle.settled, "boolean");
        assert.ok(["quiet", "cap"].includes(result.settle.why), JSON.stringify(result.settle));
        assert.equal(typeof result.perf.metrics.TaskDuration, "number");
        assert.equal(Array.isArray(result.animations.animations), true);
        assert.ok(result.windows.windows.length >= 1);
      });

      await t.test("auto screenshots, diffs and saved HTML respond to the repl flags", async () => {
        const { stdout } = await run(
          process.execPath,
          [
            cli,
            "repl",
            "--session",
            "phase3b",
            "--screenshot",
            "--settle",
            "300",
            "--full",
            `page = await browser.openTab(${JSON.stringify(siteUrl + "catalog")});
            await page.locator("#q").fill("alpha");
            await page.locator("#q").fill("beta");
            const auto = page.autoState();
            const saved = await page.saveHtml("snapshot.html");
            console.log("RESULT " + JSON.stringify({ auto, saved }))`,
          ],
          { env },
        );
        const result = JSON.parse(/RESULT (.*)/.exec(stdout)?.[1] ?? "null");
        assert.ok(result, stdout);
        assert.equal(result.auto.on, true);
        assert.ok(result.auto.shots.length >= 2, JSON.stringify(result.auto));
        assert.ok(result.auto.shots.every((shot) => typeof shot.name === "string"));
        assert.ok(
          result.auto.shots.some((shot) => shot.diff && shot.diff.changedPixels > 0),
          JSON.stringify(result.auto),
        );
        assert.equal(result.saved.saved, "snapshot.html");
        const directories = await readdir(join(home, "workspaces"));
        const file = directories
          .map((directory) => join(home, "workspaces", directory, "snapshot.html"))
          .find((candidate) => existsSync(candidate));
        assert.ok(file, "saved HTML is a workspace file");
        const html = await readFile(file, "utf8");
        assert.match(html, /Catalog/);
      });

      await t.test("no-screenshot and no-diff switch the automatic work off", async () => {
        const { stdout } = await run(
          process.execPath,
          [
            cli,
            "repl",
            "--session",
            "phase3b-off",
            "--screenshot",
            "--no-screenshot",
            "--no-diff",
            `page = await browser.openTab(${JSON.stringify(siteUrl)}); await page.getByRole("button", { name: "Buy" }).click(); console.log("RESULT " + JSON.stringify(page.autoState()))`,
          ],
          { env },
        );
        const result = JSON.parse(/RESULT (.*)/.exec(stdout)?.[1] ?? "null");
        assert.ok(result, stdout);
        assert.equal(result.screenshots, false);
        assert.equal(result.diff, false);
        assert.equal(result.shots.length, 0);
      });

      await t.test("windows and zoom answer from the CLI", async () => {
        const listed = JSON.parse(
          (await run(process.execPath, [cli, "windows", "list", "--json"], { env })).stdout,
        );
        assert.ok(listed.windows.length >= 1, JSON.stringify(listed));
        const zoom = JSON.parse(
          (await run(process.execPath, [cli, "zoom", "1.2", "--json"], { env })).stdout,
        );
        assert.equal(zoom.factor, 1.2);
        const reset = JSON.parse(
          (await run(process.execPath, [cli, "zoom", "reset", "--json"], { env })).stdout,
        );
        assert.equal(reset.factor, 1);
      });

      await t.test("a performance trace is saved as an artifact", async () => {
        const { stdout } = await run(
          process.execPath,
          [cli, "record", "trace", siteUrl, "--seconds", "1", "--out", "traces/e2e.json", "--json"],
          { env },
        );
        const result = JSON.parse(stdout);
        assert.equal(result.saved, "traces/e2e.json");
        assert.ok(result.events > 0, JSON.stringify(result));
        const directories = await readdir(join(home, "workspaces"));
        const path = directories
          .map((directory) => join(home, "workspaces", directory, "traces", "e2e.json"))
          .find((candidate) => existsSync(candidate));
        assert.ok(path, "trace artifact is in a session workspace");
        const trace = JSON.parse(await readFile(path, "utf8"));
        assert.ok(Array.isArray(trace.traceEvents));
      });

      await t.test("recording without an encoder fails with install instructions", async () => {
        const failure = await run(
          process.execPath,
          [
            cli,
            "record",
            "gif",
            siteUrl,
            "--seconds",
            "2",
            "--fps",
            "2",
            "--out",
            join(home, "phase3b.gif"),
          ],
          { env: { ...env, FFMPEG_PATH: "no-such-ffmpeg-binary" } },
        ).then(
          () => undefined,
          (error) => error,
        );
        assert.ok(failure, "the command fails without an encoder");
        const message = String(failure.stdout ?? "") + String(failure.stderr ?? "");
        assert.match(message, /ENCODER_MISSING|ffmpeg/i, message);
      });

      await t.test("a saved workflow runs its browser steps from the CLI", async () => {
        const file = join(home, "read-shop.workflow.json");
        await writeFile(
          file,
          JSON.stringify(
            {
              name: "read-shop",
              inputs: { url: { required: true } },
              steps: [
                { id: "open", do: "goto", with: { url: "{{inputs.url}}" } },
                { id: "page", do: "read", with: { max: 2000 } },
                { do: "assert", with: { value: "{{steps.open.url}}", contains: "127.0.0.1" } },
              ],
            },
            null,
            2,
          ),
        );
        await run(process.execPath, [cli, "workflow", "save", file], { env });
        const { stdout } = await run(
          process.execPath,
          [
            cli,
            "workflow",
            "run",
            "read-shop",
            "--inputs",
            JSON.stringify({ url: siteUrl }),
            "--json",
          ],
          { env },
        );
        const result = JSON.parse(stdout);
        assert.equal(result.status, "completed", stdout);
        assert.equal(result.steps[0].status, "completed");
        assert.equal(result.steps[1].status, "completed");
        assert.equal(typeof result.steps[1].result, "object");
        const runs = await run(process.execPath, [cli, "workflow", "runs", "read-shop", "--json"], {
          env,
        });
        assert.equal(JSON.parse(runs.stdout).length, 1);
      });

      await t.test("a saved boost applies on every visit until it is removed", async () => {
        const repl = (code) =>
          run(process.execPath, [cli, "repl", "--session", "boosts", code], { env });
        const color = `(await browser.openTab(${JSON.stringify(siteUrl)}, { new: true })).evaluate(() => getComputedStyle(document.querySelector("h1")).color)`;
        const saved = await repl(
          `const boost = await browser.boosts.save({ name: "Red headings", sites: [{ type: "domain", value: "127.0.0.1" }], css: "h1 { color: rgb(200, 0, 0) !important }" });
          await new Promise((done) => setTimeout(done, 500));
          console.log("RESULT " + JSON.stringify({ id: boost.id, color: await ${color}, listed: (await browser.boosts.list()).length }))`,
        );
        assert.match(saved.stdout, /RESULT /, saved.stdout);
        const first = JSON.parse(/RESULT (.*)/.exec(saved.stdout)[1]);
        assert.equal(first.color, "rgb(200, 0, 0)");
        assert.equal(first.listed, 1);
        const removed = await repl(
          `await browser.boosts.remove(${JSON.stringify(first.id)});
          console.log("RESULT " + JSON.stringify({ color: await ${color}, listed: (await browser.boosts.list()).length }))`,
        );
        assert.match(removed.stdout, /RESULT /, removed.stdout);
        const after = JSON.parse(/RESULT (.*)/.exec(removed.stdout)[1]);
        assert.notEqual(after.color, "rgb(200, 0, 0)");
        assert.equal(after.listed, 0);
      });

      await t.test("site skills saved by one agent are offered to another", async () => {
        await run(
          process.execPath,
          [
            cli,
            "repl",
            "--session",
            "one",
            `await skills.save({name: 'shop-buy', domains: ['127.0.0.1'], description: 'Buys the item', code: "var shop = {title: () => page.evaluate(() => document.title)}"})`,
          ],
          { env },
        );
        const { stdout } = await run(
          process.execPath,
          [
            cli,
            "repl",
            "--session",
            "two",
            `page = await browser.openTab(${JSON.stringify(siteUrl)}); await bu.state()`,
          ],
          { env },
        );
        assert.match(stdout, /Site skills .*shop-buy/);
      });

      await t.test("demonstrations record a flow and generate a replayable skill", async () => {
        const { stdout } = await run(
          process.execPath,
          [
            cli,
            "repl",
            "--session",
            "demo",
            `page = await browser.openTab(${JSON.stringify(siteUrl + "catalog")});
            const demo = await page.recordDemonstration();
            await page.locator("#q").fill("Alpha");
            await page.getByRole("button", { name: "Add" }).click();
            const recorded = await demo.stop();
            console.log("RESULT " + JSON.stringify({ steps: recorded.steps.length, kinds: recorded.steps.map((step) => step.kind), code: recorded.code.includes(".fill(") && recorded.code.includes(".click("), skill: recorded.skill.code.includes("async function") }))`,
          ],
          { env },
        );
        assert.match(stdout, /RESULT /, stdout);
        const result = JSON.parse(/RESULT (.*)/.exec(stdout)[1]);
        assert.ok(result.steps >= 2, JSON.stringify(result));
        assert.ok(result.kinds.includes("fill"), JSON.stringify(result));
        assert.ok(result.kinds.includes("click"), JSON.stringify(result));
        assert.equal(result.code, true);
        assert.equal(result.skill, true);
      });

      await t.test("screenshot diff finds a visual change and writes a diff PNG", async () => {
        const { stdout } = await run(
          process.execPath,
          [
            cli,
            "repl",
            "--session",
            "diff",
            `page = await browser.openTab(${JSON.stringify(siteUrl + "catalog")});
            await page.waitForSelector("#q");
            await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
            await page.evaluate(() => { document.getElementById("aeon-agent-cursor")?.remove(); document.documentElement.style.background = "#fff"; document.body.style.background = "#fff"; });
            await page.evaluate(() => new Promise((done) => requestAnimationFrame(done)));
            const before = await page.screenshot();
            const same = await page.diffScreenshot(before);
            await page.evaluate(() => { document.body.style.background = "#123456"; });
            const changed = await page.diffScreenshot(before, { path: "diff.png" });
            console.log("RESULT " + JSON.stringify({ sameRatio: same.changedRatio, changed: changed.matches, pixels: changed.changedPixels, path: changed.path }))`,
          ],
          { env },
        ).catch((error) => {
          console.log(error.stdout);
          throw error;
        });
        assert.match(stdout, /RESULT /, stdout);
        const result = JSON.parse(/RESULT (.*)/.exec(stdout)[1]);
        assert.ok(result.sameRatio < 0.01, JSON.stringify(result));
        assert.equal(result.changed, false, JSON.stringify(result));
        assert.ok(result.pixels > 100000, JSON.stringify(result));
        assert.equal(result.path, "diff.png");
      });

      await t.test(
        "bu.signIn signs in from the password manager without showing the password",
        async () => {
          const { stdout } = await run(
            process.execPath,
            [
              cli,
              "repl",
              "--session",
              "signin",
              `page = await browser.openTab(${JSON.stringify(siteUrl + "login")});
            await page.waitForSelector("input[type=email]");
            // Stands in for the user clicking "Always here" on the approval banner.
            await page.evaluate(() => setTimeout(() => { globalThis[Symbol.for("signin.approval")] = "always"; }, 1500));
            const result = await bu.signIn();
            let leaked = "no";
            try { await __call({ credential: "login", url: page.url() }); leaked = "yes"; } catch (error) { leaked = String(error.message).slice(0, 40); }
            console.log("RESULT " + JSON.stringify({ result, title: await page.title(), leaked }))`,
            ],
            { env },
          ).catch((error) => {
            console.log(error.stdout, error.stderr);
            throw error;
          });
          assert.match(stdout, /RESULT /, stdout);
          assert.ok(!stdout.includes(LOGIN.password), "the password never reaches agent output");
          assert.ok(!stdout.includes(LOGIN.code), "the one-time code never reaches agent output");
          const { result, title, leaked } = JSON.parse(/RESULT (.*)/.exec(stdout)[1]);
          assert.equal(result.signedIn, true, JSON.stringify(result));
          assert.equal(result.provider, "Bitwarden");
          assert.equal(result.account, LOGIN.username);
          assert.equal(title, "Account");
          assert.match(leaked, /FORBIDDEN/);
        },
      );

      await t.test("blocked sites stay out of reach for the agent", async () => {
        await writeFile(join(home, "site-rules.json"), JSON.stringify({ blocked: ["localhost"] }));
        const blockedUrl = siteUrl.replace("127.0.0.1", "localhost");
        try {
          const { stdout } = await run(
            process.execPath,
            [
              cli,
              "repl",
              "--session",
              "blocked",
              `const out = {};
              try { await browser.openTab(${JSON.stringify(blockedUrl)}); out.open = "opened"; } catch (e) { out.open = e.message.slice(0, 30); }
              try { await browser.fetch(${JSON.stringify(blockedUrl + "api/items")}); out.fetch = "fetched"; } catch (e) { out.fetch = e.message.slice(0, 30); }
              page = await browser.openTab(${JSON.stringify(siteUrl)});
              await page.evaluate((href) => { const a = document.createElement("a"); a.href = href; a.id = "away"; a.textContent = "away"; document.body.append(a); }, ${JSON.stringify(blockedUrl)});
              await page.locator("#away").click().catch(() => {});
              await new Promise((r) => setTimeout(r, 1500));
              out.after = await page.evaluate(() => location.hostname + " " + document.title).catch((e) => "error " + e.message.slice(0, 30));
              console.log("RESULT " + JSON.stringify(out))`,
            ],
            { env },
          ).catch((error) => {
            console.log(error.stdout, error.stderr);
            throw error;
          });
          const out = JSON.parse(/RESULT (.*)/.exec(stdout)[1]);
          assert.match(out.open, /SITE_BLOCKED/, stdout);
          assert.match(out.fetch, /SITE_BLOCKED/, stdout);
          assert.ok(!/Shop/.test(out.after) || !out.after.startsWith("localhost"), stdout);
        } finally {
          await rm(join(home, "site-rules.json"), { force: true });
        }
      });
    } finally {
      chrome?.kill();
      bridge.kill();
      site.close();
      await sleep(300);
      await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(
        () => {},
      );
      await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(
        () => {},
      );
    }
  },
);

// Chrome only finds native hosts registered for the real browser, so the test answers the
// extension's bootstrap itself with what the native host returns.
async function connectExtension(profile, env) {
  const port = await waitFor(async () =>
    Number((await readFile(join(profile, "DevToolsActivePort"), "utf8")).split("\n")[0]),
  );
  const worker = await waitFor(async () => {
    const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json());
    const found = targets.find((item) => item.url.endsWith("/service-worker.js"));
    if (!found) throw new Error("no worker yet");
    return found;
  });
  const reply = await nativeBootstrap(env);
  const cdp = await connect(worker.webSocketDebuggerUrl);
  await waitFor(async () => {
    const ready = await cdp("Runtime.evaluate", {
      expression: "typeof chrome?.runtime?.id",
      returnByValue: true,
    });
    if (ready.result?.result?.value !== "string") throw new Error("worker not ready");
  });
  await cdp("Runtime.evaluate", {
    expression: `chrome.runtime.sendNativeMessage = (_host, request, callback) => callback(${JSON.stringify(reply)});`,
  });
  // Wake the connection: the extension retries on tab activation.
  const version = await fetch(`http://127.0.0.1:${port}/json/version`).then((r) => r.json());
  const browser = await connect(version.webSocketDebuggerUrl);
  await browser("Target.createTarget", { url: "about:blank" });
  await waitFor(async () => {
    const { stdout } = await run(process.execPath, [cli, "status"], { env });
    if (!/1 browser/.test(stdout)) throw new Error(stdout);
  }, 30000);
  return cdp;
}

function nativeBootstrap(env, message) {
  return new Promise((resolveReply, reject) => {
    const host = spawn(
      process.execPath,
      [cli, "chrome-extension://dmlgohfphkbenjopdphcojgjeidlmajj/"],
      { env },
    );
    const chunks = [];
    host.stdout.on("data", (chunk) => chunks.push(chunk));
    host.on("error", reject);
    host.on("close", () => {
      const buffer = Buffer.concat(chunks);
      resolveReply(JSON.parse(buffer.subarray(4, 4 + buffer.readUInt32LE(0)).toString("utf8")));
    });
    const body = Buffer.from(
      JSON.stringify(
        message ?? {
          kind: "native.bootstrap",
          protocolVersion: { major: 1, minor: 6 },
          clientInstanceId: "091b9308-1ee9-420e-b71f-a564a5a27701",
          browserRunId: "3ee7ba6e-5aad-4692-9e4e-fb4cff0964f8",
        },
      ),
    );
    const header = Buffer.alloc(4);
    header.writeUInt32LE(body.length);
    host.stdin.end(Buffer.concat([header, body]));
  });
}

function mcpClient(env) {
  const child = spawn(process.execPath, [cli, "mcp"], { env });
  let buffer = "";
  let id = 0;
  const waiting = new Map();
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      const message = JSON.parse(line);
      waiting.get(message.id)?.(message);
    }
  });
  return {
    call: (method, params) =>
      new Promise((done, fail) => {
        const my = ++id;
        waiting.set(my, (message) =>
          message.error ? fail(new Error(message.error.message)) : done(message.result),
        );
        child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: my, method, params }) + "\n");
      }),
    close: () => child.kill(),
  };
}

async function waitFor(check, timeout = 15000) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    try {
      return await check();
    } catch (error) {
      last = error;
      await sleep(150);
    }
  }
  throw last ?? new Error("timed out");
}

function connect(url) {
  const socket = new WebSocket(url);
  let id = 0;
  const waiting = new Map();
  socket.on("message", (raw) => {
    const message = JSON.parse(String(raw));
    waiting.get(message.id)?.(message);
    waiting.delete(message.id);
  });
  const opened = new Promise((done) => socket.once("open", done));
  return async (method, params = {}) => {
    await opened;
    return new Promise((done) => {
      waiting.set(++id, done);
      socket.send(JSON.stringify({ id, method, params }));
    });
  };
}
