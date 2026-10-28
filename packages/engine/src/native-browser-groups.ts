import { engineConfig } from "./engine-config.js";
import { ownerTitle as storedOwnerTitle } from "./native-browser-owner.js";
import { onEngineInstall } from "./native-engine-install.js";
import { settleAgentGroups } from "./native-browser-group-placement.js";

// Tabs an agent opens are kept together in one tab group per chat, per window, so the user can
// see, collapse or close an agent's work at once. Grouping is presentation only: it never fails a
// step. The owner-group map is persisted in session storage because the MV3 worker sleeps; when
// it is gone, the invisible owner marker in the group title lets a later tab rejoin its group
// instead of making one more "Aeon" group.
//
// Only a tab the agent asked for (openTab, a job's own tab) belongs in the group. Chrome copies a
// group on its own in places we do not control (a link from a grouped tab, window.open, a new tab
// opened while a grouped one is in front), so every new tab is checked once it settles: a tab in
// an agent group that no agent step claimed is taken back out. A user's own groups are never
// touched.
const COLORS = [
  "blue",
  "purple",
  "cyan",
  "green",
  "orange",
  "pink",
  "yellow",
  "red",
  "grey",
] as const;
type Color = (typeof COLORS)[number];
interface GroupRecord {
  windowId: number;
  groupId: number;
  title: string;
  color: Color;
}
const STORAGE_KEY = "browserkit-agent-groups";
const SETTING_KEY = "browserkit-agent-tab-groups";
const MARK = "\u2063";
const MAX_TITLE = 24;
const groups = new Map<string, Map<number, GroupRecord>>();
// Tabs an agent step explicitly put in its group. Anything else found in an agent group is an
// intruder (a popup or a link that inherited the group) and is taken back out.
const claimed = new Set<number>();
let groupingSetting: boolean | undefined;
// Tabs opened together (Promise.all) would each see "no group yet" and make their own; grouping
// for one owner runs in order so the first creates the group and the rest join it.
const pending = new Map<string, Promise<void>>();
let restored: Promise<void> | undefined;
let ready = false;
export const AGENT_TAB_GROUPS_SETTING = SETTING_KEY;

export function groupAgentTab(
  tabId: number,
  windowId: number,
  owner: string,
  ownerTitle?: string,
): Promise<void> {
  if (engineConfig.tabGroups !== true) return Promise.resolve();
  const run = (pending.get(owner) ?? Promise.resolve()).then(async () => {
    if (!(await agentTabGroupingEnabled())) return;
    await restore();
    claimed.add(tabId);
    const prior = groups.get(owner)?.get(windowId)?.title;
    const inherited = prior?.includes(MARK) ? prior.slice(0, prior.indexOf(MARK)) : prior;
    await joinGroup(tabId, windowId, owner, ownerTitle ?? storedOwnerTitle(owner) ?? inherited);
  });
  pending.set(owner, run);
  void run.finally(() => {
    if (pending.get(owner) === run) pending.delete(owner);
  });
  return run;
}

/** A tab the agent created and will group: claim it before Chrome can inherit a group. */
export function claimAgentTab(tabId: number): void {
  claimed.add(tabId);
}

/**
 * Takes a tab back out of an agent group when no agent step claimed it. Checks right away and
 * once after the group has had time to appear; a tab the user dragged somewhere later is not
 * watched, so their own grouping stays as they left it.
 */
export async function ungroupAgentIntruder(tabId: number): Promise<void> {
  if (claimed.has(tabId)) return;
  await restore();
  for (const delay of [0, 75, 250]) {
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
    const tab = await chrome.tabs.get(tabId).catch(() => undefined);
    if (!tab) return;
    if (claimed.has(tabId)) return;
    if (tab.groupId === undefined || tab.groupId < 0) continue;
    if (isAgentGroupId(tab.groupId)) await chrome.tabs.ungroup(tabId).catch(() => undefined);
  }
}

/** Whether agent tab grouping is on: the host's setting, plus the user's stored switch. */
export async function agentTabGroupingEnabled(): Promise<boolean> {
  if (engineConfig.tabGroups !== true) return false;
  if (groupingSetting === undefined)
    groupingSetting = await chrome.storage?.local
      ?.get(SETTING_KEY)
      .then((stored) => stored[SETTING_KEY] !== false)
      .catch(() => true);
  return groupingSetting !== false;
}

/** The user's switch. Turning it off takes back every tab an agent had grouped. */
export async function setAgentTabGrouping(enabled: boolean): Promise<boolean> {
  groupingSetting = enabled;
  await chrome.storage?.local?.set({ [SETTING_KEY]: enabled }).catch(() => undefined);
  if (!enabled) await releaseAgentGroups();
  return enabled;
}

async function releaseAgentGroups(): Promise<void> {
  await restore();
  for (const byWindow of groups.values()) {
    for (const record of [...byWindow.values()]) {
      const tabs = await chrome.tabs.query({ groupId: record.groupId }).catch(() => []);
      for (const tab of tabs)
        if (tab.id !== undefined) await chrome.tabs.ungroup(tab.id).catch(() => undefined);
      byWindow.delete(record.windowId);
    }
  }
  claimed.clear();
  await save();
}

async function joinGroup(
  tabId: number,
  windowId: number,
  owner: string,
  ownerTitle: string | undefined,
): Promise<void> {
  try {
    const title = groupTitle(owner, ownerTitle);
    const existing = await reusableGroup(owner, windowId, title);
    const groupId = await chrome.tabs.group(
      existing === undefined
        ? { tabIds: tabId, createProperties: { windowId } }
        : { tabIds: tabId, groupId: existing },
    );
    claimed.add(tabId);
    const record: GroupRecord = {
      windowId,
      groupId,
      title,
      color: COLORS[hash(owner) % COLORS.length] ?? "blue",
    };
    setRecord(owner, record);
    await chrome.tabGroups.update(groupId, { title, color: record.color });
    await save();
    await settleAgentGroups(windowId);
  } catch {
    // A dragged-out tab, a closed window or a browser without groups: leave the tab ungrouped.
  }
}

async function reusableGroup(
  owner: string,
  windowId: number,
  title: string,
): Promise<number | undefined> {
  const grouped = groups.get(owner)?.get(windowId);
  if (grouped && (await chrome.tabGroups.get(grouped.groupId).catch(() => undefined))) {
    return grouped.groupId;
  }
  if (grouped) groups.get(owner)?.delete(windowId);
  // The map may be gone: find the group by the marker every title carries.
  const match = await findGroup(owner, windowId, title);
  if (match === undefined) return undefined;
  setRecord(owner, { windowId, groupId: match, title, color: colorFor(owner) });
  return match;
}

async function findGroup(
  owner: string,
  windowId: number,
  title: string,
): Promise<number | undefined> {
  if (typeof chrome.tabGroups.query !== "function") return undefined;
  const mark = marker(owner);
  if (!mark) return undefined;
  const legacy = title.slice(0, title.indexOf(MARK));
  const all = await chrome.tabGroups.query({ windowId }).catch(() => []);
  return all.find((group) => group.title?.endsWith(mark) || group.title === legacy)?.id;
}

function setRecord(owner: string, record: GroupRecord): void {
  let byWindow = groups.get(owner);
  if (!byWindow) groups.set(owner, (byWindow = new Map()));
  byWindow.set(record.windowId, record);
}

function groupTitle(owner: string, ownerTitle: string | undefined): string {
  const configured = engineConfig.tabGroupTitle(owner, ownerTitle);
  const visible = configured.replace(/\s+/g, " ").trim() || "Agent";
  const short = visible.length > MAX_TITLE ? visible.slice(0, MAX_TITLE - 1) + "." : visible;
  return short + MARK + owner.slice(0, 8);
}

function marker(owner: string): string | undefined {
  return MARK + owner.slice(0, 8);
}
function colorFor(owner: string): Color {
  return COLORS[hash(owner) % COLORS.length] ?? "blue";
}

/** After a run: keep its tabs but get the group out of the way. */
export async function collapseAgentGroups(owner: string): Promise<void> {
  await restore();
  const byWindow = groups.get(owner);
  if (!byWindow) return;
  for (const record of [...byWindow.values()]) {
    const updated = await chrome.tabGroups
      .update(record.groupId, { collapsed: true })
      .catch(() => undefined);
    if (!updated) byWindow.delete(record.windowId);
  }
  await pruneEmptyGroups();
  await save();
}

/** An empty agent group is not useful to anyone: drop its record (Chrome removes the group). */
export async function pruneEmptyGroups(): Promise<void> {
  if (typeof chrome.tabs?.query !== "function") return;
  for (const [owner, byWindow] of groups) {
    for (const [windowId, record] of [...byWindow]) {
      const tabs = await chrome.tabs.query({ groupId: record.groupId }).catch(() => undefined);
      if (tabs === undefined) continue;
      if (tabs.length === 0) byWindow.delete(windowId);
    }
    if (byWindow.size === 0) groups.delete(owner);
  }
  await save();
}

/** browser.tabGrouping(): read or change whether agent tabs are grouped. */
export async function tabGroupsCall(value: Record<string, unknown>): Promise<{ enabled: boolean }> {
  if (value.tabGroups === "get") return { enabled: await agentTabGroupingEnabled() };
  if (value.tabGroups === "set")
    return { enabled: await setAgentTabGrouping(value.enabled === true) };
  throw new Error("UNSUPPORTED");
}

/** Every tab group that belongs to an agent session. */
export function agentGroupIds(): number[] {
  return [...groups.values()].flatMap((byWindow) =>
    [...byWindow.values()].map((record) => record.groupId),
  );
}

/** Whether a Chrome tab group belongs to an agent session. */
export function isAgentGroupId(groupId: number): boolean {
  return [...groups.values()].some((byWindow) =>
    [...byWindow.values()].some((record) => record.groupId === groupId),
  );
}

/** Whether the persisted owner-group map has loaded (so an unknown group is not just missing). */
export function agentGroupsReady(): boolean {
  return ready;
}

function restore(): Promise<void> {
  restored ??= read().then((records) => {
    for (const record of records) setRecord(record.owner, record);
    ready = true;
  });
  return restored;
}

async function read(): Promise<(GroupRecord & { owner: string })[]> {
  if (!chrome.storage?.session) return [];
  const all = (await chrome.storage.session.get(STORAGE_KEY).catch(() => ({}))) as Record<
    string,
    unknown
  >;
  const stored = all[STORAGE_KEY];
  if (!Array.isArray(stored)) return [];
  return stored.filter(
    (item): item is GroupRecord & { owner: string } =>
      typeof item?.owner === "string" &&
      Number.isSafeInteger(item.windowId) &&
      Number.isSafeInteger(item.groupId) &&
      typeof item.title === "string" &&
      COLORS.includes(item.color),
  );
}

let writing = Promise.resolve();
function save(): Promise<void> {
  if (!chrome.storage?.session) return Promise.resolve();
  const records = [...groups].flatMap(([owner, byWindow]) =>
    [...byWindow.values()].map((record) => ({ owner, ...record })),
  );
  writing = writing
    .catch(() => undefined)
    .then(() => chrome.storage.session.set({ [STORAGE_KEY]: records }))
    .catch(() => undefined);
  return writing;
}

function hash(text: string): number {
  let value = 0;
  for (const char of text) value = (value * 31 + char.charCodeAt(0)) >>> 0;
  return value;
}

onEngineInstall(() => {
  void restore();
  chrome.storage?.onChanged?.addListener((change, area) => {
    if (area === "local" && change[SETTING_KEY])
      groupingSetting = change[SETTING_KEY].newValue !== false;
  });
  chrome.tabGroups?.onRemoved?.addListener((group) => {
    for (const byWindow of groups.values())
      for (const [windowId, record] of byWindow)
        if (record.groupId === group.id) byWindow.delete(windowId);
    void save();
  });
  chrome.tabs.onRemoved.addListener((tabId) => {
    if (claimed.delete(tabId)) void save();
  });
});
