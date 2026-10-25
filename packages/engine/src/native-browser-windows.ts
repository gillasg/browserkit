// Browser windows and zoom: the few commands that belong to the browser rather than one page.
// The agent can see the window list, resize a window, close one it owns and set a tab's zoom.

export async function windowsCall(value: Record<string, unknown>): Promise<unknown> {
  if (value.windows === "list") {
    const windows = await chrome.windows.getAll({ populate: true });
    return {
      windows: windows.map((window) => ({
        windowId: window.id,
        focused: window.focused === true,
        type: window.type,
        state: window.state,
        tabs: (window.tabs ?? []).map((tab) => ({
          tabId: tab.id,
          title: tab.title,
          url: tab.url,
          active: tab.active === true,
        })),
      })),
    };
  }
  if (value.windows === "resize") {
    const windowId = Number(value.windowId);
    if (!Number.isInteger(windowId))
      throw new Error("WINDOW_ID: give a window id from browser.windows.list()");
    const width = Math.min(Math.max(Number(value.width) || 1280, 240), 7680);
    const height = Math.min(Math.max(Number(value.height) || 800, 240), 4320);
    await chrome.windows.update(windowId, { state: "normal", width, height });
    return { windowId, width, height, resized: true };
  }
  if (value.windows === "close") {
    const windowId = Number(value.windowId);
    if (!Number.isInteger(windowId))
      throw new Error("WINDOW_ID: give a window id from browser.windows.list()");
    await chrome.windows.remove(windowId);
    return { windowId, closed: true };
  }
  if (value.windows === "zoom") {
    const factor = Math.min(Math.max(Number(value.factor) || 1, 0.25), 5);
    const tabId = value.tabId === undefined ? undefined : Number(value.tabId);
    const target =
      tabId ?? (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0]?.id;
    if (target === undefined) throw new Error("ZOOM: no tab to zoom; open one first");
    await chrome.tabs.setZoom(target, factor);
    return { tabId: target, factor };
  }
  throw new Error("UNSUPPORTED");
}
