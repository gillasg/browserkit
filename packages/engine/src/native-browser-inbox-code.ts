// One-time sign-in codes the site sent by email or text: read from the user's Gmail (its unread
// feed, with their own session) and from Google Messages for web when it is paired. The engine
// types the code; agent code only learns whether one was found and where from. Messages about a
// payment, a transfer or a card are skipped: those codes approve money, not a sign-in.

export interface InboxCode {
  code: string;
  from: "gmail" | "messages";
}

const GMAIL_FEED = "https://mail.google.com/mail/u/0/feed/atom";
const MESSAGES_URL = "https://messages.google.com/web/conversations";
const POLL_MS = 4_000;
const CODE_WORDS =
  /\b(code|otp|passcode|one.?time|verification|verify|security|login|sign.?in|pin)\b/i;
const MONEY_WORDS =
  /\b(payment|pay|paid|transaction|transfer|debit(ed)?|credit(ed)?|card ending|purchase|amount|upi|rs\.?|inr|usd)\b|[₹$€£]/i;

/** The code in a message, when it reads like a sign-in code and not a payment approval. */
export function codeIn(text: string): string | undefined {
  if (!CODE_WORDS.test(text) || MONEY_WORDS.test(text)) return undefined;
  const near = text.match(
    /(?:code|otp|passcode|pin)[^A-Za-z0-9]{0,30}(?:is[^A-Za-z0-9]{0,5})?([A-Z]{0,3}-?\d{4,8})\b/i,
  );
  if (near?.[1]) return near[1].replace(/^[A-Z]{1,3}-/i, "");
  const before = text.match(/\b(\d{4,8})\b[^.]{0,40}(?:is your|is the|as your)/i);
  if (before?.[1]) return before[1];
  const digits = [...text.matchAll(/\b\d{4,8}\b/g)].map((match) => match[0]);
  return digits.find((value) => !/^(19|20)\d\d$/.test(value));
}

/** The site's own name ("github" for github.com) a message about it usually mentions. */
function brandOf(site: string): string {
  const parts = site.replace(/^www\./, "").split(".");
  return (parts.length > 2 && parts.at(-2)!.length <= 3 ? parts.at(-3) : parts.at(-2)) ?? site;
}

function entries(feed: string): { text: string; issued: number }[] {
  return [...feed.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map((match) => {
    const entry = match[1] ?? "";
    const field = (name: string) =>
      entry.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`))?.[1] ?? "";
    const issued = Date.parse(field("issued") || field("modified"));
    const text = [field("title"), field("summary"), field("name"), field("email")]
      .join(" ")
      .replace(/&amp;/g, "&")
      .replace(/&#39;/g, "'")
      .replace(/&quot;/g, '"');
    return { text, issued: Number.isFinite(issued) ? issued : 0 };
  });
}

async function gmailCode(brand: string, since: number): Promise<string | undefined> {
  const response = await fetch(GMAIL_FEED, { credentials: "include" }).catch(() => undefined);
  if (!response?.ok) return undefined;
  const fresh = entries(await response.text()).filter((entry) => entry.issued >= since - 60_000);
  const ranked = [
    ...fresh.filter((entry) => entry.text.toLowerCase().includes(brand)),
    ...fresh.filter((entry) => !entry.text.toLowerCase().includes(brand)),
  ];
  for (const entry of ranked) {
    const code = codeIn(entry.text);
    if (code) return code;
  }
  return undefined;
}

async function messagesTab(): Promise<number | undefined> {
  const [tab] = await chrome.tabs.query({ url: "https://messages.google.com/web/*" });
  return tab?.id;
}

/** The conversation list's previews, newest first. */
async function messagePreviews(tabId: number): Promise<string[]> {
  const [result] = await chrome.scripting
    .executeScript({
      target: { tabId },
      func: () =>
        [...document.querySelectorAll("mws-conversation-list-item")]
          .slice(0, 8)
          .map((item) => (item as HTMLElement).innerText.replace(/\s+/g, " ").trim()),
    })
    .catch(() => []);
  return Array.isArray(result?.result) ? (result.result as string[]) : [];
}

/** What Google Messages shows before the code is asked for, so only a new text counts. */
export async function messagesSnapshot(): Promise<Set<string>> {
  const tabId = await messagesTab();
  return new Set(tabId === undefined ? [] : await messagePreviews(tabId));
}

// A tab opened just now has no "before": only previews stamped a minute or two ago count.
const JUST_NOW = /\b(now|just now|[1-3] ?min)\b/i;

async function messagesCode(
  brand: string,
  before: Set<string> | undefined,
): Promise<string | undefined> {
  const tabId = await messagesTab();
  if (tabId === undefined) return undefined;
  const fresh = (await messagePreviews(tabId)).filter((text) =>
    before ? !before.has(text) : JUST_NOW.test(text),
  );
  const ranked = [
    ...fresh.filter((text) => text.toLowerCase().includes(brand)),
    ...fresh.filter((text) => !text.toLowerCase().includes(brand)),
  ];
  for (const text of ranked) {
    const code = codeIn(text);
    if (code) return code;
  }
  return undefined;
}

/** Opens Google Messages in the background when it is not open, so a paired phone's texts show. */
async function openMessages(): Promise<number | undefined> {
  if ((await messagesTab()) !== undefined) return undefined;
  const tab = await chrome.tabs.create({ url: MESSAGES_URL, active: false }).catch(() => undefined);
  return tab?.id;
}

/**
 * Waits for a code sent to the user's email or phone since `since`. `before` is the Messages
 * snapshot taken when the code was requested.
 */
export async function waitForInboxCode(
  site: string,
  options: { since: number; before?: Set<string>; waitMs?: number },
): Promise<InboxCode | undefined> {
  const brand = brandOf(site).toLowerCase();
  const opened = await openMessages();
  const before = opened === undefined ? options.before : undefined;
  const deadline = Date.now() + Math.min(Math.max(options.waitMs ?? 90_000, 5_000), 300_000);
  try {
    while (Date.now() < deadline) {
      const mail = await gmailCode(brand, options.since);
      if (mail) return { code: mail, from: "gmail" };
      const text = await messagesCode(brand, before);
      if (text) return { code: text, from: "messages" };
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
    return undefined;
  } finally {
    if (opened !== undefined) await chrome.tabs.remove(opened).catch(() => undefined);
  }
}

export { MESSAGES_URL };
