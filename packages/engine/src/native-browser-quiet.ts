import { onEngineInstall } from "./native-engine-install.js";
import { noteInjectedScript } from "./stealth.js";
import { nativeSourcePreamble } from "./native-source.js";
import { onBrowserDebuggerAttached } from "./native-browser-session.js";

// Quiet tabs are for unattended reading (explore, jobs, crawls): no popunders in front of the
// user, no autoplaying audio, and the common ad/tracker hosts blocked before they load. The
// rules are per-tab and live in the engine's own DNR range; closing the tab releases them.
const RULE_BASE = 600_000;
const RULE_SPAN = 90_000;
const quiet = new Set<number>();
const loaderIds = new Map<number, string>();
const ruleIds = new Map<number, number[]>();
let nextRule = 0;

const AD_HOSTS = [
  "2mdn.net",
  "adnxs.com",
  "adsrvr.org",
  "amazon-adsystem.com",
  "amplitude.com",
  "bidswitch.net",
  "bluekai.com",
  "casalemedia.com",
  "clarity.ms",
  "connect.facebook.net",
  "criteo.com",
  "demdex.net",
  "doubleclick.net",
  "everesttech.net",
  "facebook.net",
  "fullstory.com",
  "google-analytics.com",
  "googleadservices.com",
  "googlesyndication.com",
  "googletagmanager.com",
  "hotjar.com",
  "media.net",
  "mixpanel.com",
  "moatads.com",
  "openx.net",
  "outbrain.com",
  "pubmatic.com",
  "quantserve.com",
  "rubiconproject.com",
  "scorecardresearch.com",
  "segment.io",
  "sharethrough.com",
  "smartadserver.com",
  "spotxchange.com",
  "taboola.com",
  "teads.tv",
  "yieldmo.com",
  "zedo.com",
];
const ALL_TYPES = [
  "main_frame",
  "sub_frame",
  "xmlhttprequest",
  "script",
  "image",
  "media",
  "font",
  "stylesheet",
  "websocket",
  "ping",
  "csp_report",
  "object",
  "webtransport",
  "webbundle",
  "other",
] as chrome.declarativeNetRequest.ResourceType[];

const QUIET_SCRIPT = `(() => {
  ${nativeSourcePreamble}
  const realOpen = window.open;
  const open = function () { return null; };
  __keepNative(open, realOpen);
  window.open = open;
  const realPlay = HTMLMediaElement.prototype.play;
  const play = function () {
    try { this.autoplay = false; this.muted = true; this.pause(); } catch {}
    return Promise.resolve();
  };
  __keepNative(play, realPlay);
  HTMLMediaElement.prototype.play = play;
  const quiet = () => {
    for (const media of document.querySelectorAll('video,audio')) {
      try { media.autoplay = false; media.muted = true; media.pause(); } catch {}
    }
  };
  const watch = () => {
    quiet();
    new MutationObserver(quiet).observe(document.documentElement, { childList: true, subtree: true });
  };
  if (document.documentElement) watch();
  else document.addEventListener('DOMContentLoaded', watch, { once: true });
  quiet();
})();`;

const QUIET_SWEEP = `(() => {
  for (const media of document.querySelectorAll('video,audio')) {
    try { media.autoplay = false; media.muted = true; media.pause(); } catch {}
  }
})()`;

export async function enableQuietTab(tabId: number): Promise<void> {
  if (quiet.has(tabId)) return;
  quiet.add(tabId);
  noteInjectedScript(tabId, "quiet tab: popups blocked, media muted, ads filtered");
  await addRules(tabId);
}

export async function disableQuietTab(tabId: number): Promise<void> {
  quiet.delete(tabId);
  loaderIds.delete(tabId);
  const ids = ruleIds.get(tabId) ?? [];
  ruleIds.delete(tabId);
  if (ids.length)
    await chrome.declarativeNetRequest
      .updateSessionRules({ removeRuleIds: ids })
      .catch(() => undefined);
}

export function isQuietTab(tabId: number): boolean {
  return quiet.has(tabId);
}

async function addRules(tabId: number): Promise<void> {
  if (ruleIds.has(tabId)) return;
  const ids = [RULE_BASE + (nextRule++ % RULE_SPAN)];
  ruleIds.set(tabId, ids);
  await chrome.declarativeNetRequest
    .updateSessionRules({
      addRules: [
        {
          id: ids[0] as number,
          priority: 2,
          action: { type: "block" as chrome.declarativeNetRequest.RuleActionType },
          condition: {
            requestDomains: AD_HOSTS,
            resourceTypes: ALL_TYPES,
            tabIds: [tabId],
          },
        },
      ],
    })
    .catch(() => undefined);
}

async function onQuietAttach(tabId: number): Promise<void> {
  await chrome.debugger
    .sendCommand({ tabId }, "Page.addScriptToEvaluateOnNewDocument", { source: QUIET_SCRIPT })
    .catch(() => undefined);
  const tree = (await chrome.debugger
    .sendCommand({ tabId }, "Page.getFrameTree", {})
    .catch(() => undefined)) as { frameTree?: { frame?: { loaderId?: string } } } | undefined;
  const loader = tree?.frameTree?.frame?.loaderId;
  const expression = loader && loaderIds.get(tabId) === loader ? QUIET_SWEEP : QUIET_SCRIPT;
  if (loader) loaderIds.set(tabId, loader);
  await chrome.debugger
    .sendCommand({ tabId }, "Runtime.evaluate", { expression, awaitPromise: false })
    .catch(() => undefined);
}

onEngineInstall(() => {
  onBrowserDebuggerAttached((tabId) => {
    if (quiet.has(tabId)) return onQuietAttach(tabId);
  });
  chrome.debugger.onEvent.addListener((source, method, params) => {
    if (source.tabId === undefined || !quiet.has(source.tabId)) return;
    if (method !== "Page.frameNavigated") return;
    const frame = (params as { frame?: { loaderId?: string; parentId?: string } }).frame;
    if (frame?.loaderId && !frame.parentId) loaderIds.set(source.tabId, frame.loaderId);
  });
  chrome.tabs.onRemoved.addListener((tabId) => {
    quiet.delete(tabId);
    loaderIds.delete(tabId);
    const ids = ruleIds.get(tabId) ?? [];
    ruleIds.delete(tabId);
    if (ids.length)
      void chrome.declarativeNetRequest
        .updateSessionRules({ removeRuleIds: ids })
        .catch(() => undefined);
  });
});
