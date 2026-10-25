// Recorded network entries, their compact summaries for listing, and HAR 1.2 export.
export interface NetworkEntry {
  id: string;
  url: string;
  method: string;
  /** CDP resource type: XHR, Fetch, Document, EventSource, WebSocket… */
  type: string;
  startedAt: number;
  frameId?: string;
  documentURL?: string;
  requestHeaders: Record<string, string>;
  requestBody?: string;
  requestBodyPending?: boolean;
  /** What made the request: the script and its call stack (useful for finding signing code). */
  initiator?: {
    type: string;
    url?: string;
    stack?: { url: string; functionName: string; line: number }[];
  };
  redirects?: { url: string; status: number; headers: Record<string, string> }[];
  status?: number;
  statusText?: string;
  mimeType?: string;
  responseHeaders?: Record<string, string>;
  protocol?: string;
  /** The address the browser connected to (its own resolver, after DoH/hosts). */
  remoteIPAddress?: string;
  size?: number;
  durationMs?: number;
  body?: string;
  bodyBase64?: boolean;
  bodyTruncated?: boolean;
  bodyBytes?: number;
  bodyDropped?: boolean;
  frames?: { direction: "sent" | "received"; at: number; opcode: number; data: string }[];
  messages?: { at: number; event: string; data: string }[];
  failed?: string;
  done: boolean;
}

export function summarize(entry: NetworkEntry): Record<string, unknown> {
  const summary: Record<string, unknown> = {
    id: entry.id,
    method: entry.method,
    url: entry.url,
    type: entry.type,
  };
  if (entry.status !== undefined) summary.status = entry.status;
  if (entry.mimeType) summary.mimeType = entry.mimeType;
  if (entry.remoteIPAddress) summary.remoteIPAddress = entry.remoteIPAddress;
  if (entry.size !== undefined) summary.size = entry.size;
  summary.json = /json/i.test(entry.mimeType ?? "");
  if (entry.requestBody !== undefined) summary.requestBody = entry.requestBody.slice(0, 2000);
  if (entry.initiator?.url) summary.initiator = entry.initiator.url;
  if (!entry.done) summary.loading = true;
  if (entry.failed) summary.failed = entry.failed;
  if (entry.frames) summary.frames = entry.frames.length;
  if (entry.messages) summary.messages = entry.messages.length;
  return summary;
}

type HarHeader = { name: string; value: string };

function harHeaders(headers: Record<string, string> | undefined): HarHeader[] {
  return Object.entries(headers ?? {}).map(([name, value]) => ({ name, value }));
}

function cookies(header: string | undefined): HarHeader[] {
  if (!header) return [];
  return header
    .split(/;\s*/)
    .filter(Boolean)
    .map((pair) => {
      const index = pair.indexOf("=");
      return { name: pair.slice(0, index), value: pair.slice(index + 1) };
    });
}

function header(headers: Record<string, string> | undefined, name: string): string | undefined {
  const key = Object.keys(headers ?? {}).find((item) => item.toLowerCase() === name);
  return key ? headers?.[key] : undefined;
}

function queryString(url: string): HarHeader[] {
  try {
    return [...new URL(url).searchParams].map(([name, value]) => ({ name, value }));
  } catch {
    return [];
  }
}

function harEntry(entry: NetworkEntry): Record<string, unknown> {
  const requestType = header(entry.requestHeaders, "content-type") ?? "";
  return {
    startedDateTime: new Date(entry.startedAt).toISOString(),
    time: entry.durationMs ?? 0,
    _resourceType: entry.type.toLowerCase(),
    _initiator: entry.initiator,
    request: {
      method: entry.method,
      url: entry.url,
      httpVersion: entry.protocol ?? "HTTP/1.1",
      headers: harHeaders(entry.requestHeaders),
      queryString: queryString(entry.url),
      cookies: cookies(header(entry.requestHeaders, "cookie")),
      headersSize: -1,
      bodySize: entry.requestBody?.length ?? 0,
      ...(entry.requestBody !== undefined
        ? { postData: { mimeType: requestType, text: entry.requestBody } }
        : {}),
    },
    response: {
      status: entry.status ?? 0,
      statusText: entry.statusText ?? entry.failed ?? "",
      httpVersion: entry.protocol ?? "HTTP/1.1",
      headers: harHeaders(entry.responseHeaders),
      cookies: [],
      content: {
        size: entry.bodyBytes ?? entry.size ?? 0,
        mimeType: entry.mimeType ?? "",
        ...(entry.body !== undefined ? { text: entry.body } : {}),
      },
      redirectURL: header(entry.responseHeaders, "location") ?? "",
      headersSize: -1,
      bodySize: entry.size ?? -1,
    },
    cache: {},
    timings: { send: 0, wait: entry.durationMs ?? 0, receive: 0 },
    ...(entry.frames ? { _webSocketMessages: entry.frames } : {}),
    ...(entry.messages ? { _eventSourceMessages: entry.messages } : {}),
  };
}

/** HAR 1.2, readable by browser DevTools and every HAR tool. */
export function toHar(entries: NetworkEntry[]): Record<string, unknown> {
  return {
    log: {
      version: "1.2",
      creator: { name: "browserkit", version: "1" },
      pages: [],
      entries: entries.filter((entry) => entry.done || entry.type === "WebSocket").map(harEntry),
    },
  };
}
