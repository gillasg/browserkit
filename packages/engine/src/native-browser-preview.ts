import { engineConfig } from "./engine-config.js";
import { withBrowserDebugger } from "./native-browser-session.js";

// Live previews of the tabs a chat's agent works in, for its chat page.
// - Split view: one preview, the tab touched last, only while that tab is not visible.
// - Thumbnails: every recently touched tab (up to four), refreshed while the agent works, with
//   the last-touched one marked, so the chat page can stack them beside the conversation.
const FRAME_MS = 1000;
const LINGER_MS = { split: 4000, thumbnails: 60_000 };
const MAX_THUMBNAILS = 4;
type SplitTab = chrome.tabs.Tab & { splitViewId?: number };
type View = "split" | "thumbnails";
interface Preview {
  tabId: number;
  lastActivity: number;
  timer: ReturnType<typeof setTimeout> | undefined;
  view: View;
}
const previews = new Map<string, Map<number, Preview>>();
const latest = new Map<string, number>();

export async function notePreviewActivity(chatId: string, tabId: number): Promise<void> {
  const view = await engineConfig.agentView(chatId).catch((): View => "split");
  const tabs = previews.get(chatId) ?? new Map<number, Preview>();
  previews.set(chatId, tabs);
  latest.set(chatId, tabId);
  const current = tabs.get(tabId);
  if (current && current.view === view) {
    current.lastActivity = Date.now();
    return;
  }
  for (const preview of [...tabs.values()])
    if (preview.view !== view || view === "split") stop(chatId, preview);
  while (tabs.size >= MAX_THUMBNAILS) {
    const oldest = [...tabs.values()].sort((a, b) => a.lastActivity - b.lastActivity)[0];
    if (oldest) stop(chatId, oldest);
  }
  const preview: Preview = { tabId, lastActivity: Date.now(), timer: undefined, view };
  tabs.set(tabId, preview);
  schedule(chatId, preview, 150);
}

function schedule(chatId: string, preview: Preview, delay: number): void {
  preview.timer = setTimeout(() => void frame(chatId, preview), delay);
}

function live(chatId: string, preview: Preview): boolean {
  return previews.get(chatId)?.get(preview.tabId) === preview;
}

async function frame(chatId: string, preview: Preview): Promise<void> {
  if (!live(chatId, preview)) return;
  if (Date.now() - preview.lastActivity > LINGER_MS[preview.view]) return stop(chatId, preview);
  const tab = (await chrome.tabs.get(preview.tabId).catch(() => undefined)) as SplitTab | undefined;
  if (!tab) return stop(chatId, preview);
  const visible = tab.active || (tab.splitViewId ?? -1) >= 0;
  if (visible && preview.view === "split") {
    publish(chatId, preview, tab, null);
    return schedule(chatId, preview, FRAME_MS);
  }
  const image = await withBrowserDebugger(preview.tabId, (debuggee) =>
    chrome.debugger.sendCommand(debuggee, "Page.captureScreenshot", {
      format: "jpeg",
      quality: 40,
      optimizeForSpeed: true,
    }),
  ).then(
    (result) => "data:image/jpeg;base64," + (result as { data: string }).data,
    () => null,
  );
  if (!live(chatId, preview)) return;
  publish(chatId, preview, tab, image);
  schedule(chatId, preview, FRAME_MS);
}

function stop(chatId: string, preview: Preview): void {
  if (preview.timer) clearTimeout(preview.timer);
  const tabs = previews.get(chatId);
  if (tabs?.get(preview.tabId) === preview) tabs.delete(preview.tabId);
  if (tabs?.size === 0) previews.delete(chatId);
  publish(chatId, preview, undefined, null);
}

function publish(
  chatId: string,
  preview: Preview,
  tab: chrome.tabs.Tab | undefined,
  image: string | null,
) {
  void chrome.runtime
    .sendMessage({
      kind: "aeon.browser.preview",
      chatId,
      tabId: preview.tabId,
      view: preview.view,
      latest: latest.get(chatId) === preview.tabId,
      title: tab?.title ?? "",
      url: tab?.url ?? "",
      image,
    })
    .catch(() => undefined);
}
