// Which identity a run uses: the Chrome profile's own account, the Google accounts signed in on
// the web (each one's authuser index opens it: mail.google.com/mail/u/1).

type Request = Record<string, unknown>;

export function isIdentityRequest(value: Request | null): boolean {
  return Boolean(value && typeof value.identity === "string");
}

export function identityCall(value: Request): Promise<unknown> {
  if (value.identity === "accounts") return accounts();
  throw new Error("UNSUPPORTED: browser.identity." + String(value.identity));
}

async function profileAccount(): Promise<{ email?: string } | undefined> {
  if (!chrome.identity?.getProfileUserInfo) return undefined;
  const info = await chrome.identity
    .getProfileUserInfo({ accountStatus: "ANY" as chrome.identity.AccountStatus })
    .catch(() => undefined);
  return info?.email ? { email: info.email } : undefined;
}

/**
 * The Google accounts signed in on the web, in authuser order. Each one's Gmail feed names its
 * owner; an index past the last account redirects to u/0. (Google refuses ListAccounts from
 * extensions.) Accounts without Gmail are not listed.
 */
async function googleAccounts(): Promise<{ email: string; authuser: number }[]> {
  const found: { email: string; authuser: number }[] = [];
  for (let authuser = 0; authuser < 10; authuser += 1) {
    const email = await gmailOwner(authuser);
    if (!email || found.some((account) => account.email === email)) break;
    found.push({ email, authuser });
  }
  return found;
}

async function gmailOwner(authuser: number): Promise<string | undefined> {
  const url = `https://mail.google.com/mail/u/${authuser}/feed/atom`;
  const response = await fetch(url, { credentials: "include" }).catch(() => undefined);
  if (!response?.ok || (authuser > 0 && !response.url.includes(`/u/${authuser}/`)))
    return undefined;
  const title = /<title>([^<]*)<\/title>/.exec(await response.text())?.[1] ?? "";
  return /[^\s]+@[^\s]+/.exec(title)?.[0];
}

async function accounts(): Promise<unknown> {
  const [profile, google] = await Promise.all([profileAccount(), googleAccounts()]);
  return { chromeProfile: profile ?? null, google };
}
