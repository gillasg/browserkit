import { agentTabGroupingEnabled, setAgentTabGrouping } from "./native-browser-groups.js";

// browser.settings(): read or change how agents look and run in this browser, when the user asks
// ("always use split view", "close idle tabs after half an hour"). Presentation and run settings
// only: blocked sites, the password manager and keys are never here. The engine registers its
// own; a host adds its own with registerSetting (a later registration of a name replaces it).

export interface EngineSetting {
  about: string;
  values?: unknown[];
  read(): Promise<unknown>;
  write(value: unknown): Promise<void>;
}
const settings = new Map<string, EngineSetting>();

export function registerSetting(name: string, setting: EngineSetting): void {
  settings.set(name, setting);
}

export async function settingsCall(value: Record<string, unknown>): Promise<unknown> {
  const changes = value.settings === "set" ? (value.values as Record<string, unknown>) : {};
  for (const [name, wanted] of Object.entries(changes ?? {})) {
    const setting = settings.get(name);
    if (!setting)
      throw new Error(`UNKNOWN_SETTING: ${name}; known: ${[...settings.keys()].join(", ")}`);
    if (setting.values && !setting.values.includes(wanted))
      throw new Error(
        `INVALID_SETTING: ${name} takes ${setting.values.map((v) => JSON.stringify(v)).join(" | ")}`,
      );
    await setting.write(wanted);
  }
  const all: Record<string, unknown> = {};
  for (const [name, setting] of settings)
    all[name] = {
      value: await setting.read(),
      about: setting.about,
      ...(setting.values ? { values: setting.values } : {}),
    };
  return all;
}

function stored<T>(key: string, fallback: T): EngineSetting["read"] {
  return async () => {
    const all = (await chrome.storage.local.get(key).catch(() => ({}))) as Record<string, unknown>;
    return all[key] ?? fallback;
  };
}
function store(key: string): EngineSetting["write"] {
  return (value) => chrome.storage.local.set({ [key]: value });
}

export const IDLE_TAB_MINUTES_KEY = "browserkit-idle-tab-minutes";
export const HIDE_CURSOR_KEY = "browserkit-hide-agent-cursor";

registerSetting("tabGroups", {
  about:
    "Group the tabs an agent opens (one collapsed group per chat or session, at the start of the tab strip)",
  values: [true, false],
  read: agentTabGroupingEnabled,
  write: async (value) => {
    await setAgentTabGrouping(value === true);
  },
});
registerSetting("idleTabMinutes", {
  about: "Close agent tabs nobody touched for this many minutes (0: never)",
  values: [10, 30, 60, 0],
  read: stored(IDLE_TAB_MINUTES_KEY, 10),
  write: store(IDLE_TAB_MINUTES_KEY),
});
registerSetting("cursor", {
  about: "Show the agent's cursor and caption on the pages it works on",
  values: ["shown", "hidden"],
  read: async () => ((await stored(HIDE_CURSOR_KEY, false)()) === true ? "hidden" : "shown"),
  write: (value) => chrome.storage.local.set({ [HIDE_CURSOR_KEY]: value === "hidden" }),
});
