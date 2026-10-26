import { onEngineInstall } from "./native-engine-install.js";
import { noteInjectedScript } from "./stealth.js";
import { nativeSourcePreamble } from "./native-source.js";

// Quiet tabs are for unattended reading (explore, jobs, crawls): no popunders in front of the
// user, no autoplaying audio, and the common ad/tracker hosts blocked before they load. The
// rules are per-tab and live in the engine's own DNR range; closing the tab releases them.
const RULE_BASE = 600_000;
const RULE_SPAN = 90_000;
const quiet = new Set<number>();
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

export async function enableQuietTab(tabId: number): Promise<void> {
  if (quiet.has(tabId)) return;
  quiet.add(tabId);
  noteInjectedScript(tabId, "quiet tab: popups blocked, media muted, ads filtered");
  await addRules(tabId);
  await injectQuiet(tabId);
}

export async function disableQuietTab(tabId: number): Promise<void> {
  quiet.delete(tabId);
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

async function injectQuiet(tabId: number): Promise<void> {
  await chrome.debugger
    .sendCommand({ tabId }, "Page.addScriptToEvaluateOnNewDocument", { source: QUIET_SCRIPT })
    .catch(() => undefined);
  await chrome.debugger
    .sendCommand({ tabId }, "Runtime.evaluate", { expression: QUIET_SCRIPT, awaitPromise: false })
    .catch(() => undefined);
}

onEngineInstall(() => {
  chrome.tabs.onRemoved.addListener((tabId) => {
    quiet.delete(tabId);
    const ids = ruleIds.get(tabId) ?? [];
    ruleIds.delete(tabId);
    if (ids.length)
      void chrome.declarativeNetRequest
        .updateSessionRules({ removeRuleIds: ids })
        .catch(() => undefined);
  });
});
