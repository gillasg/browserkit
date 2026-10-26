import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { siteDir, siteName, writeAtomic } from "@browserkit/site-mapper";

// WebAgents/llms.txt documents describe what a site offers agents. They are fetched once per
// site, bounded, kept with the mapped site, and read by page code through a host request. A
// failure is never a step error: the caller gets {available:false}.
export interface SiteDoc {
  site: string;
  at: number;
  etag?: string;
  source?: string;
  version?: number;
  endpoint?: string;
  actions: { name: string; description?: string; effect?: string }[];
  llms?: { title?: string; summary?: string; url?: string };
  available: boolean;
}

const DAY = 24 * 60 * 60_000;
const MAX_MANIFEST = 64 * 1024;
const MAX_LLMS = 32 * 1024;

export function isSiteDocRequest(value: unknown): value is { siteDoc: { url?: unknown } } {
  return Boolean(value && typeof (value as { siteDoc?: unknown }).siteDoc === "object");
}

export async function siteDoc(url: string): Promise<SiteDoc> {
  const base = new URL(url);
  const host = base.hostname.replace(/^www\\./, "");
  const path = join(siteDir(host), "agents.json");
  let cached: SiteDoc | undefined;
  try {
    cached = JSON.parse(await readFile(path, "utf8")) as SiteDoc;
  } catch {
    cached = undefined;
  }
  if (cached && Date.now() - cached.at < 7 * DAY) return cached;
  const headers = cached?.etag ? { "if-none-match": cached.etag } : {};
  const manifest = await get(new URL("/.well-known/webagents.json", base), MAX_MANIFEST, headers);
  let doc: SiteDoc = { site: host, at: Date.now(), actions: [], available: false };
  if (manifest.status === 304 && cached) doc = { ...cached, at: Date.now() };
  else if (manifest.ok && manifest.text) {
    const parsed = parseManifest(manifest.text, base);
    if (parsed) doc = { ...doc, ...parsed, ...(manifest.etag ? { etag: manifest.etag } : {}) };
  }
  if (!doc.actions.length) {
    const md = await get(new URL("/webagents.md", base), MAX_MANIFEST);
    const parsed = md.ok && md.text ? parseMarkdown(md.text, base) : undefined;
    if (parsed) doc = { ...doc, ...parsed, available: true };
  }
  const llms = await get(new URL("/llms.txt", base), MAX_LLMS);
  if (llms.ok && llms.text) {
    const value = parseLlms(llms.text, base);
    if (value) doc = { ...doc, llms: value };
  }
  if (manifest.ok || doc.actions.length || doc.llms) doc.available = true;
  await mkdir(siteDir(host), { recursive: true }).catch(() => undefined);
  await writeAtomic(path, JSON.stringify(doc, null, 2) + "\n").catch(() => undefined);
  return doc;
}

function parseManifest(text: string, base: URL): Partial<SiteDoc> | undefined {
  try {
    const value = JSON.parse(text) as Record<string, unknown>;
    const actions = Array.isArray(value.actions)
      ? value.actions.slice(0, 100).map((item) => {
          const action = (item ?? {}) as Record<string, unknown>;
          return {
            name: String(action.name ?? "").slice(0, 120),
            ...(action.description
              ? { description: String(action.description).slice(0, 1000) }
              : {}),
            ...(action.effect ? { effect: String(action.effect).slice(0, 40) } : {}),
          };
        })
      : [];
    return {
      ...(value.version !== undefined ? { version: Number(value.version) } : {}),
      ...(value.endpoint ? { endpoint: new URL(String(value.endpoint), base).href } : {}),
      actions: actions.filter((action) => action.name),
      available: true,
    };
  } catch {
    return undefined;
  }
}

function parseMarkdown(text: string, base: URL): Partial<SiteDoc> | undefined {
  const block = /```(?:json)?\s*([\s\S]*?)```/i.exec(text)?.[1];
  return block ? parseManifest(block, base) : undefined;
}

function parseLlms(text: string, base: URL): SiteDoc["llms"] {
  const title = /^#\s+(.+)$/m.exec(text)?.[1]?.trim();
  const summary = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line && !line.startsWith("#"));
  return {
    ...(title ? { title: title.slice(0, 300) } : {}),
    ...(summary ? { summary: summary.slice(0, 2000) } : {}),
    url: new URL("/llms.txt", base).href,
  };
}

async function get(
  url: URL,
  limit: number,
  headers: Record<string, string> = {},
): Promise<{ ok: boolean; status: number; text?: string; etag?: string }> {
  const response = await fetch(url, { redirect: "manual", headers }).catch(() => undefined);
  if (!response) return { ok: false, status: 0 };
  if (response.status >= 300 && response.status < 400) {
    const location = response.headers.get("location");
    if (location && new URL(location, url).origin !== url.origin)
      return { ok: false, status: response.status };
  }
  if (response.status === 304) return { ok: false, status: 304 };
  const text = (await response.text().catch(() => "")).slice(0, limit);
  const etag = response.headers.get("etag");
  return {
    ok: response.ok,
    status: response.status,
    text,
    ...(etag ? { etag } : {}),
  };
}
