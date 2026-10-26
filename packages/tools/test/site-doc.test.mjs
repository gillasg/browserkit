import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { siteDoc } from "../dist/site-doc.js";

test("a WebAgents manifest is bounded, cached and reused", async () => {
  const home = await mkdtemp(join(tmpdir(), "bue-agents-"));
  process.env.SITE_TO_API_HOME = home;
  let requests = 0;
  const server = createServer((request, response) => {
    if (!request.url?.endsWith("/.well-known/webagents.json")) {
      response.statusCode = 404;
      response.end();
      return;
    }
    requests += 1;
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify({
        version: 1,
        actions: [
          { name: "search", description: "Find things", effect: "read" },
          { name: "read", description: "Read one" },
          { name: "buy", description: "Buy one", effect: "write" },
        ],
      }),
    );
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const url = `http://127.0.0.1:${server.address().port}/`;
  try {
    const first = await siteDoc(url);
    assert.equal(first.actions.length, 3);
    const second = await siteDoc(url);
    assert.equal(second.actions.length, 3);
    assert.equal(requests, 1);
  } finally {
    server.close();
    await rm(home, { recursive: true, force: true });
  }
});
