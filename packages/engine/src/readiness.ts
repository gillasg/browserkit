// Typed readiness: not just "did the page load" but what the page is. A snapshot gathered in the
// page is classified here, in the extension, so the same rules apply to browser code, the check
// path and anything else asking "is this ready, empty, signed out, walled, missing or broken?".
// The classifier is pure and exhaustively testable; only the snapshot touches a page.

export type ReadinessState =
  "ready" | "empty" | "loading" | "login" | "challenge" | "not-found" | "error";

export interface ReadinessSnapshot {
  readyState?: string;
  url?: string;
  title?: string;
  httpStatus?: number | null;
  textLength?: number;
  textSample?: string;
  heading?: string;
  hasPassword?: boolean;
  hasEmail?: boolean;
  hasSignInLink?: boolean;
  spinner?: boolean;
  ariaBusy?: boolean;
  main?: boolean;
  links?: number;
  rows?: number;
  forms?: number;
}

export interface Readiness {
  state: ReadinessState;
  evidence: string[];
  url?: string;
  title?: string;
  httpStatus?: number | null;
  textLength: number;
  at: string;
}

const CHALLENGE = [
  "just a moment",
  "attention required",
  "checking your browser",
  "verify you are human",
  "are you a robot",
  "unusual traffic",
  "enable javascript and cookies to continue",
  "access denied",
  "rate limit",
  "too many requests",
  "cloudflare",
  "datadome",
  "perimeterx",
  "px-captcha",
  "captcha",
];

const LOGIN = [
  "sign in",
  "sign-in",
  "log in",
  "login",
  "create account",
  "welcome back",
  "forgot password",
  "continue with google",
  "continue with apple",
];

const NOT_FOUND = [
  "404",
  "not found",
  "page does not exist",
  "page doesn't exist",
  "no longer available",
  "gone",
];

const ERROR = [
  "application error",
  "something went wrong",
  "internal server error",
  "an error occurred",
  "service unavailable",
  "bad gateway",
];

const EMPTY = [
  "no results",
  "nothing here",
  "no items",
  "no posts",
  "no data",
  "couldn't find",
  "could not find",
];

const includesAny = (haystack: string, needles: string[]): string[] =>
  needles.filter((needle) => haystack.includes(needle));

/**
 * Order matters: a wall beats a form, a loading page beats an empty one, and a 404 beats "ready".
 * Every branch records why, because "empty" without evidence is not actionable.
 */
export function classifyReadiness(snapshot: ReadinessSnapshot): Readiness {
  const title = (snapshot.title ?? "").trim();
  const heading = (snapshot.heading ?? "").trim();
  const text = `${title}\n${heading}\n${snapshot.textSample ?? ""}`.toLowerCase();
  const textLength = snapshot.textLength ?? (snapshot.textSample ?? "").length;
  const evidence: string[] = [];
  const finish = (state: ReadinessState): Readiness => ({
    state,
    evidence,
    ...(snapshot.url ? { url: snapshot.url } : {}),
    ...(title ? { title } : {}),
    httpStatus: snapshot.httpStatus ?? null,
    textLength,
    at: new Date().toISOString(),
  });

  const challenge = includesAny(text, CHALLENGE);
  if (challenge.length) {
    evidence.push(`challenge wording: ${challenge.slice(0, 3).join(", ")}`);
    return finish("challenge");
  }

  if (snapshot.hasPassword === true) {
    evidence.push("password field on the page");
    return finish("login");
  }
  const login = includesAny(`${heading}\n${title}`.toLowerCase(), LOGIN);
  const walled = textLength < 1500 && (snapshot.forms ?? 0) > 0 && (snapshot.links ?? 0) < 40;
  if (login.length && (walled || (snapshot.hasEmail === true && snapshot.hasSignInLink === true))) {
    evidence.push(`sign-in wording: ${login[0]}`);
    if (walled) evidence.push("little content outside the form");
    return finish("login");
  }

  const stillLoading =
    snapshot.readyState !== "complete" || snapshot.spinner === true || snapshot.ariaBusy === true;
  if (stillLoading) {
    if (snapshot.readyState !== "complete")
      evidence.push(`document ${snapshot.readyState ?? "loading"}`);
    if (snapshot.spinner === true) evidence.push("spinner or skeleton visible");
    if (snapshot.ariaBusy === true) evidence.push("aria-busy element");
    return finish("loading");
  }

  const status = snapshot.httpStatus ?? null;
  const headingText = `${title}\n${heading}`.toLowerCase();
  if (status === 404 || status === 410 || includesAny(headingText, NOT_FOUND).length) {
    if (status === 404 || status === 410) evidence.push(`HTTP ${status}`);
    const wording = includesAny(headingText, NOT_FOUND);
    if (wording.length) evidence.push(`not-found wording: ${wording[0]}`);
    return finish("not-found");
  }

  if ((status !== null && status >= 500) || includesAny(headingText, ERROR).length) {
    if (status !== null && status >= 500) evidence.push(`HTTP ${status}`);
    const wording = includesAny(headingText, ERROR);
    if (wording.length) evidence.push(`error wording: ${wording[0]}`);
    return finish("error");
  }

  const rows = snapshot.rows ?? 0;
  const emptyWording = includesAny(text, EMPTY);
  if (emptyWording.length && rows === 0) {
    evidence.push(`empty wording: ${emptyWording[0]}`);
    evidence.push(`no list rows`);
    return finish("empty");
  }
  if (textLength < 200 && rows === 0 && snapshot.main !== true) {
    evidence.push(`only ${textLength} characters of text`);
    evidence.push("no main region or list rows");
    return finish("empty");
  }

  evidence.push(`document complete`);
  if (status !== null) evidence.push(`HTTP ${status}`);
  if (rows > 0) evidence.push(`${rows} list rows`);
  evidence.push(`${textLength} characters of text`);
  if (snapshot.main === true) evidence.push("main region found");
  return finish("ready");
}

/**
 * The page half: one expression that gathers the snapshot without touching the page's own state.
 * Kept as a string because it runs through the page's debugger, not in the extension.
 */
export const readinessSnapshotExpression = `(() => {
  const clean = (value) => String(value ?? "").replace(/\\s+/g, " ").trim();
  const body = document.body;
  const text = clean(body ? body.innerText : "").slice(0, 20000);
  const heading = clean((document.querySelector("h1, h2") || {}).innerText || "");
  const navigation = performance.getEntriesByType && performance.getEntriesByType("navigation")[0];
  const status = navigation && typeof navigation.responseStatus === "number" ? navigation.responseStatus : null;
  return {
    readyState: document.readyState,
    url: location.href,
    title: document.title,
    httpStatus: status,
    textLength: text.length,
    textSample: text.slice(0, 4000),
    heading,
    hasPassword: !!document.querySelector("input[type=password]"),
    hasEmail: !!document.querySelector("input[type=email], input[autocomplete=username], input[name*=email i]"),
    hasSignInLink: [...document.querySelectorAll("a, button")].some((node) => /sign\\s*in|log\\s*in/i.test(clean(node.innerText))),
    spinner: !!document.querySelector("[class*=spinner i], [class*=skeleton i], [role=progressbar], [aria-busy=true]"),
    ariaBusy: !!document.querySelector("[aria-busy=true]"),
    main: !!document.querySelector("main, [role=main], article, #content, .content"),
    links: document.links ? document.links.length : 0,
    rows: document.querySelectorAll("li, article, [role=listitem], tr").length,
    forms: document.forms ? document.forms.length : 0
  };
})()`;
