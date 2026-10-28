// The node runtime of a script way. Its `browser.fetch` answers in the same shape as browser
// code's (status, ok, url, headers, then json, text or base64), so an ability written in a cell
// runs unchanged here. One difference stays: node has no browser session, so no cookies are sent;
// a signed-in call belongs in an api way (the site's session) or a page script.

import vm from "node:vm";

const TIMEOUT_MS = 30_000;
const MAX_TEXT = 2_000_000;

interface NodeFetchInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  json?: unknown;
  as?: "auto" | "text" | "base64";
  asOrigin?: boolean;
  timeoutMs?: number;
}

function requestHeaders(url: string, init: NodeFetchInit): Record<string, string> {
  const headers: Record<string, string> = { ...(init.headers ?? {}) };
  if (init.asOrigin) {
    const origin = new URL(url).origin;
    headers.referer ??= origin + "/";
    headers.origin ??= origin;
  }
  if (init.json !== undefined) headers["content-type"] ??= "application/json";
  return headers;
}

async function body(response: Response, as: NodeFetchInit["as"]): Promise<Record<string, unknown>> {
  if (as === "base64")
    return { base64: Buffer.from(await response.arrayBuffer()).toString("base64") };
  const text = await response.text();
  if (as !== "text") {
    try {
      return { json: JSON.parse(text) as unknown };
    } catch {
      // Not JSON: return the text.
    }
  }
  return text.length > MAX_TEXT
    ? { text: text.slice(0, MAX_TEXT), truncated: true, length: text.length }
    : { text };
}

/** browser.fetch for node scripts, in browser code's result shape. */
export async function nodeFetch(url: string, init: NodeFetchInit = {}): Promise<unknown> {
  const response = await fetch(String(url), {
    method: init.method ?? (init.json !== undefined ? "POST" : "GET"),
    headers: requestHeaders(String(url), init),
    ...(init.json !== undefined ? { body: JSON.stringify(init.json) } : {}),
    ...(init.body !== undefined ? { body: init.body } : {}),
    redirect: "follow",
    signal: AbortSignal.timeout(init.timeoutMs ?? TIMEOUT_MS),
  });
  return {
    status: response.status,
    ok: response.ok,
    url: response.url,
    headers: Object.fromEntries(response.headers),
    ...(await body(response, init.as)),
  };
}

export async function runNodeScript(
  code: string,
  inputs: Record<string, unknown>,
  call: (operation: string, params: Record<string, unknown>) => Promise<unknown>,
): Promise<unknown> {
  const context = vm.createContext({
    siteMapper: { call, write: call },
    browser: { fetch: nodeFetch },
    inputs,
    args: inputs,
  });
  const result = new vm.Script(`(async () => { ${code}\n })()`, {
    filename: "ability.js",
  }).runInContext(context, { timeout: TIMEOUT_MS }) as Promise<unknown>;
  return Promise.race([
    result,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("ABILITY_TIMEOUT: node script exceeded 30s")), TIMEOUT_MS),
    ),
  ]);
}
