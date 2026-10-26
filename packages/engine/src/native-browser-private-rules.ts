import { onEngineInstall } from "./native-engine-install.js";

// Literal private-network rules for one agent tab. Preflight blocks the navigation itself; these
// rules stop subresources, redirects and scripts on that page from reaching an address that was
// never in the URL. Site rules keep 700000-789999; this band is separate.
const RULE_BASE = 790_000;
const RULE_SPAN = 9_000;
const TYPES = [
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
  "object",
  "other",
] as chrome.declarativeNetRequest.ResourceType[];
const METADATA_HOSTS = [
  "metadata.google.internal",
  "metadata",
  "169.254.169.254",
  "169.254.170.2",
  "100.100.100.200",
];
function privateUrl(allowPorts: readonly number[]): string {
  const allowed = allowPorts.filter((port) => Number.isInteger(port) && port > 0).join("|");
  const skip = allowed ? `^(?!https?://(?:localhost|127\\.0\\.0\\.1):(?:${allowed})(?:/|$))` : "^";
  return (
    skip +
    "https?://" +
    "(?:" +
    "127\\.\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}" +
    "|10\\.\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}" +
    "|192\\.168\\.\\d{1,3}\\.\\d{1,3}" +
    "|172\\.(?:1[6-9]|2\\d|3[01])\\.\\d{1,3}\\.\\d{1,3}" +
    "|169\\.254\\.\\d{1,3}\\.\\d{1,3}" +
    "|100\\.(?:6[4-9]|[7-9]\\d|1[01]\\d|12[0-7])\\.\\d{1,3}\\.\\d{1,3}" +
    "|0\\.\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}" +
    "|\\[::1\\]|::1" +
    "|\\[(?:fc|fd)[0-9a-f]{2}:|(?:fc|fd)[0-9a-f]{2}:" +
    "|\\[fe[89ab][0-9a-f]:|fe[89ab][0-9a-f]:" +
    ")" +
    "(?::\\d+)?(?:/|$)"
  );
}
const ruleIds = new Map<number, number[]>();
let sequence = 0;

/** The rules for one tab; exported so the id band and filters can be checked without Chrome. */
export function privateTabRules(
  tabId: number,
  allowPorts: readonly number[] = [],
): chrome.declarativeNetRequest.Rule[] {
  return [
    {
      id: RULE_BASE + (sequence++ % RULE_SPAN),
      priority: 4,
      action: { type: "block" as chrome.declarativeNetRequest.RuleActionType },
      condition: {
        tabIds: [tabId],
        regexFilter: privateUrl(allowPorts),
        resourceTypes: TYPES,
      },
    },
    {
      id: RULE_BASE + (sequence++ % RULE_SPAN),
      priority: 4,
      action: { type: "block" as chrome.declarativeNetRequest.RuleActionType },
      condition: {
        tabIds: [tabId],
        requestDomains: METADATA_HOSTS,
        resourceTypes: TYPES,
      },
    },
  ];
}

/** Shuts a tab's own requests to literal private/metadata addresses while the policy is on. */
export async function guardPrivateTab(
  tabId: number,
  allowPorts: readonly number[] = [],
): Promise<void> {
  if (ruleIds.has(tabId)) return;
  const rules = privateTabRules(tabId, allowPorts);
  ruleIds.set(
    tabId,
    rules.map((rule) => rule.id),
  );
  await chrome.declarativeNetRequest
    .updateSessionRules({ addRules: rules })
    .catch(() => ruleIds.delete(tabId));
}

export async function releasePrivateTab(tabId: number): Promise<void> {
  const ids = ruleIds.get(tabId);
  ruleIds.delete(tabId);
  if (ids?.length)
    await chrome.declarativeNetRequest
      .updateSessionRules({ removeRuleIds: ids })
      .catch(() => undefined);
}

onEngineInstall(() => {
  chrome.tabs.onRemoved.addListener((tabId) => void releasePrivateTab(tabId));
});
