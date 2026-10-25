import { BridgeClient } from "../client.js";
import { flag, has, type Args } from "../args.js";
import { out } from "../output.js";
import type { Command } from "../usage.js";

// The browser's windows and a tab's zoom: list, resize, close, set and reset.

const SESSION = "browserkit-cli";

async function inBrowser(code: string): Promise<unknown> {
  const bridge = await BridgeClient.connect();
  try {
    const reply = await bridge.request("run", { code, session: SESSION });
    if (reply.error) throw new Error(String(reply.error));
    return reply.value;
  } finally {
    bridge.close();
  }
}

async function windows(args: Args): Promise<number> {
  const action = args.positional[0] ?? "list";
  if (action === "list") {
    const result = (await inBrowser("browser.windows.list()")) as {
      windows: {
        windowId: number;
        focused: boolean;
        state: string;
        tabs: { tabId: number; title?: string; url?: string }[];
      }[];
    };
    if (has(args, "json")) {
      out(JSON.stringify(result, null, 2));
      return 0;
    }
    for (const window of result.windows)
      out(
        `${window.windowId}\t${window.focused ? "focused" : "unfocused"}\t${window.state}\t${window.tabs.length} tab(s)`,
      );
    return 0;
  }
  if (action === "resize") {
    const windowId = Number(args.positional[1]);
    const width = Number(flag(args, "width") ?? 1280);
    const height = Number(flag(args, "height") ?? 800);
    if (!Number.isInteger(windowId))
      throw new Error("Usage: browserkit windows resize <windowId> [--width n] [--height n]");
    const result = await inBrowser(
      `browser.windows.resize(${windowId}, {width: ${Math.round(width)}, height: ${Math.round(height)}})`,
    );
    out(JSON.stringify(result));
    return 0;
  }
  if (action === "close") {
    const windowId = Number(args.positional[1]);
    if (!Number.isInteger(windowId)) throw new Error("Usage: browserkit windows close <windowId>");
    out(JSON.stringify(await inBrowser(`browser.windows.close(${windowId})`)));
    return 0;
  }
  throw new Error("Usage: browserkit windows list|resize <id>|close <id> [--json]");
}

async function zoom(args: Args): Promise<number> {
  const wanted = args.positional[0];
  if (!wanted) throw new Error("Usage: browserkit zoom <factor|reset> [--tab id]");
  const tabId = flag(args, "tab");
  const factor = wanted === "reset" ? 1 : Number(wanted);
  if (!Number.isFinite(factor) || factor < 0.25 || factor > 5)
    throw new Error("ZOOM_RANGE: a zoom factor is between 0.25 and 5 (or use reset)");
  const result = (await inBrowser(
    `browser.setZoom(${factor}${tabId ? `, ${Number(tabId)}` : ""})`,
  )) as { tabId: number; factor: number };
  if (has(args, "json")) out(JSON.stringify(result));
  else out(`Zoom ${result.factor} on tab ${result.tabId}.`);
  return 0;
}

export const windowsCommand: Command = {
  name: "windows",
  group: "Browser",
  summary: "list, resize or close browser windows",
  help: `Usage: browserkit windows list [--json]
       browserkit windows resize <windowId> [--width 1280] [--height 800]
       browserkit windows close <windowId>

Window ids come from "windows list". A window the agent opened can be resized or closed;
resizing a user window is visible, so prefer the agent's own.`,
  run: windows,
};

async function tabGroups(args: Args): Promise<number> {
  const wanted = args.positional[0] ?? "status";
  if (!["on", "off", "status"].includes(wanted))
    throw new Error("Usage: browserkit tab-groups on|off|status [--json]");
  const call =
    wanted === "status" ? "browser.tabGrouping()" : `browser.tabGrouping(${wanted === "on"})`;
  const enabled = Boolean(await inBrowser(call));
  if (has(args, "json")) out(JSON.stringify({ enabled }));
  else out(`Agent tab grouping is ${enabled ? "on" : "off"}.`);
  return 0;
}

export const tabGroupsCommand: Command = {
  name: "tab-groups",
  group: "Browser",
  summary: "show or change whether agent tabs are grouped",
  help: `Usage: browserkit tab-groups on|off|status [--json]

Tabs an agent opens are kept in one group per chat so they can be seen, collapsed or closed
together. Turning grouping off takes back every tab an agent had grouped; tabs opened later are
left alone. Only tabs the agent creates are ever grouped: a popup, a link opened from an agent
tab, or the chat tab itself stays out of the group.`,
  run: tabGroups,
};

export const zoomCommand: Command = {
  name: "zoom",
  group: "Browser",
  summary: "set or reset the zoom of a tab",
  help: `Usage: browserkit zoom <0.25-5|reset> [--tab <id>] [--json]

Without --tab, the active tab of the focused window is used. reset sets 1.`,
  run: zoom,
};
