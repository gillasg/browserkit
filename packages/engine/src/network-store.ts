// A host-wide network store: every finished request from every tab the agent worked in, kept in a
// bounded ring so a capture survives the tab closing or navigating. The per-tab recorder still
// owns bodies during a run; this store is for asking across tabs afterwards: what did we see,
// what did this endpoint return, what would the curl look like, what origins were touched, and
// what does the whole session look like as a HAR.

import type { NetworkEntry } from "./native-browser-network-format.js";

export type StaticKind = "static" | "dynamic";

export interface StoredEntry {
  id: string;
  tabId: number;
  url: string;
  method: string;
  status: number;
  type: string;
  mimeType?: string;
  startedAt: number;
  durationMs?: number;
  size?: number;
  body?: string;
  bodyTruncated?: boolean;
  requestHeaders: Record<string, string>;
  responseHeaders?: Record<string, string>;
  requestBody?: string;
  tabUrl?: string;
}

export interface StoreFilter {
  match?: string;
  origin?: string;
  method?: string;
  type?: string;
  status?: number;
  /** "static" for images, fonts, stylesheets and scripts; "dynamic" for documents and calls. */
  static?: StaticKind;
  since?: number;
  until?: number;
  limit?: number;
}

const MAX_ENTRIES = 3000;
const MAX_BODY_BYTES = 40_000_000;
const MAX_ONE_BODY = 1_000_000;
const TTL_MS = 60 * 60 * 1000;

const entries: StoredEntry[] = [];
let bodyBytes = 0;

const STATIC_TYPES = new Set(["Image", "Font", "Stylesheet", "Script", "Media"]);

export function recordGlobalEntry(tabId: number, entry: NetworkEntry, tabUrl?: string): void {
  const stored: StoredEntry = {
    id: `${tabId}:${entry.id}`,
    tabId,
    url: entry.url,
    method: entry.method,
    status: entry.status ?? 0,
    type: entry.type,
    startedAt: entry.startedAt,
    requestHeaders: entry.requestHeaders ?? {},
    ...(entry.mimeType ? { mimeType: entry.mimeType } : {}),
    ...(entry.durationMs === undefined ? {} : { durationMs: entry.durationMs }),
    ...(entry.size === undefined ? {} : { size: entry.size }),
    ...(entry.responseHeaders ? { responseHeaders: entry.responseHeaders } : {}),
    ...(entry.requestBody ? { requestBody: entry.requestBody } : {}),
    ...(tabUrl ? { tabUrl } : {}),
  };
  if (entry.body) {
    stored.body = entry.body.length > MAX_ONE_BODY ? entry.body.slice(0, MAX_ONE_BODY) : entry.body;
    if (entry.body.length > MAX_ONE_BODY) stored.bodyTruncated = true;
    bodyBytes += stored.body.length;
  }
  entries.push(stored);
  sweep();
}

function sweep(): void {
  const cutoff = Date.now() - TTL_MS;
  while (entries.length && (entries[0] as StoredEntry).startedAt < cutoff) dropFirst();
  while (entries.length > MAX_ENTRIES) dropFirst();
  while (bodyBytes > MAX_BODY_BYTES && entries.length) dropFirst();
}

function dropFirst(): void {
  const removed = entries.shift();
  if (removed?.body) bodyBytes -= removed.body.length;
}

export function queryGlobal(filter: StoreFilter = {}): StoredEntry[] {
  sweep();
  const match = filter.match?.toLowerCase();
  const rows = entries.filter((entry) => matches(entry, filter, match));
  const limit = Math.min(Math.max(filter.limit ?? 200, 1), 1000);
  return rows.slice(-limit);
}

function matches(entry: StoredEntry, filter: StoreFilter, match?: string): boolean {
  if (match && !`${entry.url} ${entry.method} ${entry.status}`.toLowerCase().includes(match))
    return false;
  if (filter.origin && !entry.url.startsWith(filter.origin)) return false;
  if (filter.method && entry.method.toUpperCase() !== filter.method.toUpperCase()) return false;
  if (filter.type && entry.type !== filter.type) return false;
  if (filter.status !== undefined && entry.status !== filter.status) return false;
  if (filter.since !== undefined && entry.startedAt < filter.since) return false;
  if (filter.until !== undefined && entry.startedAt > filter.until) return false;
  if (filter.static === "static" && !STATIC_TYPES.has(entry.type)) return false;
  if (filter.static === "dynamic" && STATIC_TYPES.has(entry.type)) return false;
  return true;
}

export function getGlobal(id: string): StoredEntry | undefined {
  sweep();
  return entries.find((entry) => entry.id === id);
}

export function bodyGlobal(id: string): {
  id: string;
  body?: string;
  truncated?: boolean;
  reason?: string;
} {
  const entry = getGlobal(id);
  if (!entry) return { id, reason: "no request with that id in the store" };
  if (entry.body === undefined)
    return {
      id,
      reason:
        "no body was captured for this request; a body is kept for site calls made while a tab was open",
    };
  return {
    id,
    body: entry.body,
    ...(entry.bodyTruncated ? { truncated: true } : {}),
  };
}

const SECRET_HEADER =
  /^(cookie|set-cookie|authorization|proxy-authorization|x-csrf-token|x-xsrf-token)$/i;

export function curlGlobal(id: string, secrets = false): string | undefined {
  const entry = getGlobal(id);
  if (!entry) return undefined;
  const lines = [`curl '${entry.url}'`, `  -X ${entry.method}`];
  for (const [name, value] of Object.entries(entry.requestHeaders ?? {})) {
    if (!secrets && SECRET_HEADER.test(name)) continue;
    lines.push(`  -H '${name}: ${String(value).replace(/'/g, "'\\''")}'`);
  }
  if (entry.requestBody) lines.push(`  --data-raw '${entry.requestBody.replace(/'/g, "'\\''")}'`);
  return lines.join(" \\\n");
}

export function originsGlobal(): { origin: string; requests: number; bytes: number }[] {
  sweep();
  const byOrigin = new Map<string, { requests: number; bytes: number }>();
  for (const entry of entries) {
    const origin = originOf(entry.url);
    const current = byOrigin.get(origin) ?? { requests: 0, bytes: 0 };
    current.requests += 1;
    current.bytes += entry.size ?? 0;
    byOrigin.set(origin, current);
  }
  return [...byOrigin]
    .map(([origin, value]) => ({ origin, ...value }))
    .sort((left, right) => right.requests - left.requests);
}

function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return "invalid";
  }
}

export function statsGlobal(): {
  requests: number;
  bytes: number;
  bodyBytes: number;
  firstAt?: number;
  lastAt?: number;
  byType: { type: string; count: number }[];
  byStatus: { status: number; count: number }[];
} {
  sweep();
  const byType = new Map<string, number>();
  const byStatus = new Map<number, number>();
  let bytes = 0;
  for (const entry of entries) {
    byType.set(entry.type, (byType.get(entry.type) ?? 0) + 1);
    byStatus.set(entry.status, (byStatus.get(entry.status) ?? 0) + 1);
    bytes += entry.size ?? 0;
  }
  return {
    requests: entries.length,
    bytes,
    bodyBytes,
    ...(entries.length
      ? { firstAt: entries[0]?.startedAt ?? 0, lastAt: entries.at(-1)?.startedAt ?? 0 }
      : {}),
    byType: [...byType].map(([type, count]) => ({ type, count })),
    byStatus: [...byStatus].map(([status, count]) => ({ status, count })),
  };
}

export function harGlobal(filter: StoreFilter = {}): unknown {
  const rows = queryGlobal({ ...filter, limit: filter.limit ?? 1000 });
  return {
    log: {
      version: "1.2",
      creator: { name: "browserkit", version: "1" },
      entries: rows.map((entry) => ({
        startedDateTime: new Date(entry.startedAt).toISOString(),
        time: entry.durationMs ?? 0,
        request: {
          method: entry.method,
          url: entry.url,
          httpVersion: "HTTP/1.1",
          headers: Object.entries(entry.requestHeaders ?? {}).map(([name, value]) => ({
            name,
            value,
          })),
          queryString: queryOf(entry.url),
          cookies: [],
          headersSize: -1,
          bodySize: entry.requestBody?.length ?? 0,
          ...(entry.requestBody
            ? { postData: { mimeType: entry.mimeType ?? "text/plain", text: entry.requestBody } }
            : {}),
        },
        response: {
          status: entry.status,
          statusText: "",
          httpVersion: "HTTP/1.1",
          headers: Object.entries(entry.responseHeaders ?? {}).map(([name, value]) => ({
            name,
            value,
          })),
          cookies: [],
          content: {
            size: entry.body?.length ?? entry.size ?? 0,
            mimeType: entry.mimeType ?? "",
            ...(entry.body === undefined ? {} : { text: entry.body }),
          },
          redirectURL: "",
          headersSize: -1,
          bodySize: entry.size ?? 0,
        },
        cache: {},
        timings: { send: 0, wait: entry.durationMs ?? 0, receive: 0 },
        ...(entry.tabId ? { _tabId: entry.tabId } : {}),
      })),
    },
  };
}

function queryOf(url: string): { name: string; value: string }[] {
  try {
    return [...new URL(url).searchParams].map(([name, value]) => ({ name, value }));
  } catch {
    return [];
  }
}

export function clearGlobal(): { cleared: number } {
  const cleared = entries.length;
  entries.length = 0;
  bodyBytes = 0;
  return { cleared };
}

/** Entry ids include the tab, so a body can still be found after the tab is gone. */
export function storeSize(): { entries: number; bodyBytes: number } {
  return { entries: entries.length, bodyBytes };
}
