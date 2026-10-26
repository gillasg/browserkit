import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// chrome.scripting.executeScript({func}) sends only watchUserInput's own source to the page.
// Execute that exact built source in a bare scope: a helper referenced from it would be undefined
// in the page, so this catches the class of bug instead of silently breaking user take-over.
test("the injected input watcher carries its own overlay check", async () => {
  const file = new URL("../apps/extension/build/service-worker.js", import.meta.url);
  const source = await readFile(file, "utf8");
  const start = source.indexOf("function watchUserInput");
  assert.ok(start >= 0, "run pnpm build before this test");
  const end = source.indexOf("\n  }\n", start);
  assert.ok(end > start);
  const body = source.slice(start, end + 5);
  assert.match(body, /composedPath\(\)\.some/);
  assert.doesNotMatch(body, /isBrowserkitOverlayEvent/);

  let listener = () => undefined;
  const sent = [];
  const fakeWindow = {
    addEventListener: (_type, callback) => {
      listener = callback;
    },
  };
  const fakeChrome = {
    runtime: {
      sendMessage: (message) => {
        sent.push(message);
        return Promise.resolve();
      },
    },
  };
  const fakeDocument = { hasFocus: () => true };
  const run = new Function(
    "window",
    "chrome",
    "document",
    "KeyboardEvent",
    `${body}\nwatchUserInput();`,
  );
  run(fakeWindow, fakeChrome, fakeDocument, class {});

  listener({
    isTrusted: true,
    composedPath: () => [{ hasAttribute: (name) => name === "data-browserkit-overlay" }],
  });
  assert.equal(sent.length, 0);
  listener({ isTrusted: true, composedPath: () => [] });
  assert.equal(sent.length, 1);
});
