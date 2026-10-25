import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import {
  PROVIDER_IDS,
  PROVIDERS,
  askDirect,
  cookieHeader,
  directRequest,
  imagePrompt,
  imageScript,
  parseProviderAnswer,
  uiScript,
  validateModel,
  youtubePrompt,
  youtubeVideoId,
} from "../dist/providers.js";

test("the five providers are defined with hosts, models and selectors", () => {
  assert.deepEqual(PROVIDER_IDS, ["chatgpt", "gemini", "perplexity", "grok", "kimi"]);
  for (const id of PROVIDER_IDS) {
    const provider = PROVIDERS[id];
    assert.equal(provider.id, id);
    assert.ok(provider.host, id);
    assert.ok(provider.chatUrl.startsWith("https://"), id);
    assert.ok(provider.models.includes(provider.defaultModel), id);
    assert.ok(provider.ui.composer.length > 0 && provider.ui.send.length > 0, id);
    assert.ok(provider.ui.answer.length > 0, id);
    assert.ok(provider.cookieDomains.length > 0, id);
  }
});

test("model validation allows a renamed model and warns instead of failing", () => {
  const known = validateModel("chatgpt", "gpt-5");
  assert.equal(known.known, true);
  assert.equal(known.warning, undefined);
  const renamed = validateModel("grok", "grok-9-ultra");
  assert.equal(renamed.ok, true);
  assert.equal(renamed.known, false);
  assert.match(String(renamed.warning), /not in the known Grok models/);
  assert.equal(validateModel("gemini").model, "auto");
  assert.throws(() => validateModel("gemini", "  "), /MODEL_REQUIRED/);
});

test("cookies become one header and values never appear in a listing", () => {
  assert.equal(
    cookieHeader([{ name: "a", value: "1" }, { name: "hidden" }, { name: "b", value: "2" }]),
    "a=1; b=2",
  );
  assert.equal(cookieHeader("a=1; b=2"), "a=1; b=2");
});

test("direct requests carry the provider's body and the session cookie", () => {
  const chatgpt = directRequest("chatgpt", { prompt: "hello", cookies: "s=1", model: "gpt-5" });
  assert.equal(chatgpt.url, "https://chatgpt.com/backend-api/conversation");
  assert.ok(chatgpt.prepare, "ChatGPT reads an access token from the session first");
  const chatBody = JSON.parse(chatgpt.body ?? "{}");
  assert.equal(chatBody.messages[0].content.parts[0], "hello");
  assert.equal(chatBody.model, "gpt-5");

  const perplexity = JSON.parse(
    directRequest("perplexity", { prompt: "p", cookies: "c=1" }).body ?? "{}",
  );
  assert.equal(perplexity.query_str, "p");
  assert.equal(perplexity.params.model_preference, "turbo");

  const grok = JSON.parse(directRequest("grok", { prompt: "g", cookies: "c=1" }).body ?? "{}");
  assert.equal(grok.message, "g");
  assert.equal(grok.modelName, "grok-4");

  const kimi = directRequest("kimi", { prompt: "k", cookies: "c=1" });
  assert.equal(kimi.headers.cookie, "c=1");
  assert.equal(JSON.parse(kimi.body ?? "{}").messages[0].content, "k");

  const gemini = directRequest("gemini", { prompt: "x", cookies: "c=1" });
  assert.match(String(gemini.body), /f\.req=/);
});

test("streamed answers are read from each provider's wire shape", () => {
  const chatgpt = [
    'data: {"message":{"author":{"role":"assistant"},"content":{"parts":["Hel"]}}}',
    'data: {"message":{"author":{"role":"assistant"},"content":{"parts":["Hello"]}}}',
    "data: [DONE]",
  ].join("\n");
  assert.equal(parseProviderAnswer("chatgpt", chatgpt), "Hello");

  assert.equal(
    parseProviderAnswer("perplexity", 'data: {"text":"one "}\ndata: {"text":"two"}\n'),
    "one two",
  );
  assert.equal(
    parseProviderAnswer(
      "grok",
      '{"result":{"response":{"token":"gr"}}}\n{"result":{"response":{"token":"ok"}}}',
    ),
    "grok",
  );
  assert.equal(parseProviderAnswer("kimi", 'data: {"text":"ki"}\ndata: {"text":"mi"}\n'), "kimi");
  assert.equal(parseProviderAnswer("perplexity", "not a stream"), "");
});

test("direct transport asks over HTTP and reports signed-out, then parses the answer", async () => {
  const server = createServer((request, response) => {
    if (request.headers.cookie !== "session=abc") {
      response.writeHead(401).end("no");
      return;
    }
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end('data: {"text":"Hello "}\ndata: {"text":"from the direct transport"}\n');
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  const base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
  try {
    const fetchImpl = (url, init) =>
      fetch(String(url).replace("https://www.perplexity.ai", base), init);
    const ok = await askDirect("perplexity", {
      prompt: "hello",
      cookies: "session=abc",
      fetchImpl,
    });
    assert.equal(ok.ok, true);
    assert.equal(ok.transport, "direct");
    assert.equal(ok.text, "Hello from the direct transport");

    const signedOut = await askDirect("perplexity", {
      prompt: "hello",
      cookies: "session=wrong",
      fetchImpl,
    });
    assert.equal(signedOut.ok, false);
    assert.equal(signedOut.reason, "signed-out");
  } finally {
    await new Promise((done) => server.close(done));
  }
});

test("a UI fallback script types the prompt and reads the answer", () => {
  const script = uiScript("gemini", 'Say "hello"', { timeoutMs: 5000 });
  assert.match(script, /gemini\.google\.com|model-response|rich-textarea/);
  assert.ok(script.includes(JSON.stringify('Say "hello"')));
  assert.match(script, /PROVIDER_TIMEOUT/);
  for (const id of PROVIDER_IDS) {
    const generated = uiScript(id, "hi");
    assert.ok(generated.includes(PROVIDERS[id].ui.composer[0]));
    assert.ok(generated.includes(PROVIDERS[id].ui.send[0]));
    assert.ok(generated.includes(PROVIDERS[id].ui.answer[0]));
  }
});

test("YouTube links are checked and turned into a Gemini prompt", () => {
  assert.equal(youtubeVideoId("https://www.youtube.com/watch?v=dQw4w9WgXcQ"), "dQw4w9WgXcQ");
  assert.equal(youtubeVideoId("https://youtu.be/dQw4w9WgXcQ?t=1"), "dQw4w9WgXcQ");
  assert.equal(youtubeVideoId("https://www.youtube.com/shorts/dQw4w9WgXcQ"), "dQw4w9WgXcQ");
  assert.equal(youtubeVideoId("https://example.com/watch?v=dQw4w9WgXcQ"), undefined);
  const prompt = youtubePrompt("https://youtu.be/dQw4w9WgXcQ", "What is the thesis?");
  assert.match(prompt, /What is the thesis\?/);
  assert.match(prompt, /https:\/\/www\.youtube\.com\/watch\?v=dQw4w9WgXcQ/);
  assert.throws(() => youtubePrompt("https://example.com", "?"), /YOUTUBE_URL/);
});

test("image prompts and the saving script cover generation and editing", () => {
  assert.match(imagePrompt("a red fox"), /^Generate an image: a red fox/);
  assert.match(
    imagePrompt("warmer light", { edit: true, images: ["in.png"] }),
    /^Edit the attached image: warmer light/,
  );
  assert.match(imagePrompt("warmer light", { edit: true, images: ["in.png"] }), /attached image/);
  const script = imageScript("a red fox", { out: "fox.png", images: ["in.png"] });
  assert.match(script, /page\.upload/);
  assert.match(script, /saveMedia/);
  assert.match(script, /fox\.png/);
});
