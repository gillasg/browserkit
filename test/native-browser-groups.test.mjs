import assert from "node:assert/strict";
import test from "node:test";
import { configureEngine } from "../packages/engine/dist/engine-config.js";
import {
  GROUP_MODE_KEY,
  collapseAgentGroups,
  groupAgentTab,
} from "../packages/engine/dist/native-browser-groups.js";

// A tiny Chrome tab-group model: enough to prove one shared group per window, the title with the
// invisible owner marker, the per-chat mode, and that a lost in-memory map can find and rejoin
// the existing group by its marker.
const groups = new Map();
const session = new Map();
const local = new Map();
let nextGroup = 100;
globalThis.chrome = {
  storage: {
    session: {
      get: async (key) => (session.has(key) ? { [key]: session.get(key) } : {}),
      set: async (values) => {
        for (const [key, value] of Object.entries(values)) session.set(key, value);
      },
    },
    local: {
      get: async (key) => (local.has(key) ? { [key]: local.get(key) } : {}),
      set: async (values) => {
        for (const [key, value] of Object.entries(values)) local.set(key, value);
      },
    },
  },
  tabs: {
    get: async (id) => [...groups.values()].find((group) => group.tabs.includes(id)) ?? { id },
    group: async (options) => {
      if (options.groupId !== undefined) {
        const group = groups.get(options.groupId);
        if (group) group.tabs.push(...[options.tabIds].flat());
        return options.groupId;
      }
      const id = nextGroup++;
      groups.set(id, {
        id,
        windowId: options.createProperties.windowId,
        title: "",
        tabs: [options.tabIds].flat(),
      });
      return id;
    },
    query: async ({ groupId }) => (groups.get(groupId)?.tabs ?? []).map((id) => ({ id })),
  },
  tabGroups: {
    get: async (id) => groups.get(id),
    query: async ({ windowId }) =>
      [...groups.values()].filter((group) => group.windowId === windowId),
    update: async (id, patch) => {
      Object.assign(groups.get(id), patch);
      return groups.get(id);
    },
  },
};

configureEngine({ tabGroupTitle: (_owner, title) => title ?? "Agent" });

test("one shared group per window, titled by the host, with a rejoin marker", async () => {
  await groupAgentTab(1, 1, "owner-one", "Trip planning for the long weekend");
  await groupAgentTab(2, 1, "owner-two", "Dinner ideas");
  assert.equal(groups.size, 1);
  const group = [...groups.values()][0];
  // "Agent · 2" for two chats, then the invisible marker and owner key; strip both.
  const [visible, marker] = group.title.split("\u2063");
  assert.equal(visible.replace(/\s*·\s*\d+$/, ""), "Agent");
  assert.equal(marker, "shared--");
  assert.equal(group.color, group.color.toLowerCase());

  // A new window gets its own group; the first window still has exactly one.
  await groupAgentTab(3, 2, "owner-one", "Trip planning for the long weekend");
  assert.equal(groups.size, 2);
  await collapseAgentGroups("owner-one");
  assert.ok([...groups.values()].every((item) => item.collapsed === true));
});

test("the per-chat mode groups each chat separately, under its title", async () => {
  local.set(GROUP_MODE_KEY, "chat");
  await groupAgentTab(4, 3, "owner-three", "Trip planning for the long weekend");
  await groupAgentTab(5, 3, "owner-four", "Dinner ideas");
  const window = [...groups.values()].filter((item) => item.windowId === 3);
  assert.equal(window.length, 2);
  assert.ok(window.some((item) => item.title.startsWith("Trip planning for the l")));
  assert.ok(window.some((item) => item.title.startsWith("Dinner ideas")));
  local.delete(GROUP_MODE_KEY);
});

test("a lost owner map rejoins the existing group by the title marker", async () => {
  await groupAgentTab(6, 4, "owner-one", "Trip planning for the long weekend");
  const before = groups.size;
  session.clear();
  const fresh = await import("../packages/engine/dist/native-browser-groups.js?lost-map");
  await fresh.groupAgentTab(7, 4, "owner-one", "Trip planning for the long weekend");
  assert.equal(groups.size, before, "no extra group was created");
  assert.equal([...groups.values()].filter((group) => group.windowId === 4).length, 1);
});
