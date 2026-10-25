// Providers: ask a chat product the user is signed in to, using the browser's own session.
//
// The direct transport is the first choice: it makes the same request the provider's page makes,
// with the user's cookies, and reads the streamed answer. Provider APIs change without notice, so
// every failure is a typed reason ("signed-out", "no-direct-transport", "model", "parse") and the
// caller falls back to the page: the UI transport opens the provider's chat, types the prompt and
// reads the answer element. Nothing here prints a cookie or a token; values stay in the request.

import { randomUUID } from "node:crypto";

export type ProviderId = "chatgpt" | "gemini" | "perplexity" | "grok" | "kimi";

export interface ProviderSelectors {
  composer: string[];
  send: string[];
  answer: string[];
  /** Present once the page is ready for a prompt. */
  ready?: string[];
  /** The provider's stop button while an answer streams. */
  stop?: string[];
}

export type DirectKind = "chatgpt" | "gemini" | "perplexity" | "grok" | "kimi";

export interface ProviderDefinition {
  id: ProviderId;
  name: string;
  host: string;
  chatUrl: string;
  /** Cookie domains the session lives on (a leading dot includes subdomains). */
  cookieDomains: string[];
  models: string[];
  defaultModel: string;
  direct: DirectKind;
  ui: ProviderSelectors;
}

export type DirectFailure =
  | "no-direct-transport"
  | "signed-out"
  | "not-found"
  | "rate-limited"
  | "model"
  | "parse"
  | "network";

export interface ProviderAnswer {
  ok: boolean;
  provider: ProviderId;
  transport: "direct" | "ui";
  text: string;
  model: string;
  elapsedMs: number;
  reason?: DirectFailure;
  detail?: string;
}

export interface AskDirectOptions {
  prompt: string;
  model?: string;
  cookies?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export interface DirectRequest {
  url: string;
  method: "GET" | "POST";
  headers: Record<string, string>;
  body?: string;
  /** A token read from the session endpoint first; the request is built after it. */
  prepare?: (options: AskDirectOptions) => Promise<{ token?: string } | DirectFailure>;
}

export const PROVIDERS: Record<ProviderId, ProviderDefinition> = {
  chatgpt: {
    id: "chatgpt",
    name: "ChatGPT",
    host: "chatgpt.com",
    chatUrl: "https://chatgpt.com/",
    cookieDomains: ["chatgpt.com", ".chatgpt.com", ".openai.com"],
    models: ["auto", "gpt-5", "gpt-5-mini", "gpt-4.1", "gpt-4o"],
    defaultModel: "auto",
    direct: "chatgpt",
    ui: {
      composer: ["#prompt-textarea", "div[contenteditable='true']"],
      send: ["[data-testid='send-button']", "button[aria-label*='Send']"],
      answer: ["[data-message-author-role='assistant']"],
      stop: ["[data-testid='stop-button']"],
    },
  },
  gemini: {
    id: "gemini",
    name: "Gemini",
    host: "gemini.google.com",
    chatUrl: "https://gemini.google.com/app",
    cookieDomains: [".google.com", "gemini.google.com"],
    models: ["auto", "gemini-2.5-pro", "gemini-2.5-flash"],
    defaultModel: "auto",
    direct: "gemini",
    ui: {
      composer: [".ql-editor[contenteditable='true']", "rich-textarea div[contenteditable='true']"],
      send: ["button[aria-label*='Send']", "button.send-button"],
      answer: ["model-response message-content", ".model-response-text", "message-content"],
      stop: ["button[aria-label*='Stop']"],
    },
  },
  perplexity: {
    id: "perplexity",
    name: "Perplexity",
    host: "www.perplexity.ai",
    chatUrl: "https://www.perplexity.ai/",
    cookieDomains: ["perplexity.ai", ".perplexity.ai"],
    models: ["auto", "sonar", "sonar-pro", "gpt-5", "claude-4.5-sonnet"],
    defaultModel: "auto",
    direct: "perplexity",
    ui: {
      composer: ["textarea[placeholder]", "div[contenteditable='true']"],
      send: ["button[aria-label='Submit']", "button[type='submit']"],
      answer: [".prose", "[data-testid='answer']"],
      stop: ["button[aria-label*='Stop']"],
    },
  },
  grok: {
    id: "grok",
    name: "Grok",
    host: "grok.com",
    chatUrl: "https://grok.com/",
    cookieDomains: ["grok.com", ".grok.com", ".x.ai"],
    models: ["auto", "grok-4", "grok-4-fast", "grok-3"],
    defaultModel: "auto",
    direct: "grok",
    ui: {
      composer: ["textarea", "div[contenteditable='true']"],
      send: ["button[type='submit']", "button[aria-label*='Submit']"],
      answer: [".message-bubble", "[data-testid='assistant-message']"],
      stop: ["button[aria-label*='Stop']"],
    },
  },
  kimi: {
    id: "kimi",
    name: "Kimi",
    host: "kimi.moonshot.cn",
    chatUrl: "https://kimi.moonshot.cn/",
    cookieDomains: ["kimi.moonshot.cn", ".moonshot.cn"],
    models: ["auto", "kimi-k2", "kimi-k1.5"],
    defaultModel: "auto",
    direct: "kimi",
    ui: {
      composer: ["div[contenteditable='true']", "textarea"],
      send: ["button[class*='send']", "button[type='submit']"],
      answer: [".markdown", "[class*='message'] .markdown"],
      stop: ["button[aria-label*='Stop']"],
    },
  },
};

export const PROVIDER_IDS = Object.keys(PROVIDERS) as ProviderId[];

export function isProviderId(value: string): value is ProviderId {
  return Object.prototype.hasOwnProperty.call(PROVIDERS, value);
}

export function providerFor(value: string): ProviderDefinition {
  if (!isProviderId(value))
    throw new Error(`PROVIDER_UNKNOWN: ${value} (${PROVIDER_IDS.join(", ")})`);
  return PROVIDERS[value];
}

/** Model drift is expected; an unknown model is allowed with known:false, not rejected. */
export function validateModel(
  provider: ProviderId,
  model?: string,
): { ok: true; model: string; known: boolean; models: string[]; warning?: string } {
  const definition = PROVIDERS[provider];
  const wanted = (model ?? definition.defaultModel).trim();
  if (!wanted) throw new Error("MODEL_REQUIRED: give a model name or use auto");
  const known = definition.models.includes(wanted);
  return {
    ok: true,
    model: wanted,
    known,
    models: [...definition.models],
    ...(known
      ? {}
      : {
          warning: `${wanted} is not in the known ${definition.name} models; the provider may have renamed it`,
        }),
  };
}

/** A Cookie header from browser cookies; never logged. */
export function cookieHeader(cookies: { name: string; value?: string }[] | string): string {
  if (typeof cookies === "string") return cookies;
  return cookies
    .filter((cookie) => typeof cookie.value === "string")
    .map((cookie) => `${cookie.name}=${cookie.value}`)
    .join("; ");
}

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";

function jsonHeaders(cookies: string): Record<string, string> {
  return {
    "content-type": "application/json",
    accept: "*/*",
    "user-agent": USER_AGENT,
    cookie: cookies,
    origin: "https://chatgpt.com",
  };
}

function post(url: string, cookies: string, body: unknown, origin: string): DirectRequest {
  return {
    url,
    method: "POST",
    headers: { ...jsonHeaders(cookies), origin, referer: origin + "/" },
    body: JSON.stringify(body),
  };
}

/** The request the provider's own page makes, with the user's session. */
export function directRequest(provider: ProviderId, options: AskDirectOptions): DirectRequest {
  const definition = PROVIDERS[provider];
  const cookies = options.cookies ?? "";
  const model = options.model ?? definition.defaultModel;
  switch (definition.direct) {
    case "chatgpt":
      return {
        url: "https://chatgpt.com/backend-api/conversation",
        method: "POST",
        headers: {
          ...jsonHeaders(cookies),
          origin: "https://chatgpt.com",
          referer: "https://chatgpt.com/",
          accept: "text/event-stream",
        },
        body: JSON.stringify({
          action: "next",
          messages: [
            {
              id: randomUUID(),
              author: { role: "user" },
              content: { content_type: "text", parts: [options.prompt] },
            },
          ],
          model,
          parent_message_id: randomUUID(),
          conversation_mode: { kind: "primary_assistant" },
          force_paragen: false,
          force_rate_limit: false,
          history_and_training_disabled: true,
        }),
        prepare: async () => {
          const session = await fetchJson("https://chatgpt.com/api/auth/session", cookies, options);
          if (session === undefined) return "signed-out";
          const token = (session as { accessToken?: string }).accessToken;
          return token ? { token } : "signed-out";
        },
      };
    case "gemini":
      // Gemini needs a page token (`at`) that only the app page can mint. The UI transport is the
      // reliable one; this request is attempted with the cookie session only.
      return {
        url: "https://gemini.google.com/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate?rt=c",
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded;charset=UTF-8",
          accept: "*/*",
          "user-agent": USER_AGENT,
          cookie: cookies,
          origin: "https://gemini.google.com",
          referer: "https://gemini.google.com/app",
        },
        body: new URLSearchParams({
          "f.req": JSON.stringify([
            null,
            JSON.stringify([[options.prompt, 0, null, null, null, null, 0]]),
          ]),
        }).toString(),
      };
    case "perplexity":
      return post(
        "https://www.perplexity.ai/api/query",
        cookies,
        {
          query_str: options.prompt,
          params: {
            attachments: [],
            frontend_context_uuid: randomUUID(),
            frontend_uuid: randomUUID(),
            mode: "concise",
            model_preference: model === "auto" ? "turbo" : model,
            source: "mweb",
            language: "en",
            timezone: "UTC",
          },
        },
        "https://www.perplexity.ai",
      );
    case "grok":
      return post(
        "https://grok.com/rest/app-chat/conversations/new",
        cookies,
        {
          message: options.prompt,
          modelName: model === "auto" ? "grok-4" : model,
          modelMode: "MODEL_MODE_AUTO",
          disableSearch: false,
          enableImageGeneration: false,
          returnImageBytes: false,
          returnRawGrokInResponse: false,
          temporary: false,
        },
        "https://grok.com",
      );
    case "kimi":
      return post(
        "https://kimi.moonshot.cn/api/chat",
        cookies,
        {
          messages: [{ role: "user", content: options.prompt }],
          model: model === "auto" ? "kimi-k2" : model,
          use_search: true,
          refs: [],
        },
        "https://kimi.moonshot.cn",
      );
  }
}

async function fetchJson(
  url: string,
  cookies: string,
  options: AskDirectOptions,
): Promise<unknown | undefined> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(url, {
    headers: { accept: "application/json", "user-agent": USER_AGENT, cookie: cookies },
    signal: AbortSignal.timeout(Math.min(options.timeoutMs ?? 20000, 60000)),
  });
  if (!response.ok) return undefined;
  return response.json();
}

/** The streamed text, whatever the provider's wire shape is. */
export function parseProviderAnswer(provider: ProviderId, raw: string): string {
  switch (PROVIDERS[provider].direct) {
    case "chatgpt":
      return parseChatGpt(raw);
    case "gemini":
      return parseGemini(raw);
    case "perplexity":
      return parseSseText(raw, ["text", "answer", "chunk"]);
    case "grok":
      return parseJsonLines(raw);
    case "kimi":
      return parseSseText(raw, ["text", "content", "delta"]);
  }
}

function events(raw: string): string[] {
  return raw
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .filter((line) => line && line !== "[DONE]");
}

function parseChatGpt(raw: string): string {
  let text = "";
  for (const event of events(raw)) {
    let value: unknown;
    try {
      value = JSON.parse(event);
    } catch {
      continue;
    }
    const message = (
      value as { message?: { author?: { role?: string }; content?: { parts?: unknown[] } } }
    ).message;
    if (message?.author?.role !== "assistant" || !Array.isArray(message.content?.parts)) continue;
    const joined = message.content.parts
      .filter((part): part is string => typeof part === "string")
      .join("");
    if (joined) text = joined;
  }
  return text.trim();
}

function parseSseText(raw: string, keys: string[]): string {
  let text = "";
  for (const event of events(raw)) {
    let value: Record<string, unknown>;
    try {
      value = JSON.parse(event) as Record<string, unknown>;
    } catch {
      continue;
    }
    for (const key of keys) {
      const chunk = value[key];
      if (typeof chunk === "string") text += chunk;
    }
  }
  // A non-streamed answer is one JSON body.
  if (!text && raw.trim().startsWith("{")) {
    try {
      const value = JSON.parse(raw) as Record<string, unknown>;
      for (const key of keys) if (typeof value[key] === "string") text += value[key];
    } catch {
      /* ignore */
    }
  }
  return text.trim();
}

function parseJsonLines(raw: string): string {
  let text = "";
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim().startsWith("{")) continue;
    try {
      const value = JSON.parse(line) as {
        result?: { response?: { token?: string; modelResponse?: { message?: string } } };
      };
      const response = value.result?.response;
      if (typeof response?.token === "string") text += response.token;
      else if (typeof response?.modelResponse?.message === "string")
        text += response.modelResponse.message;
    } catch {
      /* a partial line at the end of a stream */
    }
  }
  return text.trim();
}

/** Gemini answers arrive as nested arrays; take the longest text from the wrb.fr frame. */
function parseGemini(raw: string): string {
  let text = "";
  for (const line of raw.split(/\r?\n/)) {
    const at = line.indexOf("wrb.fr");
    if (at < 0) continue;
    const start = line.indexOf("[", at);
    if (start < 0) continue;
    try {
      const parsed = JSON.parse(JSON.parse(line.slice(start))[0][2]) as unknown;
      const found = longestStrings(parsed).filter((item) => item.length > text.length);
      if (found[0]) text = found[0];
    } catch {
      /* not this frame */
    }
  }
  return text.trim();
}

function longestStrings(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") {
    if (value.length > 24 && !/^[\w-]+$/.test(value)) out.push(value);
  } else if (Array.isArray(value)) {
    for (const item of value) longestStrings(item, out);
  }
  return out.sort((left, right) => right.length - left.length);
}

function failureReason(status: number): DirectFailure {
  if (status === 401 || status === 403) return "signed-out";
  if (status === 404) return "not-found";
  if (status === 429) return "rate-limited";
  return "network";
}

/** Direct transport: the provider's own request with the browser's cookies. */
export async function askDirect(
  provider: ProviderId,
  options: AskDirectOptions,
): Promise<ProviderAnswer> {
  const started = Date.now();
  const definition = PROVIDERS[provider];
  const model = (options.model ?? definition.defaultModel).trim();
  const base = { provider, model, elapsedMs: 0 } as const;
  try {
    const request = directRequest(provider, { ...options, model });
    let headers = { ...request.headers };
    if (request.prepare) {
      const prepared = await request.prepare({ ...options, model });
      if (typeof prepared === "string")
        return {
          ...base,
          ok: false,
          transport: "direct",
          text: "",
          reason: prepared,
          elapsedMs: Date.now() - started,
        };
      if (prepared.token) headers = { ...headers, authorization: `Bearer ${prepared.token}` };
    }
    const fetchImpl = options.fetchImpl ?? fetch;
    const response = await fetchImpl(request.url, {
      method: request.method,
      headers,
      ...(request.body === undefined ? {} : { body: request.body }),
      signal: AbortSignal.timeout(Math.min(options.timeoutMs ?? 120000, 180000)),
    });
    if (!response.ok)
      return {
        ...base,
        ok: false,
        transport: "direct",
        text: "",
        reason: failureReason(response.status),
        detail: `${response.status} ${response.statusText}`.trim(),
        elapsedMs: Date.now() - started,
      };
    const raw = await response.text();
    const text = parseProviderAnswer(provider, raw);
    if (!text)
      return {
        ...base,
        ok: false,
        transport: "direct",
        text: "",
        reason: "parse",
        detail: raw.slice(0, 200),
        elapsedMs: Date.now() - started,
      };
    return { ...base, ok: true, transport: "direct", text, elapsedMs: Date.now() - started };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      ...base,
      ok: false,
      transport: "direct",
      text: "",
      reason: /abort|timeout/i.test(detail) ? "network" : "network",
      detail,
      elapsedMs: Date.now() - started,
    };
  }
}

/** The page fallback: open the provider, type the prompt, read the answer element. */
export function uiScript(
  provider: ProviderId,
  prompt: string,
  options: { timeoutMs?: number; pollMs?: number } = {},
): string {
  const definition = PROVIDERS[provider];
  const timeout = Math.min(options.timeoutMs ?? 120000, 300000);
  const poll = Math.min(Math.max(options.pollMs ?? 700, 100), 5000);
  const first = (selectors: string[]) => JSON.stringify(selectors[0] ?? "");
  return `(async () => {
  const prompt = ${JSON.stringify(prompt)};
  const deadline = Date.now() + ${timeout};
  const textOf = async () => (await page.locator(${first(definition.ui.answer)}).allTextContents())
    .map((item) => item.trim()).filter(Boolean).join("\\n");
  const composer = page.locator(${first(definition.ui.composer)}).first();
  await composer.click();
  await composer.fill(prompt);
  await page.locator(${first(definition.ui.send)}).first().click();
  let last = "", stable = 0;
  while (Date.now() < deadline) {
    await page.waitForTimeout(${poll});
    const text = await textOf();
    if (text && text === last) { if (++stable >= 3) return text; }
    else { last = text; stable = 0; }
  }
  if (last) return last;
  throw new Error("PROVIDER_TIMEOUT: no answer appeared; the provider's page may have changed");
})()`;
}

/** YouTube analysis prompt and link checks, shared by the media tools. */
export function youtubeVideoId(url: string): string | undefined {
  const match =
    /(?:youtube\.com\/(?:watch\?(?:.*&)?v=|shorts\/|live\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/.exec(
      url,
    );
  return match?.[1];
}

export function youtubePrompt(url: string, question: string): string {
  const id = youtubeVideoId(url);
  if (!id) throw new Error("YOUTUBE_URL: give a youtube.com/watch, youtu.be, shorts or live link");
  const asked = question.trim() || "Summarise the video with timestamps for the key points.";
  return `Watch this video and answer from its content: ${asked}\n\nhttps://www.youtube.com/watch?v=${id}`;
}

/** Gemini image generation and editing: the prompt, plus the script that saves the result. */
export function imagePrompt(
  prompt: string,
  options: { edit?: boolean; images?: string[] } = {},
): string {
  const verb = options.edit ? "Edit the attached image" : "Generate an image";
  const extra = options.images?.length
    ? `\nKeep the composition and identity from the attached image${options.images.length > 1 ? "s" : ""}.`
    : "";
  return `${verb}: ${prompt.trim()}. Return the image itself, with no commentary.${extra}`;
}

export function imageScript(
  prompt: string,
  options: { out?: string; images?: string[]; timeoutMs?: number } = {},
): string {
  const out = (options.out ?? "gemini-image.png").replace(/[^A-Za-z0-9._/-]+/g, "-");
  const files = options.images?.length ? JSON.stringify(options.images) : undefined;
  return `(async () => {
  const prompt = ${JSON.stringify(prompt)};
  const deadline = Date.now() + ${Math.min(options.timeoutMs ?? 180000, 300000)};
  const composer = page.locator(${firstOf(PROVIDERS.gemini.ui.composer)}).first();
  await composer.click();
  await composer.fill(prompt);
  ${files ? `await page.upload("input[type=file]", ${files});` : ""}
  await page.locator(${firstOf(PROVIDERS.gemini.ui.send)}).first().click();
  while (Date.now() < deadline) {
    await page.waitForTimeout(1000);
    const image = await page.locator("img[src^='data:image'], img[src*='googleusercontent']").last();
    if (await image.count()) {
      const saved = await page.saveMedia(${JSON.stringify("img[src^='data:image'], img[src*='googleusercontent']")}, { name: ${JSON.stringify(out)} });
      return { saved };
    }
  }
  throw new Error("PROVIDER_TIMEOUT: Gemini returned no image; the page may have changed");
})()`;
}

function firstOf(selectors: string[]): string {
  return JSON.stringify(selectors[0] ?? "");
}

/** What a provider call can do right now, for "providers" and the ask command's errors. */
export function transportSummary(provider: ProviderId): {
  provider: ProviderId;
  name: string;
  host: string;
  direct: boolean;
  models: string[];
  defaultModel: string;
} {
  const definition = PROVIDERS[provider];
  return {
    provider: definition.id,
    name: definition.name,
    host: definition.host,
    direct: true,
    models: [...definition.models],
    defaultModel: definition.defaultModel,
  };
}
