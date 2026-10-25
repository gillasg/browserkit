// Cookie management for the browser as a whole: list, read, set, remove and clear, filtered by
// URL or domain. Values are hidden unless the caller asks for them, so a normal listing or a trace
// never carries a session token. Everything stays on this machine; nothing is sent anywhere.

import type { BrowserStep } from "@browserkit/protocol";

export type CookieStep = Extract<BrowserStep, { op: "cookies" }>;

export interface CookieSummary {
  name: string;
  domain: string;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  sameSite: string;
  session: boolean;
  expirationDate?: number;
  hostOnly?: boolean;
  value?: string;
}

const MAX_COOKIES = 800;

export async function executeCookies(step: CookieStep): Promise<unknown> {
  switch (step.action) {
    case "list":
    case "get": {
      const cookies = await findCookies(step);
      const summaries = cookies
        .slice(0, MAX_COOKIES)
        .map((cookie) => summarise(cookie, step.values === true));
      return {
        cookies: summaries,
        count: summaries.length,
        ...(cookies.length > MAX_COOKIES ? { truncated: true } : {}),
        ...(step.values === true ? { valuesIncluded: true } : { valuesHidden: true }),
      };
    }
    case "set":
      return setCookie(step);
    case "remove":
      return removeCookies(step);
    case "clear":
      return clearCookies(step);
  }
}

async function findCookies(step: CookieStep): Promise<chrome.cookies.Cookie[]> {
  const filter: chrome.cookies.GetAllDetails = {};
  if (step.url) filter.url = step.url;
  else if (step.domain) filter.domain = step.domain;
  if (step.name) filter.name = step.name;
  if (!step.url && !step.domain && !step.name)
    throw new Error("COOKIES_FILTER_REQUIRED: give a url, a domain or a name");
  return chrome.cookies.getAll(filter).then((cookies) => cookies.sort(byDomainThenName));
}

function byDomainThenName(left: chrome.cookies.Cookie, right: chrome.cookies.Cookie): number {
  return left.domain.localeCompare(right.domain) || left.name.localeCompare(right.name);
}

function summarise(cookie: chrome.cookies.Cookie, withValue: boolean): CookieSummary {
  const summary: CookieSummary = {
    name: cookie.name,
    domain: cookie.domain,
    path: cookie.path,
    secure: cookie.secure,
    httpOnly: cookie.httpOnly,
    sameSite: cookie.sameSite,
    session: cookie.session,
    hostOnly: cookie.hostOnly,
    ...(cookie.expirationDate === undefined ? {} : { expirationDate: cookie.expirationDate }),
  };
  if (withValue) summary.value = cookie.value;
  return summary;
}

/** A URL chrome.cookies accepts for a domain: scheme, host without a leading dot, and the path. */
export function cookieUrl(domain: string, path = "/", secure = false): string {
  const host = domain.replace(/^\./, "");
  return `${secure ? "https" : "https"}://${host}${path.startsWith("/") ? path : `/${path}`}`;
}

async function setCookie(step: CookieStep): Promise<unknown> {
  if (!step.name || step.value === undefined)
    throw new Error("COOKIES_SET: name and value are required");
  const url =
    step.url ?? (step.domain ? cookieUrl(step.domain, step.path ?? "/", step.secure) : undefined);
  if (!url) throw new Error("COOKIES_SET: give a url or a domain");
  const details: chrome.cookies.SetDetails = {
    url,
    name: step.name,
    value: step.value,
    ...(step.domain ? { domain: step.domain } : {}),
    ...(step.path ? { path: step.path } : {}),
    ...(step.secure === undefined ? {} : { secure: step.secure }),
    ...(step.httpOnly === undefined ? {} : { httpOnly: step.httpOnly }),
    ...(step.sameSite ? { sameSite: step.sameSite } : {}),
    ...(step.expirationDate === undefined ? {} : { expirationDate: step.expirationDate }),
  };
  const cookie = await chrome.cookies.set(details);
  if (!cookie)
    throw new Error("COOKIES_SET: the browser refused the cookie (check the domain and URL)");
  return { set: true, cookie: summarise(cookie, false) };
}

async function removeCookies(step: CookieStep): Promise<unknown> {
  if (!step.name) throw new Error("COOKIES_REMOVE: name is required");
  if (step.url) {
    const removed = await chrome.cookies.remove({ url: step.url, name: step.name });
    return { removed: removed !== null, name: step.name, url: step.url };
  }
  const cookies = (await findCookies({ ...step, action: "list" })).filter(
    (cookie) => cookie.name === step.name,
  );
  if (!cookies.length) return { removed: false, name: step.name, count: 0 };
  let count = 0;
  for (const cookie of cookies) {
    const removed = await chrome.cookies.remove({
      url: cookieUrl(cookie.domain, cookie.path, cookie.secure),
      name: cookie.name,
      storeId: cookie.storeId,
    });
    if (removed) count += 1;
  }
  return { removed: count > 0, name: step.name, count };
}

async function clearCookies(step: CookieStep): Promise<unknown> {
  const cookies = await findCookies({ ...step, action: "list" });
  const domains = new Set<string>();
  let count = 0;
  for (const cookie of cookies) {
    const removed = await chrome.cookies.remove({
      url: cookieUrl(cookie.domain, cookie.path, cookie.secure),
      name: cookie.name,
      storeId: cookie.storeId,
    });
    if (removed) {
      count += 1;
      domains.add(cookie.domain);
    }
  }
  return { cleared: count, domains: [...domains].sort(), filter: filterOf(step) };
}

function filterOf(step: CookieStep): { url?: string; domain?: string; name?: string } {
  return {
    ...(step.url ? { url: step.url } : {}),
    ...(step.domain ? { domain: step.domain } : {}),
    ...(step.name ? { name: step.name } : {}),
  };
}
