import { boostsCall, isBoostsRequest } from "./native-browser-boosts.js";
import { forgetAgentTab } from "./native-browser-tab-cleanup.js";
import { disableQuietTab } from "./native-browser-quiet.js";
import { historyCall } from "./native-browser-history.js";
import { identityCall, isIdentityRequest } from "./native-browser-identity.js";

// The user's history and bookmarks, for questions like "that article I read last week" and for
// organizing bookmarks. Results are compact records; the code runtime gets them as plain data.
const MAX_RESULTS = 500;

type Request = Record<string, unknown>;

export function isLibraryRequest(value: Request | null): boolean {
  return Boolean(
    value &&
    (typeof value.history === "string" ||
      typeof value.bookmarks === "string" ||
      typeof value.downloads === "string" ||
      typeof value.extension === "string" ||
      value.tabs === "move" ||
      value.tabs === "keep" ||
      isIdentityRequest(value) ||
      isBoostsRequest(value)),
  );
}

export function libraryCall(value: Request): Promise<unknown> {
  if (typeof value.history === "string") return historyCall(value.history, value);
  if (isIdentityRequest(value)) return identityCall(value);
  if (typeof value.downloads === "string") return downloadsCall(value.downloads, value);
  if (typeof value.extension === "string") return extensionCall(value.extension, value.message);
  if (value.tabs === "move") return moveTabs(value);
  if (value.tabs === "keep") return keepTabs(value);
  if (isBoostsRequest(value)) return boostsCall(value);
  return bookmarksCall(String(value.bookmarks), value);
}

/** Hand agent tabs to the user: out of the agent's group, never closed by the tidy-up. */
async function keepTabs(value: Request): Promise<unknown> {
  const ids = Array.isArray(value.tabIds)
    ? value.tabIds.filter((id) => Number.isSafeInteger(id))
    : [];
  if (!ids.length) throw new Error("INVALID_TARGET: pass one or more tab ids");
  for (const id of ids as number[]) forgetAgentTab(id);
  for (const id of ids as number[]) await disableQuietTab(id);
  await chrome.tabs.ungroup(ids as [number, ...number[]]).catch(() => undefined);
  return { kept: ids };
}

/** Reorder tabs: move them, in the order given, to an index (-1 = the end) and optionally another
 * window. Pinned tabs stay among pinned tabs, as Chrome requires. */
async function moveTabs(value: Request): Promise<unknown> {
  const ids = Array.isArray(value.tabIds) ? value.tabIds : [];
  if (!ids.length || !ids.every((id) => Number.isSafeInteger(id)))
    throw new Error("INVALID_TARGET: pass one or more tab ids");
  const index = Number.isSafeInteger(value.index) ? (value.index as number) : -1;
  const windowId = Number.isSafeInteger(value.windowId) ? (value.windowId as number) : undefined;
  const moved = await chrome.tabs.move(ids as number[], {
    index,
    ...(windowId !== undefined ? { windowId } : {}),
  });
  return (Array.isArray(moved) ? moved : [moved]).map((tab) => ({
    tabId: tab.id,
    index: tab.index,
    windowId: tab.windowId,
  }));
}

/** A message to another installed extension that accepts them. */
async function extensionCall(id: string, message: unknown): Promise<unknown> {
  if (!/^[a-p]{32}$/.test(id)) throw new Error("INVALID_EXTENSION_ID: " + id);
  try {
    return await Promise.race([
      chrome.runtime.sendMessage(id, message),
      new Promise((_, reject) => setTimeout(() => reject(new Error("timed out")), 120_000)),
    ]);
  } catch (error) {
    throw new Error(
      `EXTENSION_UNAVAILABLE: ${id} is not installed or did not answer (${error instanceof Error ? error.message : String(error)})`,
    );
  }
}

// Recent downloads, so the agent can find a file the user or a page just saved.
async function downloadsCall(action: string, value: Request): Promise<unknown> {
  if (action !== "list") throw new Error("UNSUPPORTED: browser.downloads." + action);
  const items = await chrome.downloads.search({
    query: value.text ? [String(value.text)] : [],
    orderBy: ["-startTime"],
    limit: limit(value.max, 20),
  });
  return items.map((item) => ({
    downloadId: item.id,
    filename: item.filename,
    url: item.finalUrl || item.url,
    state: item.state,
    bytes: item.totalBytes,
    mime: item.mime,
    started: item.startTime,
    exists: item.exists,
  }));
}

async function bookmarksCall(action: string, value: Request): Promise<unknown> {
  const id = String(value.id ?? "");
  if (action === "search")
    return (await chrome.bookmarks.search(String(value.query ?? "")))
      .slice(0, limit(value.max, 100))
      .map(bookmark);
  if (action === "tree") return folderTree((await chrome.bookmarks.getTree())[0]);
  if (action === "children") return (await chrome.bookmarks.getChildren(id)).map(bookmark);
  if (action === "create") return bookmark(await chrome.bookmarks.create(fields(value)));
  if (action === "update") return bookmark(await chrome.bookmarks.update(id, fields(value)));
  if (action === "move")
    return bookmark(
      await chrome.bookmarks.move(id, fields(value) as { parentId?: string; index?: number }),
    );
  if (action === "remove") {
    if (value.recursive === true) await chrome.bookmarks.removeTree(id);
    else await chrome.bookmarks.remove(id);
    return { removed: id };
  }
  throw new Error("UNSUPPORTED: browser.bookmarks." + action);
}

function fields(value: Request): Record<string, string | number> {
  const picked: Record<string, string | number> = {};
  for (const key of ["parentId", "title", "url"])
    if (typeof value[key] === "string") picked[key] = value[key];
  if (typeof value.index === "number") picked.index = value.index;
  return picked;
}

function bookmark(node: chrome.bookmarks.BookmarkTreeNode) {
  return {
    id: node.id,
    title: node.title,
    ...(node.url ? { url: node.url } : { folder: true }),
    parentId: node.parentId,
  };
}

// Folders only, with how many links each holds: the full tree can be thousands of links.
function folderTree(node: chrome.bookmarks.BookmarkTreeNode | undefined): unknown {
  if (!node) return undefined;
  const children = node.children ?? [];
  return {
    id: node.id,
    title: node.title,
    links: children.filter((child) => child.url).length,
    folders: children.filter((child) => !child.url).map(folderTree),
  };
}

function limit(value: unknown, fallback: number): number {
  const number = Number(value ?? fallback);
  return Number.isFinite(number)
    ? Math.min(MAX_RESULTS, Math.max(1, Math.floor(number)))
    : fallback;
}
