// Test site routes for network capture, page requests, embedded data, Markdown and the tab pool.
const limitedOnce = new Set();

const ARTICLE = `<!doctype html><html lang="en"><head><title>Deals</title>
<meta name="description" content="Today's deals">
<meta property="og:title" content="Deals page">
<meta name="csrf-token" content="token-123">
<link rel="canonical" href="https://shop.example/deals">
<script type="application/ld+json">{"@type":"Product","name":"Phone","offers":{"price":"699"}}</script>
<script id="__NEXT_DATA__" type="application/json">{"props":{"pageProps":{"items":[{"id":1,"name":"Phone"}]}}}</script>
</head><body>
<nav class="menu"><a href="/">Home</a> <a href="/about">About</a></nav>
<main><h1>Deals</h1><p>Prices from <strong>today</strong>, see <a href="/terms">terms</a>.</p>
<ul><li>Phone</li><li>Laptop</li></ul>
<table><tr><th>Item</th><th>Price</th></tr><tr><td>Phone</td><td>699</td></tr></table>
<pre>code block</pre></main>
<footer>Footer text</footer>
<script>
fetch("/api/search?q=phone", { method: "POST", headers: { "content-type": "application/json", "x-signature": "sig-1" }, body: JSON.stringify({ q: "phone", page: 1 }) });
</script>
</body></html>`;

// A virtualized list, as job boards and feeds draw them: 150 rows, only the visible ones in the DOM.
const VIRTUAL = `<!doctype html><html><head><title>Virtual</title></head><body>
<div id="scroller" style="height:300px;overflow-y:auto"><div id="inner" style="position:relative"></div></div>
<script>
const ROW = 40, COUNT = 150, scroller = document.getElementById("scroller"), inner = document.getElementById("inner");
inner.style.height = ROW * COUNT + "px";
function draw() {
  const first = Math.floor(scroller.scrollTop / ROW), last = Math.min(COUNT, first + 10);
  inner.innerHTML = "";
  for (let i = first; i < last; i++) {
    const row = document.createElement("div");
    row.setAttribute("data-index", String(i));
    row.style.cssText = "position:absolute;top:" + i * ROW + "px;height:" + ROW + "px";
    row.textContent = "Job " + i + (i === 120 ? " Yet to apply" : " Applications closed");
    inner.append(row);
  }
}
scroller.addEventListener("scroll", draw);
draw();
</script></body></html>`;

const THREAD = `<!doctype html><html><head><title>Thread</title></head><body>
<main><h1>Thread</h1>
<article data-testid="tweet" data-id="1"><a href="/rhys/status/1">Rhys</a>
<p>Main tweet about page reading.</p>
<button onclick="document.title='liked'">Like</button>
</article>
<section id="replies">
<article data-testid="tweet" data-id="2"><a href="/alice/status/2">Alice</a><p>First reply, with details.</p></article>
<article data-testid="tweet" data-id="3"><a href="/bob/status/3">Bob</a><p>Second reply, also useful.</p></article>
</section>
<button id="more" onclick="document.getElementById('hidden-replies').hidden=false;this.remove()">Show more replies</button>
<div id="hidden-replies" hidden>
<article data-testid="tweet" data-id="4"><a href="/carol/status/4">Carol</a><p>Hidden reply, revealed by the button.</p></article>
</div>
</main>
<script>
setTimeout(function () {
  var article = document.createElement("article");
  article.setAttribute("data-testid", "tweet");
  article.setAttribute("data-id", "5");
  article.innerHTML = '<a href="/dave/status/5">Dave</a><p>Late reply, after the content settled started.</p>';
  document.getElementById("replies").append(article);
}, 1500);
</script>
</body></html>`;

export function dataRoutes(request, response) {
  const url = new URL(request.url ?? "/", "http://localhost");
  if (url.pathname === "/virtual") {
    response.setHeader("content-type", "text/html");
    response.end(VIRTUAL);
    return true;
  }
  if (url.pathname === "/thread") {
    response.setHeader("content-type", "text/html");
    response.end(THREAD);
    return true;
  }
  if (url.pathname === "/partial-data") {
    response.setHeader("content-type", "text/html");
    response.end(
      `<title>Partial data</title><script type="application/ld+json">{bad json}</script>
      <script type="application/json">{also bad}</script><p>Readable content.</p>`,
    );
    return true;
  }
  if (url.pathname === "/learn") {
    response.setHeader("content-type", "text/html");
    response.end(
      `<title>Learn</title><main><h1>Learn</h1>
      <button onclick="fetch('/learn/search?q=lamp')">Load lamps</button></main>
      <script>setTimeout(function () {
        fetch('/learn/checkout', {method: 'POST'});
        fetch('/learn/animation');
        window.__loaded = true;
      }, 1000);</script>`,
    );
    return true;
  }
  if (url.pathname === "/learn/checkout") {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ cart: [{ id: "c1", total: 10 }] }));
    return true;
  }
  if (url.pathname === "/learn/animation") {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ frames: [{ id: "f1", at: 1 }] }));
    return true;
  }
  if (url.pathname === "/learn/search") {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ items: [{ id: 1, name: "Lamp" }] }));
    return true;
  }
  if (url.pathname === "/deals") {
    response.setHeader("content-type", "text/html");
    response.end(ARTICLE);
    return true;
  }
  if (url.pathname === "/api/search" || url.pathname === "/api/echo") {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      response.setHeader("content-type", "application/json");
      response.setHeader("set-cookie", "seen=1; Path=/");
      response.end(
        JSON.stringify({
          method: request.method,
          query: Object.fromEntries(url.searchParams),
          body: body ? JSON.parse(body) : null,
          csrf: request.headers["x-csrf-token"] ?? null,
          signature: request.headers["x-signature"] ?? null,
          results: [{ id: 1, name: "Phone" }],
        }),
      );
    });
    return true;
  }
  if (url.pathname.startsWith("/item/")) {
    const id = url.pathname.slice("/item/".length);
    if (id === "3" && !limitedOnce.has(id)) {
      limitedOnce.add(id);
      response.statusCode = 429;
      response.setHeader("content-type", "text/html");
      response.end("<title>Slow down</title>Too many requests");
      return true;
    }
    response.setHeader("content-type", "text/html");
    response.end(`<title>Item ${id}</title><h1>Item ${id}</h1>`);
    return true;
  }
  if (url.pathname === "/challenge") {
    response.setHeader("content-type", "text/html");
    response.end(
      `<title>Verify you are human</title><main><h1>Verify</h1><div role="checkbox" aria-label="I am not a robot" style="width:32px;height:32px;border:1px solid #555" onclick="setTimeout(function(){document.querySelector('input[name=g-recaptcha-response]').value='token';document.title='cleared'},300)"></div><input type="hidden" name="g-recaptcha-response"></main>`,
    );
    return true;
  }
  return false;
}
