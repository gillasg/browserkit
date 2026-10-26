// Which saved logins belong to the page the agent is on. The host always comes from the tab's
// real address, never from the agent, and a login only matches its own site or a subdomain of
// it, so a look-alike page can never be handed another site's password.

export interface Login {
  /** The password manager's id for the item, used to fetch a fresh one-time code. */
  id: string;
  name: string;
  username: string;
  password: string;
  hasTotp: boolean;
  urls: string[];
}

export interface SaveLogin {
  url: string;
  name?: string;
  username: string;
  password: string;
}

export function hostOf(value: string): string | undefined {
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(value) ? value : "https://" + value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
    return url.hostname.toLowerCase().replace(/^www\./, "") || undefined;
  } catch {
    return undefined;
  }
}

/** A saved login for example.com matches example.com and accounts.example.com, nothing else. */
export function sameSite(savedHost: string, pageHost: string): boolean {
  return pageHost === savedHost || pageHost.endsWith("." + savedHost);
}

export function loginsFor(logins: readonly Login[], pageHost: string, account?: string): Login[] {
  const wanted = account?.trim().toLowerCase();
  return logins.filter(
    (login) =>
      login.password &&
      login.urls.some((url) => {
        const host = hostOf(url);
        return host !== undefined && sameSite(host, pageHost);
      }) &&
      (!wanted || login.username.toLowerCase() === wanted || login.name.toLowerCase() === wanted),
  );
}
