import { BridgeClient } from "../client.js";
import { flag, has, type Args } from "../args.js";
import { out } from "../output.js";
import type { Command } from "../usage.js";

// Cookies for a site, without ever printing values unless asked. Values are session tokens; a
// listing is meant to answer "is this site signed in, and for which account?" not to expose them.

const SESSION = "browserkit-cli";

async function inBrowser(code: string): Promise<unknown> {
  const bridge = await BridgeClient.connect();
  try {
    const reply = await bridge.request("run", { code, session: SESSION });
    if (reply.error) throw new Error(String(reply.error));
    return reply.value;
  } finally {
    bridge.close();
  }
}

/** Uses the user's active tab only to answer: the tab is not navigated and stays theirs. */
const SCRIPT = `(async () => {
  const tab = await browser.activeTab().catch(() => null);
  if (!tab) throw new Error("no page tab is open; open one first");
  const filter = __FILTER__;
  return __BODY__;
})()`;

function run(script: string, filter: Record<string, unknown>, body: string): Promise<unknown> {
  return inBrowser(SCRIPT.replace("__FILTER__", JSON.stringify(filter)).replace("__BODY__", body));
}

async function list(args: Args): Promise<number> {
  const filter: Record<string, unknown> = {};
  if (flag(args, "domain")) filter.domain = flag(args, "domain");
  if (flag(args, "url")) filter.url = flag(args, "url");
  if (!filter.domain && !filter.url) throw new Error("Give --domain <host> or --url <page url>");
  if (has(args, "values")) filter.values = true;
  const result = (await run("", filter, "browser.cookies.list(filter)")) as {
    cookies: Record<string, unknown>[];
    count: number;
    valuesHidden?: boolean;
  };
  if (has(args, "json")) {
    out(JSON.stringify(result, null, 2));
    return 0;
  }
  for (const cookie of result.cookies)
    out(
      `${String(cookie.domain)}${String(cookie.path)}\t${String(cookie.name)}\t` +
        `${cookie.secure ? "secure " : ""}${cookie.httpOnly ? "httpOnly " : ""}${String(cookie.sameSite)}\t` +
        `${cookie.session ? "session" : new Date(Number(cookie.expirationDate) * 1000).toISOString()}` +
        `${cookie.value === undefined ? "" : `\t${String(cookie.value)}`}`,
    );
  out(
    `${result.count} cookies${result.valuesHidden ? " (values hidden; pass --values to show them)" : ""}`,
  );
  return 0;
}

async function set(args: Args): Promise<number> {
  const domain = flag(args, "domain");
  const name = flag(args, "name");
  const value = flag(args, "value");
  if (!domain || !name || value === undefined)
    throw new Error(
      "Usage: browserkit cookies set --domain <host> --name <name> --value <value> [--path /] [--secure] [--http-only]",
    );
  const cookie: Record<string, unknown> = { domain, name, value };
  if (flag(args, "path")) cookie.path = flag(args, "path");
  if (has(args, "secure")) cookie.secure = true;
  if (has(args, "http-only")) cookie.httpOnly = true;
  const result = await run("", {}, `browser.cookies.set(${JSON.stringify(cookie)})`);
  if (has(args, "json")) out(JSON.stringify(result));
  else out(`Set cookie ${name} on ${domain}.`);
  return 0;
}

async function clear(args: Args): Promise<number> {
  const filter: Record<string, unknown> = {};
  if (flag(args, "domain")) filter.domain = flag(args, "domain");
  if (flag(args, "url")) filter.url = flag(args, "url");
  if (!filter.domain && !filter.url) throw new Error("Give --domain <host> or --url <page url>");
  const result = (await run("", filter, "browser.cookies.clear(filter)")) as {
    cleared: number;
    domains: string[];
  };
  if (has(args, "json")) out(JSON.stringify(result));
  else out(`Cleared ${result.cleared} cookies for ${result.domains.join(", ") || "nothing"}.`);
  return 0;
}

async function remove(args: Args): Promise<number> {
  const name = flag(args, "name");
  const domain = flag(args, "domain");
  const url = flag(args, "url");
  if (!name || (!domain && !url))
    throw new Error("Usage: browserkit cookies delete --name <name> --domain <host>");
  const filter: Record<string, unknown> = { ...(domain ? { domain } : {}) };
  const result = (await run(
    "",
    filter,
    `browser.cookies.remove(${JSON.stringify(name)}, filter)`,
  )) as { removed: boolean };
  if (has(args, "json")) out(JSON.stringify(result));
  else out(`${result.removed ? "Removed" : "No"} cookie ${name} on ${domain ?? url}.`);
  return 0;
}

async function cookies(args: Args): Promise<number> {
  const action = args.positional[0] ?? "list";
  if (action === "list") return list(args);
  if (action === "set") return set(args);
  if (action === "clear") return clear(args);
  if (action === "delete" || action === "remove") return remove(args);
  throw new Error("Usage: browserkit cookies list|set|clear|delete [--domain <host>] [--json]");
}

export const cookiesCommand: Command = {
  name: "cookies",
  group: "Browser",
  summary: "list, set, clear or delete cookies for a site",
  help: `Usage: browserkit cookies list --domain <host> [--values] [--json]
       browserkit cookies set --domain <host> --name <name> --value <value> [--path /] [--secure] [--http-only]
       browserkit cookies delete --name <name> --domain <host> [--json]
       browserkit cookies clear --domain <host> [--json]

Values are hidden unless --values is passed, so a listing does not put a session token in your
terminal by accident. Uses the open browser; the active tab is only borrowed to answer.`,
  run: cookies,
};
