// browser.fetch: a request made by the extension itself, with no tab. It runs in the user's
// browser with the user's cookies, so it is fast for pages and APIs that need no JavaScript.
import {
  diagnosisOf,
  failureMessage,
  kindOfNetError,
  looksLikeBlockPage,
  type FetchDiagnosis,
  type Probe,
} from "./native-browser-fetch-errors.js";
import { HostBudget } from "./native-browser-rate.js";
import { engineConfig } from "./engine-config.js";
import { assertBrowserNetwork } from "./native-browser-dns.js";

const MAX_TEXT = 5_000_000;
const MAX_BINARY = 16_000_000;
const TIMEOUT_MS = 30_000;
// Engine-owned dynamic rule ids for a single fetch (page rules stay below 500000, boosts use
// 500000-599999, site rules 700000-789999).
const FETCH_RULE_BASE = 690_000;
const PROBE_TIMEOUT_MS = 8_000;
const RESERVED_NAME = /\.(invalid|test|example|localhost)$/i;
let ruleSequence = 0;
// 30 requests per host per 10 s, spaced when a caller goes faster.
const hostBudget = new HostBudget(30, 10_000);

interface FetchRequest {
  url: string;
  method?: string;
  /** Referer and Origin are set by the browser at the network layer (see withFetchHeaders). */
  headers?: Record<string, string>;
  body?: string;
  json?: unknown;
  credentials?: "include" | "omit";
  /** "auto" (default): JSON when it parses, else text. "base64" for binary files. */
  as?: "auto" | "text" | "base64";
  timeoutMs?: number;
}

export function isFetchRequest(value: Record<string, unknown> | null): boolean {
  return Boolean(value && typeof value.fetch === "object" && value.fetch);
}

export async function fetchCall(value: Record<string, unknown>): Promise<unknown> {
  const request = value.fetch as FetchRequest;
  const url = new URL(String(request.url));
  if (url.protocol !== "http:" && url.protocol !== "https:")
    throw new Error("browser.fetch only supports http and https addresses");
  await assertBrowserNetwork(url.href);
  const split = splitHeaders(request.headers);
  const timeout = Math.min(Math.max(Number(request.timeoutMs ?? TIMEOUT_MS), 1000), 120_000);
  let body = request.body;
  if (request.json !== undefined) {
    body = JSON.stringify(request.json);
    if (!split.headers.has("content-type")) split.headers.set("content-type", "application/json");
  }
  const rateWaitMs = hostBudget.take(url.host);
  if (rateWaitMs) await new Promise((resolve) => setTimeout(resolve, rateWaitMs));
  let response: Response;
  try {
    response = await withFetchHeaders(url, split, () =>
      fetch(url, {
        method: request.method ?? "GET",
        headers: split.headers,
        ...(body !== undefined ? { body } : {}),
        credentials: request.credentials ?? "include",
        redirect: "follow",
        signal: AbortSignal.timeout(timeout),
      }),
    );
  } catch (error) {
    throw await fetchFailure(url, error);
  }
  const result: Record<string, unknown> = {
    status: response.status,
    ok: response.ok,
    url: response.url,
    headers: Object.fromEntries(response.headers),
    ...(rateWaitMs ? { rateWaitMs } : {}),
  };
  if ((response.status === 401 || response.status === 403) && !split.referer && !split.origin)
    result.hint =
      "A site that refuses a bare request usually wants the page's Referer/Origin or a session " +
      "cookie: retry with referer/origin of the page (pass {headers: {referer, origin}}, or " +
      "asOrigin: true on browser.fetch), or call from the site's own tab with page.fetchJson(url) " +
      "so cookies and headers match. The body below is the refusal, not the answer.";
  if (request.as === "base64") return { ...result, ...(await base64(response)) };
  const text = await response.text();
  // A refusal page is kept, but bounded: enough to read a reason, not a 5 MB error page.
  const cap = response.ok ? MAX_TEXT : Math.min(MAX_TEXT, 200_000);
  if (request.as !== "text") {
    try {
      return { ...result, json: JSON.parse(text) as unknown };
    } catch {
      // Not JSON: return the text.
    }
  }
  return {
    ...result,
    text: text.length > cap ? text.slice(0, cap) : text,
    ...(text.length > cap ? { truncated: true, length: text.length } : {}),
  };
}

interface SplitHeaders {
  headers: Headers;
  referer?: string;
  origin?: string;
}

/** Referer and Origin cannot be set by fetch itself: the browser owns them. */
function splitHeaders(input: Record<string, string> | undefined): SplitHeaders {
  const headers = new Headers(input ?? {});
  let referer: string | undefined;
  let origin: string | undefined;
  for (const name of [...headers.keys()]) {
    const lower = name.toLowerCase();
    if (lower !== "referer" && lower !== "origin") continue;
    const header = headers.get(name) ?? "";
    headers.delete(name);
    if (lower === "referer") referer = header;
    else origin = header;
  }
  return { headers, ...(referer ? { referer } : {}), ...(origin ? { origin } : {}) };
}

/**
 * Sets Referer/Origin on this one request with a short-lived declarativeNetRequest rule, scoped to
 * the exact URL and removed as soon as the response starts. An API that checks where a call came
 * from is tested without a page (see help('network')).
 */
async function withFetchHeaders<T>(
  url: URL,
  split: SplitHeaders,
  run: () => Promise<T>,
): Promise<T> {
  if (!split.referer && !split.origin) return run();
  const rule = headerRule(url, split);
  await chrome.declarativeNetRequest.updateSessionRules({ addRules: [rule] });
  try {
    return await run();
  } finally {
    await chrome.declarativeNetRequest
      .updateSessionRules({ removeRuleIds: [rule.id] })
      .catch(() => undefined);
  }
}

function headerRule(url: URL, split: SplitHeaders): chrome.declarativeNetRequest.Rule {
  const requestHeaders: chrome.declarativeNetRequest.ModifyHeaderInfo[] = [];
  if (split.referer)
    requestHeaders.push({
      header: "Referer",
      operation: "set" as chrome.declarativeNetRequest.HeaderOperation,
      value: webAddress(split.referer) ?? url.origin + "/",
    });
  if (split.origin)
    requestHeaders.push({
      header: "Origin",
      operation: "set" as chrome.declarativeNetRequest.HeaderOperation,
      value: webAddress(split.origin) ?? url.origin,
    });
  return {
    id: FETCH_RULE_BASE + (++ruleSequence % 900),
    priority: 3,
    action: {
      type: "modifyHeaders" as chrome.declarativeNetRequest.RuleActionType,
      requestHeaders,
    },
    // Only this request: that exact URL, and only the request types fetch uses.
    condition: {
      urlFilter: "|" + url.href + "|",
      resourceTypes: [
        "xmlhttprequest" as chrome.declarativeNetRequest.ResourceType,
        "other" as chrome.declarativeNetRequest.ResourceType,
      ],
    },
  };
}

/** "x.com/page" as an address; anything that is not an http(s) address is ignored. */
function webAddress(value: string): string | undefined {
  const text = value.trim();
  if (!text) return undefined;
  try {
    const url = new URL(/^[a-z]+:/i.test(text) ? text : `https://${text}`);
    return ["http:", "https:"].includes(url.protocol) ? url.href : undefined;
  } catch {
    return undefined;
  }
}

function failed(diagnosis: FetchDiagnosis, host: string): Error {
  return new Error(failureMessage(diagnosis, host));
}

/** A failed fetch, named: timeout, dns, tls, refused, reset, cors or a block page. */
async function fetchFailure(url: URL, error: unknown): Promise<Error> {
  const host = url.hostname;
  const name = error instanceof Error ? error.name : "";
  const message = error instanceof Error ? error.message : String(error);
  if (/AbortError|TimeoutError/i.test(name + message))
    return failed(diagnosisOf("timeout", host, undefined, message), host);
  const named = kindOfNetError(message);
  if (named) return failed(diagnosisOf(named, host, undefined, message), host);
  // "Failed to fetch" hides the reason: look at the host itself.
  const probe = await probeHost(url);
  if (probe.netError)
    return failed(
      diagnosisOf(kindOfNetError(probe.netError) ?? "reset", host, probe, probe.netError),
      host,
    );
  if (probe.loaded && looksLikeBlockPage(probe, host))
    return failed(diagnosisOf("blocked-page", host, probe), host);
  if (probe.loaded) return failed(diagnosisOf("cors", host, probe, message), host);
  return failed(diagnosisOf("reset", host, probe, message), host);
}

interface HostProbe extends Probe {
  loaded?: boolean;
  /** The host answered something, so the request itself was refused. */
  reachable?: boolean;
}

async function probeHost(url: URL): Promise<HostProbe> {
  // A mode-less request the browser cannot read the body of still proves the host answers.
  const reachable = await fetch(url, {
    method: "GET",
    mode: "no-cors",
    credentials: "omit",
    cache: "no-store",
    signal: AbortSignal.timeout(5000),
  })
    .then(() => true)
    .catch(() => false);
  if (reachable) return { loaded: true, reachable: true };
  const probe = await navigateProbe(url);
  if (
    probe.netError &&
    kindOfNetError(probe.netError) === "dns" &&
    !RESERVED_NAME.test(url.hostname)
  )
    return { ...probe, ...(await blockPageProbe(url)) };
  return probe;
}

// Probes run one at a time: a sweep over many dead hosts must never open a burst of tabs.
let probeQueue: Promise<unknown> = Promise.resolve();

/** A background tab loads the address, so Chrome reports the net:: error or the block page. */
function navigateProbe(url: URL): Promise<HostProbe> {
  const run = probeQueue.then(() => navigateProbeNow(url));
  probeQueue = run.catch(() => undefined);
  return run;
}

async function navigateProbeNow(url: URL): Promise<HostProbe> {
  const tab = await chrome.tabs.create({ url: url.href, active: false }).catch(() => undefined);
  if (tab?.id === undefined) return {};
  try {
    return await watchProbe(tab.id);
  } finally {
    await chrome.tabs.remove(tab.id).catch(() => undefined);
  }
}

function watchProbe(tabId: number): Promise<HostProbe> {
  return new Promise((resolve) => {
    const finish = (probe: HostProbe) => {
      clearTimeout(timer);
      chrome.webNavigation.onErrorOccurred.removeListener(onError);
      chrome.webNavigation.onCompleted.removeListener(onComplete);
      resolve(probe);
    };
    const onError = (event: chrome.webNavigation.WebNavigationFramedErrorCallbackDetails) => {
      if (event.tabId === tabId && event.frameId === 0) finish({ netError: event.error });
    };
    const onComplete = (event: chrome.webNavigation.WebNavigationFramedCallbackDetails) => {
      if (event.tabId !== tabId || event.frameId !== 0) return;
      void readProbeText(tabId).then((page) =>
        finish({ loaded: true, finalUrl: event.url, ...page }),
      );
    };
    const timer = setTimeout(() => finish({}), PROBE_TIMEOUT_MS);
    chrome.webNavigation.onErrorOccurred.addListener(onError);
    chrome.webNavigation.onCompleted.addListener(onComplete);
  });
}

async function readProbeText(tabId: number): Promise<{ title?: string; text?: string }> {
  if (!chrome.scripting?.executeScript) return {};
  const results = await chrome.scripting
    .executeScript({ target: { tabId }, func: probeDocument })
    .catch(() => undefined);
  const value = results?.[0]?.result;
  return value && typeof value === "object" ? value : {};
}

function probeDocument(): { title: string; text: string } {
  return {
    title: document.title,
    text: (document.body?.innerText ?? "").slice(0, 3000),
  };
}

/** An address that does not resolve over https may still be hijacked over http. */
async function blockPageProbe(url: URL): Promise<HostProbe> {
  if (url.protocol !== "https:") return {};
  const probe = await navigateProbe(new URL(`http://${url.host}/`));
  return probe.loaded && looksLikeBlockPage(probe, url.hostname) ? probe : {};
}

async function base64(response: Response): Promise<Record<string, unknown>> {
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > MAX_BINARY) return { truncated: true, bytes: bytes.byteLength };
  let binary = "";
  for (let index = 0; index < bytes.byteLength; index += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  return { base64: btoa(binary), bytes: bytes.byteLength };
}
