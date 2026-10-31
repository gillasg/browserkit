// What browser code may ask for besides steps, as declared kernel effects (see kernel.ts): each
// says which tab and which site it reaches, and the kernel authorizes and guards them before it
// runs. Anything no effect claims goes to Core.
import { isObject, type Effect } from "./kernel.js";
import type { Cell } from "./code-runtime-host.js";
import { jobs, saveJobs } from "./code-runtime-jobs.js";
import { jobCall, cancelJobs } from "./code-runtime-job-control.js";
import { toOffscreen } from "./code-offscreen-host.js";
import { notePreviewActivity } from "./native-browser-preview.js";
import { fillCodeOnPage, signInToPage } from "./native-browser-signin.js";
import { fillProfileOnPage } from "./native-browser-profile.js";
import { sessionHeadersFor } from "./native-browser-session-headers.js";
import { resetChatTabs, reapChatPopups } from "./native-browser-tab-cleanup.js";
import { disableQuietTab, enableQuietTab } from "./native-browser-quiet.js";
import { networkCall } from "./native-browser-network.js";
import { mediaCall, type MediaRequest } from "./native-browser-media.js";
import { isLibraryRequest, libraryCall } from "./native-browser-library.js";
import { windowsCall } from "./native-browser-windows.js";
import { tabGroupsCall } from "./native-browser-groups.js";
import { recordingCall } from "./native-browser-recording.js";
import { settingsCall } from "./native-browser-settings.js";
import { closeTabCall } from "./code-tab-close.js";
import { rulesCall } from "./native-browser-rules.js";
import { permissionCall } from "./native-browser-permissions.js";
import { googleCall } from "./native-browser-google.js";
import { fetchCall, isFetchRequest } from "./native-browser-fetch.js";

type Value = Record<string, unknown>;

/** What the effects need from the cell host. */
export interface EffectHost {
  callCore(cell: Cell, request: unknown): Promise<unknown>;
  handoff(cell: Cell, request: object): Promise<unknown>;
}

const has = (key: string) => (value: Value) => isObject(value[key]);
const named =
  (key: string, ...names: string[]) =>
  (value: Value) =>
    names.length ? names.includes(value[key] as string) : typeof value[key] === "string";
const inner = (key: string) => (value: Value) => (value[key] as { target?: unknown }).target;
const target = (value: Value) => value.target;

function secretEffects(host: EffectHost): Effect<Cell>[] {
  return [
    {
      name: "secret.forbidden",
      // Passwords, codes and profile values travel only between the machine and the engine.
      match: (value) => "credential" in value || value.profile === "values",
      run: async (_, value) => {
        throw new Error(
          "credential" in value
            ? "FORBIDDEN: use bu.signIn() to sign in"
            : "FORBIDDEN: use bu.fillProfile() to fill a form",
        );
      },
    },
    {
      name: "secret.signIn",
      match: has("signIn"),
      tab: inner("signIn"),
      run: (cell, value, tabId = 0) => {
        void notePreviewActivity(cell.run.chatId, tabId);
        const account = (value.signIn as { account?: unknown }).account;
        return signInToPage(tabId, { account }, (ask) => host.callCore(cell, ask));
      },
    },
    {
      name: "secret.fill",
      match: (value) => isObject(value.fillCode) || isObject(value.fillProfile),
      tab: (value) => ((value.fillCode ?? value.fillProfile) as { target?: unknown }).target,
      run: (cell, value, tabId = 0): Promise<unknown> => {
        const request = (value.fillCode ?? value.fillProfile) as {
          waitMs?: unknown;
          fields?: unknown;
        };
        return value.fillCode
          ? fillCodeOnPage(tabId, request)
          : fillProfileOnPage(tabId, request, (ask) => host.callCore(cell, ask));
      },
    },
  ];
}

function webEffects(host: EffectHost): Effect<Cell>[] {
  return [
    {
      name: "net.sessionHeaders",
      match: has("sessionHeaders"),
      run: async (_, value) => ({
        headers: sessionHeadersFor(String((value.sessionHeaders as { url?: unknown }).url ?? "")),
      }),
    },
    {
      name: "net.fetch",
      match: (value) => isFetchRequest(value),
      site: (value) => (value.fetch as { url?: unknown }).url,
      run: (_, value) => fetchCall(value),
    },
    {
      name: "site.call",
      match: named("siteMapper"),
      site: (value) => value.site,
      run: (cell, value) => host.callCore(cell, value),
    },
    {
      name: "net.google",
      match: named("google"),
      site: () => "https://www.google.com/",
      run: (_, value) => googleCall(value),
    },
  ];
}

function tabEffects(host: EffectHost): Effect<Cell>[] {
  return [
    {
      name: "page.media",
      match: has("media"),
      tab: inner("media"),
      run: (_, value, tabId = 0) => mediaCall(tabId, value.media as MediaRequest),
    },
    {
      name: "user.handoff",
      match: has("handoff"),
      tab: inner("handoff"),
      run: (cell, value) => host.handoff(cell, value.handoff as object),
    },
    {
      name: "tab.quiet",
      match: has("quiet"),
      tab: inner("quiet"),
      run: (_, value, tabId = 0) => quietCall(tabId, value.quiet as { enabled?: unknown }),
    },
    {
      name: "page.recording",
      match: named("recording"),
      tab: target,
      run: (_, value, tabId = 0) => recordingCall(tabId, value),
    },
    {
      name: "net.capture",
      match: named("network"),
      tab: target,
      run: (_, value, tabId = 0) => networkCall(tabId, value.network as string, value),
    },
    {
      name: "net.rules",
      match: named("rules"),
      tab: target,
      run: (_, value, tabId = 0) => rulesCall(tabId, value),
    },
    {
      name: "page.permission",
      match: named("permission", "set"),
      tab: target,
      run: (_, value, tabId = 0) => permissionCall(tabId, value),
    },
  ];
}

function browserEffects(host: EffectHost): Effect<Cell>[] {
  return [
    {
      name: "browser.info",
      match: (value) => value.browserInfo === true,
      run: async (cell) => ({ clientInstanceIds: [cell.identity.clientInstanceId] }),
    },
    {
      name: "job.start",
      match: has("job"),
      run: (cell, value) => jobCall(cell, value.job as Value),
    },
    {
      name: "job.progress",
      match: has("progress"),
      run: (cell, value) => progressCall(host, cell, value),
    },
    {
      name: "tab.reset",
      match: (value) => value.tabs === "reset" || value.session === "close",
      run: (cell) => resetCall(cell),
    },
    {
      name: "tab.reap",
      match: named("session", "reap"),
      run: (cell) => reapChatPopups(cell.run.chatId).then((closed) => ({ closed })),
    },
    {
      name: "tab.close",
      match: named("tabs", "close"),
      run: (cell, value) => closeTabCall(cell.run.chatId, value),
    },
    {
      name: "browser.settings",
      match: named("settings", "get", "set"),
      run: (_, value) => settingsCall(value),
    },
    {
      name: "extension.reload",
      // browserkit update: reload the extension once this answer is on its way.
      match: named("extension", "reload"),
      run: async () => {
        setTimeout(() => chrome.runtime.reload(), 300);
        return { reloading: true };
      },
    },
    { name: "browser.windows", match: named("windows"), run: (_, value) => windowsCall(value) },
    {
      name: "browser.tabGroups",
      match: named("tabGroups"),
      run: (_, value) => tabGroupsCall(value),
    },
    {
      name: "browser.library",
      match: (value) => isLibraryRequest(value),
      run: (_, value) => libraryCall(value),
    },
  ];
}

/** Every effect a cell can ask for, secrets first so nothing else can claim a secret request. */
export function cellEffects(host: EffectHost): Effect<Cell>[] {
  return [
    ...secretEffects(host),
    ...webEffects(host),
    ...tabEffects(host),
    ...browserEffects(host),
  ];
}

async function progressCall(host: EffectHost, cell: Cell, value: Value): Promise<unknown> {
  const job = jobs.get(cell.run.cellId);
  if (job !== cell) return host.callCore(cell, value);
  const progress = value.progress as { done?: unknown; total?: unknown; label?: unknown };
  job.progress = {
    done: Math.max(0, Number(progress.done) || 0),
    total: Math.max(0, Number(progress.total) || 0),
    ...(typeof progress.label === "string" ? { label: progress.label.slice(0, 200) } : {}),
  };
  void saveJobs();
  return { ok: true };
}

async function quietCall(tabId: number, request: { enabled?: unknown }): Promise<unknown> {
  const enabled = request.enabled !== false;
  if (enabled) await enableQuietTab(tabId);
  else await disableQuietTab(tabId);
  return { quiet: enabled };
}

async function resetCall(cell: Cell): Promise<unknown> {
  cancelJobs(cell.run.chatId);
  await toOffscreen({
    target: "aeon-code-offscreen",
    kind: "stopJobs",
    chatId: cell.run.chatId,
  }).catch(() => undefined);
  return resetChatTabs(cell.run.chatId);
}
