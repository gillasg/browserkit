import { hostOf, type Login, type SaveLogin } from "./match.js";
import { parseJson, runTool } from "./run.js";

// Bitwarden through its official CLI, `bw`. The vault must be unlocked: the session key comes
// from BW_SESSION or from the saved setup (`bw unlock --raw`).

interface BitwardenItem {
  id?: string;
  name?: string;
  type?: number;
  login?: {
    username?: string | null;
    password?: string | null;
    totp?: string | null;
    uris?: { uri?: string | null }[] | null;
  } | null;
}

export class Bitwarden {
  readonly name = "Bitwarden";
  constructor(private readonly session: string | undefined) {}

  async logins(host: string): Promise<Login[]> {
    const items = parseJson(await this.run(["list", "items", "--url", "https://" + host]));
    if (!Array.isArray(items)) return [];
    return (items as BitwardenItem[]).filter((item) => item.login).map(toLogin);
  }

  async totp(id: string): Promise<string | undefined> {
    const code = (await this.run(["get", "totp", id])).trim();
    return /^\d{6,8}$/.test(code) ? code : undefined;
  }

  async saveLogin(login: SaveLogin): Promise<boolean> {
    const host = hostOf(login.url);
    const item = {
      type: 1,
      name: login.name || host || "Saved login",
      login: {
        username: login.username,
        password: login.password,
        uris: host ? [{ uri: "https://" + host }] : [],
      },
    };
    const encoded = Buffer.from(JSON.stringify(item), "utf8").toString("base64");
    await this.run(["create", "item", encoded]);
    return true;
  }

  async status(): Promise<string> {
    const value = parseJson(await this.run(["status"])) as { status?: string };
    return value.status ?? "unknown";
  }

  private run(args: string[]): Promise<string> {
    const session = this.session ?? process.env.BW_SESSION;
    return runTool("bw", [...args, "--nointeraction"], session ? { BW_SESSION: session } : {});
  }
}

function toLogin(item: BitwardenItem): Login {
  const login = item.login ?? {};
  return {
    id: item.id ?? "",
    name: item.name ?? "",
    username: login.username ?? "",
    password: login.password ?? "",
    hasTotp: Boolean(login.totp),
    urls: (login.uris ?? []).map((entry) => entry.uri ?? "").filter(Boolean),
  };
}
