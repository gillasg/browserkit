// browser_context: the user's browsing context in one call, for requests that name a site, a
// page or "my" anything without saying where it is. Both MCP servers and Aeon's agent build the
// same cell from this, so the tool means the same thing everywhere.

export interface BrowserContextInput {
  request?: string;
  days?: number;
}

export const browserContextDescription =
  "What the user has open and where they usually go, read from their real browser in one call: the active tab, the open tabs, sites visited in the last two days, the sites they use most (from history), and history and bookmark pages matching the request's words. " +
  "Call it first when a request is vague about where: 'open X' or 'go to my X' (find the real URL the user uses; never guess or ask), 'that page / article / doc I was on', 'my / most / last / usual' anything, or a site named without a URL. " +
  "Pass the request's key words as request. For counting or ranking the user's own visits (most visited subreddits, which docs they read), go on with browser.history.top in browser_code. Skip it when the request already gives a URL or only needs the current page.";

export const browserContextSchema = {
  type: "object",
  properties: {
    request: {
      type: "string",
      maxLength: 300,
      description:
        "The words to look for in history and bookmarks (a site, product or page name). Empty: only tabs and sites.",
    },
    days: {
      type: "integer",
      minimum: 1,
      maximum: 3650,
      description: "How far back to match history (default 365).",
    },
  },
  additionalProperties: false,
} as const;

/** The browser_code cell that answers browser_context. */
export function browserContextCode(input: BrowserContextInput): string {
  const request = typeof input.request === "string" ? input.request.slice(0, 300) : "";
  const days = Number.isFinite(input.days) ? Math.min(3650, Math.max(1, Number(input.days))) : 0;
  return `await browser.context(${JSON.stringify(request)}${days ? `, {days: ${days}}` : ""})`;
}
