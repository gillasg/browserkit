import {
  clearCover,
  clearPasswords,
  scanFields,
  typeCodeBoxes,
  submitForm,
  typeInto,
  waitForChange,
  type SignInFields,
} from "./native-browser-signin-page.js";
import { rememberSecrets } from "./native-browser-secrets.js";

// bu.signIn(): sign in to the page the agent is on with a login from the user's password
// manager. The machine looks the login up by the tab's real address; the engine types it into
// the page; the agent's code only ever gets the outcome below, never the password or the code.
// There is no approval step: calling bu.signIn() is the user's instruction to sign in.

export interface SignInResult {
  signedIn: boolean;
  site: string;
  provider?: string;
  account?: string;
  /** Why it stopped short: the agent decides what to do next (often bu.handoff). */
  reason?:
    | "NO_PASSWORD_MANAGER"
    | "PASSWORD_MANAGER_LOCKED"
    | "PASSWORD_MANAGER_FAILED"
    | "NO_SAVED_LOGIN"
    | "CHOOSE_ACCOUNT"
    | "NO_SIGN_IN_FORM"
    | "NEEDS_CODE"
    | "CAPTCHA"
    | "REJECTED"
    /** The form posts the login to another site: nothing was typed. */
    | "FOREIGN_FORM"
    /** The site wants approval on the user's phone or app, and none came within a minute. */
    | "APPROVE_ON_DEVICE";
  accounts?: string[];
  detail?: string;
}

interface Login {
  id: string;
  name: string;
  username: string;
  password: string;
  hasTotp: boolean;
}

interface LoginAnswer {
  provider: string | null;
  error?: SignInResult["reason"];
  detail?: string;
  logins: Login[];
}

type Ask = (request: unknown) => Promise<unknown>;
const MAX_STAGES = 4;
const APPROVE_WAIT_MS = 60_000;

export async function signInToPage(
  tabId: number,
  options: { account?: unknown },
  ask: Ask,
): Promise<SignInResult> {
  const tab = await chrome.tabs.get(tabId);
  const url = tab.url ?? "";
  const site = siteOf(url);
  if (!site) throw new Error("INVALID_TARGET: sign-in needs an http(s) page");
  const account = typeof options.account === "string" ? options.account : undefined;
  const answer = (await ask({ credential: "login", url, ...(account ? { account } : {}) })) as
    LoginAnswer | undefined;
  const chosen = pickLogin(site, answer, account);
  if (!("login" in chosen)) return chosen;
  const { login, provider } = chosen;
  rememberSecrets([login.password]);
  return fill(tabId, login, ask, url, {
    site,
    provider,
    account: login.username || login.name,
  });
}

function pickLogin(
  site: string,
  answer: LoginAnswer | undefined,
  account: string | undefined,
): SignInResult | { login: Login; provider: string } {
  if (!answer || answer.error || !answer.provider)
    return {
      signedIn: false,
      site,
      reason: answer?.error ?? "NO_PASSWORD_MANAGER",
      ...(answer?.detail ? { detail: answer.detail } : {}),
    };
  const [first, ...rest] = answer.logins;
  if (!first) return { signedIn: false, site, provider: answer.provider, reason: "NO_SAVED_LOGIN" };
  if (rest.length && !account)
    return {
      signedIn: false,
      site,
      provider: answer.provider,
      reason: "CHOOSE_ACCOUNT",
      accounts: answer.logins.map((login) => login.username || login.name),
    };
  return { login: first, provider: answer.provider };
}

type Base = Pick<SignInResult, "site" | "provider" | "account">;

async function fill(
  tabId: number,
  login: Login,
  ask: Ask,
  url: string,
  base: Base,
): Promise<SignInResult> {
  let fields = await scanFields(tabId);
  if (!fields || !(fields.user || fields.password || fields.code))
    return { ...base, signedIn: false, reason: "NO_SIGN_IN_FORM" };
  if (fields.foreign)
    return { ...base, signedIn: false, reason: "FOREIGN_FORM", detail: fields.foreign };
  for (let stage = 0; stage < MAX_STAGES && fields; stage++) {
    const stop = await step(tabId, fields, login, ask, url);
    if (stop) return { ...base, signedIn: false, reason: stop };
    if (!(fields.user || fields.password || fields.code)) break;
    let next = await waitForChange(tabId, fields);
    if (next?.approve) next = await waitForChange(tabId, next, APPROVE_WAIT_MS);
    if (!next || sameForm(fields, next)) break;
    fields = next;
  }
  return outcome(tabId, fields, base);
}

/** One screen of a sign-in: username, then password, then a one-time code, as the site asks. */
async function step(
  tabId: number,
  fields: SignInFields,
  login: Login,
  ask: Ask,
  url: string,
): Promise<SignInResult["reason"] | undefined> {
  if (fields.captcha) return "CAPTCHA";
  if (fields.foreign) return "FOREIGN_FORM";
  if (fields.covered) await clearCover(tabId);
  if (fields.code) return enterCode(tabId, login, ask, url, fields.codeBoxes ?? 0);
  if (fields.user && login.username && fields.userValue !== login.username)
    await typeInto(tabId, "user", login.username);
  if (fields.password) await typeInto(tabId, "password", login.password);
  if (fields.user || fields.password) await submitForm(tabId);
  return undefined;
}

async function enterCode(
  tabId: number,
  login: Login,
  ask: Ask,
  url: string,
  boxes: number,
): Promise<SignInResult["reason"] | undefined> {
  if (!login.hasTotp || !login.id) return "NEEDS_CODE";
  const reply = (await ask({ credential: "totp", url, id: login.id })) as { code?: string | null };
  if (!reply?.code) return "NEEDS_CODE";
  rememberSecrets([reply.code]);
  if (boxes) await typeCodeBoxes(tabId, reply.code, boxes);
  else await typeInto(tabId, "code", reply.code);
  await submitForm(tabId);
  return undefined;
}

async function outcome(
  tabId: number,
  last: SignInFields | undefined,
  base: Base,
): Promise<SignInResult> {
  const now = (await scanFields(tabId)) ?? last;
  if (now?.captcha) return { ...base, signedIn: false, reason: "CAPTCHA" };
  if (now?.approve) return { ...base, signedIn: false, reason: "APPROVE_ON_DEVICE" };
  if (now?.code) return { ...base, signedIn: false, reason: "NEEDS_CODE" };
  if (now?.password) {
    await clearPasswords(tabId);
    return { ...base, signedIn: false, reason: "REJECTED" };
  }
  return { ...base, signedIn: true };
}

function sameForm(a: SignInFields, b: SignInFields): boolean {
  return a.url === b.url && a.password === b.password && a.code === b.code && a.user === b.user;
}

function siteOf(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return undefined;
    return parsed.hostname.replace(/^www\./, "");
  } catch {
    return undefined;
  }
}
