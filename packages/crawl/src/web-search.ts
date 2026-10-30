// Web search without a browser or an API key: Exa, Parallel and TinyFish answer anonymously
// (EXA_API_KEY, PARALLEL_API_KEY, TINYFISH_API_KEY, TAVILY_API_KEY and FIRECRAWL_API_KEY raise
// their limits). Searches are spread across them; one that rate-limits or fails is cooled down
// and the same query goes to the next, so a caller only sees a failure when every provider fails.
// Ported from opencode's websearch providers (MIT, see THIRD_PARTY_NOTICES.md). A rate-limit
// message returned as a normal reply (Exa's free tier does this) also counts as a rate limit.

export type WebProvider = "exa" | "parallel" | "tavily" | "firecrawl" | "tinyfish";
export const WEB_PROVIDERS: readonly WebProvider[] = [
  "exa",
  "parallel",
  "tinyfish",
  "tavily",
  "firecrawl",
];

export interface WebResult {
  url: string;
  title?: string;
  content?: string;
  published?: string;
}

export interface WebAttempt {
  provider: WebProvider;
  outcome: "ok" | "empty" | "rate-limited" | "failed";
  detail?: string;
}

const MAX_RESPONSE_BYTES = 256 * 1024;
const TIMEOUT_MS = 25_000;
const USER_AGENT = "browser-crawl";
const RATE_LIMIT =
  /rate.?limit|too many requests|quota (exceeded|reached)|exceeded .{0,40}(limit|quota)|free mcp rate/i;
// Keyless results proved good from these; the rest are fallbacks. Firecrawl needs a key.
const PRIMARY: readonly WebProvider[] = ["exa", "parallel", "tinyfish"];

class SearchFailure extends Error {
  constructor(
    message: string,
    readonly rateLimited: boolean,
    readonly retryAfterMs?: number,
  ) {
    super(message);
  }
}

const cooldowns = new Map<WebProvider, number>();
const keyed = (name: string) => process.env[name]?.trim() || undefined;
const usable = (id: WebProvider) => id !== "firecrawl" || Boolean(keyed("FIRECRAWL_API_KEY"));

function order(first?: WebProvider): WebProvider[] {
  const now = Date.now();
  for (const [id, until] of cooldowns) if (until <= now) cooldowns.delete(id);
  const ready = WEB_PROVIDERS.filter((id) => usable(id) && !cooldowns.has(id));
  const cooling = WEB_PROVIDERS.filter((id) => usable(id) && cooldowns.has(id)).sort(
    (a, b) => (cooldowns.get(a) ?? 0) - (cooldowns.get(b) ?? 0),
  );
  const shuffled = ready.filter((id) => PRIMARY.includes(id)).sort(() => Math.random() - 0.5);
  const fallbacks = ready.filter((id) => !PRIMARY.includes(id));
  const head = first && ready.includes(first) ? [first] : [];
  // Cooling providers stay last: if everything else fails, one may have recovered.
  return [...head, ...[...shuffled, ...fallbacks].filter((id) => id !== first), ...cooling];
}

/** Searches the providers in turn until one answers; attempts says what each one did. */
export async function searchWeb(
  query: string,
  options: { limit?: number; provider?: WebProvider; signal?: AbortSignal } = {},
): Promise<{ provider?: WebProvider; results: WebResult[]; attempts: WebAttempt[] }> {
  const limit = options.limit ?? 10;
  const attempts: WebAttempt[] = [];
  for (const provider of order(options.provider)) {
    if (options.signal?.aborted) break;
    try {
      const results = (await runProvider(provider, query, limit, options.signal)).slice(0, limit);
      if (results.length) {
        attempts.push({ provider, outcome: "ok" });
        return { provider, results, attempts };
      }
      attempts.push({ provider, outcome: "empty" });
      if (attempts.filter((item) => item.outcome === "empty").length >= 2) break;
    } catch (error) {
      attempts.push(failed(provider, error));
    }
  }
  return { results: [], attempts };
}

function failed(provider: WebProvider, error: unknown): WebAttempt {
  const failure = error instanceof SearchFailure ? error : undefined;
  const message = error instanceof Error ? error.message : String(error);
  const wait = failure?.rateLimited ? (failure.retryAfterMs ?? 60_000) : 30_000;
  cooldowns.set(provider, Date.now() + wait);
  return {
    provider,
    outcome: failure?.rateLimited ? "rate-limited" : "failed",
    detail: message.slice(0, 200),
  };
}

function runProvider(provider: WebProvider, query: string, limit: number, signal?: AbortSignal) {
  if (provider === "exa") return exa(query, limit, signal);
  if (provider === "parallel") return parallel(query, signal);
  if (provider === "tavily") return tavily(query, limit, signal);
  if (provider === "firecrawl") return firecrawl(query, limit, signal);
  return tinyfish(query, signal);
}

async function post(
  url: string,
  body: unknown,
  headers: Record<string, string>,
  signal?: AbortSignal,
): Promise<string> {
  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  const response = await fetch(url, {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      "User-Agent": USER_AGENT,
      ...headers,
    },
    body: JSON.stringify(body),
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
  const text = await response.text();
  if (Buffer.byteLength(text, "utf8") > MAX_RESPONSE_BYTES)
    throw new SearchFailure("response too large", false);
  if (response.status === 429 || (!response.ok && RATE_LIMIT.test(text)))
    throw new SearchFailure(
      `rate limited (HTTP ${response.status})`,
      true,
      retryAfter(response.headers.get("retry-after")),
    );
  if (!response.ok)
    throw new SearchFailure(`HTTP ${response.status}: ${text.slice(0, 160)}`, false);
  return text;
}

function retryAfter(value: string | null): number | undefined {
  if (!value?.trim()) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
}

interface McpResult {
  content?: { type?: string; text?: string }[];
  structuredContent?: unknown;
  isError?: boolean;
}

/** Calls one MCP tool over streamable HTTP and returns its result (plain JSON or SSE). */
async function mcp(
  url: string,
  tool: string,
  args: Record<string, unknown>,
  headers: Record<string, string>,
  signal?: AbortSignal,
) {
  const body = await post(
    url,
    { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: tool, arguments: args } },
    headers,
    signal,
  );
  const result = parseMcp(body);
  if (!result) throw new SearchFailure("unreadable response", RATE_LIMIT.test(body));
  const text = result.content?.find((item) => typeof item.text === "string")?.text ?? "";
  // Free tiers sometimes answer a rate limit as a normal tool result; treat it as one.
  if ((result.isError || text.length < 600) && RATE_LIMIT.test(text))
    throw new SearchFailure(text.slice(0, 160), true);
  if (result.isError) throw new SearchFailure(text.slice(0, 160) || "tool error", false);
  return { text, structured: result.structuredContent };
}

function readMcp(payload: string): McpResult | undefined {
  const trimmed = payload.trim();
  if (!trimmed.startsWith("{")) return undefined;
  let parsed: { result?: McpResult; error?: { message?: string } };
  try {
    parsed = JSON.parse(trimmed) as typeof parsed;
  } catch {
    return undefined;
  }
  if (parsed.error)
    throw new SearchFailure(
      parsed.error.message ?? "MCP error",
      RATE_LIMIT.test(parsed.error.message ?? ""),
    );
  return parsed.result;
}

function parseMcp(body: string): McpResult | undefined {
  const direct = readMcp(body);
  if (direct) return direct;
  for (const line of body.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const data = readMcp(line.slice(5));
    if (data) return data;
  }
  return undefined;
}

function exaBlock(block: string): WebResult[] {
  const url = block.match(/^URL:\s*(.+)$/m)?.[1]?.trim();
  if (!url) return [];
  const title = block.match(/^Title:\s*(.+)$/m)?.[1]?.trim();
  const published = block.match(/^Published:\s*(.+)$/m)?.[1]?.trim();
  const content = block.match(/^(?:Highlights|Text):\s*\n?([\s\S]*)$/m)?.[1]?.trim();
  return [
    {
      url,
      ...(title && title !== "N/A" ? { title } : {}),
      ...(content ? { content } : {}),
      ...(published && published !== "N/A" ? { published } : {}),
    },
  ];
}

async function exa(query: string, limit: number, signal?: AbortSignal): Promise<WebResult[]> {
  const url = new URL("https://mcp.exa.ai/mcp");
  const key = keyed("EXA_API_KEY");
  if (key) url.searchParams.set("exaApiKey", key);
  const { text } = await mcp(
    url.toString(),
    "web_search_exa",
    { query, type: "auto", numResults: limit, livecrawl: "fallback" },
    {},
    signal,
  );
  return text.split(/\n\n---\n\n/).flatMap(exaBlock);
}

async function parallel(query: string, signal?: AbortSignal): Promise<WebResult[]> {
  const key = keyed("PARALLEL_API_KEY");
  const { structured } = await mcp(
    "https://search.parallel.ai/mcp",
    "web_search",
    { objective: query, search_queries: [query] },
    key ? { Authorization: `Bearer ${key}` } : {},
    signal,
  );
  type Item = {
    url: string;
    title?: string | null;
    publish_date?: string | null;
    excerpts?: string[];
  };
  const results = (structured as { results?: Item[] } | undefined)?.results ?? [];
  return results.map((item) => ({
    url: item.url,
    ...(item.title ? { title: item.title } : {}),
    ...(item.excerpts?.length ? { content: item.excerpts.join("\n\n") } : {}),
    ...(item.publish_date ? { published: item.publish_date } : {}),
  }));
}

async function tavily(query: string, limit: number, signal?: AbortSignal): Promise<WebResult[]> {
  const key = keyed("TAVILY_API_KEY");
  const body = await post(
    "https://api.tavily.com/search",
    { query, search_depth: "basic", chunks_per_source: 3, max_results: limit },
    {
      accept: "application/json",
      "X-Client-Name": USER_AGENT,
      ...(key ? { Authorization: `Bearer ${key}` } : { "X-Tavily-Access-Mode": "keyless" }),
    },
    signal,
  );
  const parsed = JSON.parse(body) as {
    results?: { url: string; title?: string; content?: string }[];
  };
  return (parsed.results ?? []).map((item) => ({
    url: item.url,
    ...(item.title ? { title: item.title } : {}),
    ...(item.content ? { content: item.content } : {}),
  }));
}

async function firecrawl(query: string, limit: number, signal?: AbortSignal): Promise<WebResult[]> {
  const key = keyed("FIRECRAWL_API_KEY");
  const { text } = await mcp(
    "https://mcp.firecrawl.dev/v2/mcp",
    "firecrawl_search",
    { query, limit },
    key ? { Authorization: `Bearer ${key}` } : {},
    signal,
  );
  const parsed = JSON.parse(text) as {
    data?: { web?: { url: string; title?: string | null; description?: string | null }[] };
  };
  return (parsed.data?.web ?? []).map((item) => ({
    url: item.url,
    ...(item.title ? { title: item.title } : {}),
    ...(item.description ? { content: item.description } : {}),
  }));
}

async function tinyfish(query: string, signal?: AbortSignal): Promise<WebResult[]> {
  const key = keyed("TINYFISH_API_KEY");
  const { text } = await mcp(
    "https://agent.tinyfish.ai/mcp",
    "search",
    { query },
    key ? { "X-API-Key": key } : { "X-TinyFish-Access-Mode": "keyless" },
    signal,
  );
  const parsed = JSON.parse(text) as {
    results?: { url: string; title?: string; snippet?: string }[];
  };
  return (parsed.results ?? []).map((item) => ({
    url: item.url,
    ...(item.title ? { title: item.title } : {}),
    ...(item.snippet ? { content: item.snippet } : {}),
  }));
}
