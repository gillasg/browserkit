// Which identity a run uses: the Chrome profile's own account, the Google accounts signed in on
// the web (each one's authuser index opens it: mail.google.com/mail/u/1), and a proxy for chosen
// sites. Chrome routes proxies per browser, not per tab, so a proxy applies to the sites given
// (or to everything) in this profile until it is cleared.

type Request = Record<string, unknown>;

export function isIdentityRequest(value: Request | null): boolean {
  return Boolean(value && (typeof value.identity === "string" || typeof value.proxy === "string"));
}

export function identityCall(value: Request): Promise<unknown> {
  if (typeof value.proxy === "string") return proxyCall(value.proxy, value);
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

/** Google's own list of the accounts signed in on the web, in authuser order. */
async function googleAccounts(): Promise<{ email: string; name?: string; authuser: number }[]> {
  const response = await fetch(
    "https://accounts.google.com/ListAccounts?gpsia=1&source=ChromiumBrowser&json=standard",
    {
      credentials: "include",
    },
  ).catch(() => undefined);
  if (!response?.ok) return [];
  const text = await response.text();
  const start = text.indexOf("[");
  let list: unknown;
  try {
    list = JSON.parse(text.slice(start));
  } catch {
    return [];
  }
  const rows = Array.isArray(list) && Array.isArray(list[1]) ? (list[1] as unknown[][]) : [];
  return rows
    .filter((row) => Array.isArray(row) && typeof row[3] === "string")
    .map((row) => ({
      email: String(row[3]),
      ...(typeof row[2] === "string" ? { name: row[2] } : {}),
      authuser: typeof row[7] === "number" ? row[7] : rows.indexOf(row),
    }));
}

async function accounts(): Promise<unknown> {
  const [profile, google] = await Promise.all([profileAccount(), googleAccounts()]);
  return { chromeProfile: profile ?? null, google };
}

/** A PAC script: the listed sites (and their subdomains) through the proxy, the rest direct. */
export function pacScript(proxy: string, sites: string[]): string {
  const url = new URL(proxy.includes("://") ? proxy : "http://" + proxy);
  const kind = url.protocol.startsWith("socks")
    ? "SOCKS5"
    : url.protocol === "https:"
      ? "HTTPS"
      : "PROXY";
  const route = `${kind} ${url.hostname}:${url.port || (kind === "SOCKS5" ? "1080" : "8080")}`;
  if (!sites.length)
    return `function FindProxyForURL(url, host) { return ${JSON.stringify(route)}; }`;
  return `function FindProxyForURL(url, host) {
  var sites = ${JSON.stringify(sites)};
  for (var i = 0; i < sites.length; i++)
    if (host === sites[i] || dnsDomainIs(host, "." + sites[i])) return ${JSON.stringify(route)};
  return "DIRECT";
}`;
}

async function proxyCall(action: string, value: Request): Promise<unknown> {
  if (!chrome.proxy?.settings) throw new Error("UNSUPPORTED: this browser has no proxy permission");
  if (action === "get") {
    const current = await chrome.proxy.settings.get({});
    return {
      mode: (current.value as { mode?: string } | undefined)?.mode ?? "system",
      control: current.levelOfControl,
    };
  }
  if (action === "clear") {
    await chrome.proxy.settings.clear({ scope: "regular" });
    return { cleared: true };
  }
  if (action !== "set") throw new Error("UNSUPPORTED: browser.proxy." + action);
  const proxy = String(value.server ?? "");
  if (!proxy)
    throw new Error("INVALID_ARGUMENT: browser.proxy.set needs {server: 'socks5://host:port'}");
  if (/@/.test(proxy))
    throw new Error("UNSUPPORTED: proxies that need a password; use one that allows this machine");
  const sites = (Array.isArray(value.sites) ? value.sites : [])
    .map(
      (site) =>
        String(site)
          .toLowerCase()
          .replace(/^https?:\/\//, "")
          .replace(/^www\./, "")
          .split("/")[0] ?? "",
    )
    .filter(Boolean);
  await chrome.proxy.settings.set({
    value: { mode: "pac_script", pacScript: { data: pacScript(proxy, sites) } },
    scope: "regular",
  });
  return {
    proxy: new URL(proxy.includes("://") ? proxy : "http://" + proxy).host,
    sites: sites.length ? sites : "all",
  };
}
