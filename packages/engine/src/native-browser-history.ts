// The user's history: search it, page through all of it, and rank the sites and sections they use
// most ("my most visited subreddits", "the docs I keep opening"). Visit counts are Chrome's
// per-URL totals, so a page first seen inside the window still carries its older visits.
const PAGE = 5000;
const MAX_SEARCH = 5000;
const MAX_SCAN = 200_000;

type Request = Record<string, unknown>;
type Item = chrome.history.HistoryItem;

export async function historyCall(action: string, value: Request): Promise<unknown> {
  if (action === "search") return (await search(value)).map(record);
  if (action === "top") return top(value);
  throw new Error("UNSUPPORTED: browser.history." + action);
}

function startTime(value: Request, fallbackDays: number): number {
  const days = Math.min(3650, Math.max(0, Number(value.days ?? fallbackDays)));
  return days ? Date.now() - days * 86_400_000 : 0;
}

function timeOf(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const time = typeof value === "number" ? value : Date.parse(String(value));
  return Number.isFinite(time) ? time : undefined;
}

/** Newest first. `before` (an ISO time or ms, usually the last item's lastVisit) pages backwards. */
function search(value: Request): Promise<Item[]> {
  const before = timeOf(value.before);
  return chrome.history.search({
    text: String(value.text ?? ""),
    startTime: startTime(value, 30),
    ...(before !== undefined ? { endTime: before - 1 } : {}),
    maxResults: count(value.max, 50, MAX_SEARCH),
  });
}

function record(item: Item) {
  return {
    url: item.url,
    title: item.title,
    lastVisit: item.lastVisitTime ? new Date(item.lastVisitTime).toISOString() : undefined,
    visits: item.visitCount,
  };
}

/** Every item in the window, paged by end time, up to MAX_SCAN. */
async function scanAll(
  text: string,
  start: number,
): Promise<{ items: Item[]; truncated: boolean }> {
  const items: Item[] = [];
  let end = Date.now() + 1;
  while (items.length < MAX_SCAN) {
    const page = await chrome.history.search({
      text,
      startTime: start,
      endTime: end,
      maxResults: PAGE,
    });
    items.push(...page);
    const oldest = page.at(-1)?.lastVisitTime;
    if (page.length < PAGE || !oldest || oldest >= end) return { items, truncated: false };
    end = oldest;
  }
  return { items, truncated: true };
}

/** The group an URL belongs to: its site (host without www.) or the site plus its first path parts. */
function groupKey(url: string, by: string, depth: number): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  if (!/^https?:$/.test(parsed.protocol)) return undefined;
  const host = parsed.hostname.replace(/^www\./, "");
  if (by !== "path") return host;
  const parts = parsed.pathname.split("/").filter(Boolean).slice(0, depth);
  return [host, ...parts].join("/");
}

type Group = { key: string; visits: number; pages: number; last: number; best?: Item };

function addTo(groups: Map<string, Group>, key: string, item: Item): void {
  const group = groups.get(key) ?? { key, visits: 0, pages: 0, last: 0 };
  group.visits += item.visitCount ?? 0;
  group.pages += 1;
  group.last = Math.max(group.last, item.lastVisitTime ?? 0);
  if (!group.best || (item.visitCount ?? 0) > (group.best.visitCount ?? 0)) group.best = item;
  groups.set(key, group);
}

function matches(item: Item, match: string): boolean {
  if (!match) return true;
  return `${item.url ?? ""} ${item.title ?? ""}`.toLowerCase().includes(match);
}

/** Rank sites or site sections: {by: 'site'|'path', match, days, depth, max, sort: 'visits'|'recent'}. */
async function top(value: Request): Promise<unknown> {
  const by = value.by === "path" ? "path" : "site";
  const depth = count(value.depth, 2, 6);
  const match = String(value.match ?? "").toLowerCase();
  const { items, truncated } = await scanAll(String(value.text ?? ""), startTime(value, 90));
  const groups = new Map<string, Group>();
  for (const item of items) {
    const key = item.url && matches(item, match) ? groupKey(item.url, by, depth) : undefined;
    if (key) addTo(groups, key, item);
  }
  const recent = value.sort === "recent";
  const ranked = [...groups.values()].sort((a, b) =>
    recent ? b.last - a.last : b.visits - a.visits || b.last - a.last,
  );
  return {
    by,
    scanned: items.length,
    ...(truncated ? { truncated: true } : {}),
    groups: ranked.slice(0, count(value.max, 25, 1000)).map((group) => ({
      key: group.key,
      visits: group.visits,
      pages: group.pages,
      lastVisit: group.last ? new Date(group.last).toISOString() : undefined,
      top: group.best ? { url: group.best.url, title: group.best.title } : undefined,
    })),
  };
}

function count(value: unknown, fallback: number, max: number): number {
  const number = Number(value ?? fallback);
  return Number.isFinite(number) ? Math.min(max, Math.max(1, Math.floor(number))) : fallback;
}
