// Child debugger sessions: a tab's out-of-process iframes, dedicated/shared workers and service
// workers each get their own session when Target.setAutoAttach is on. Kept here so the network
// recorder can tag entries with where their request came from and read bodies from that session.

export interface ChildScope {
  sessionId?: string;
  source?: "worker" | "service-worker";
  frameUrl?: string;
}

export const childScopes = new Map<string, ChildScope>();

export const NETWORK_BUFFERS = {
  maxTotalBufferSize: 100_000_000,
  maxResourceBufferSize: 10_000_000,
  maxPostDataSize: 1_000_000,
};

export function scopeKey(tabId: number, sessionId: string): string {
  return `${tabId}:${sessionId}`;
}

/** A worker or out-of-process iframe attached: record its requests in the same tab's store. */
export function attachChild(tabId: number, params: Record<string, unknown>): void {
  const info = params.targetInfo as { type?: string; url?: string } | undefined;
  const sessionId = String(params.sessionId ?? "");
  const type = info?.type ?? "";
  if (!sessionId || !["worker", "service_worker", "shared_worker", "iframe"].includes(type)) return;
  const source: ChildScope["source"] =
    type === "service_worker"
      ? "service-worker"
      : type === "worker" || type === "shared_worker"
        ? "worker"
        : undefined;
  childScopes.set(scopeKey(tabId, sessionId), {
    ...(info?.url ? { frameUrl: info.url } : {}),
    ...(source ? { source } : {}),
  });
  void chrome.debugger
    .sendCommand({ tabId, sessionId }, "Network.enable", NETWORK_BUFFERS)
    .catch(() => undefined);
}
