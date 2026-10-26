import { hostOf, type Login, type SaveLogin } from "./match.js";
import { parseJson, runTool, runToolDirect } from "./run.js";

// Proton Pass through its official CLI, `pass-cli` (paid plans). It keeps its own session after
// `pass-cli login`. Its JSON output is not documented field by field, so items are read by the
// names Proton uses elsewhere (username, email, password, urls, totp) wherever they sit.

type Json = Record<string, unknown>;

export class ProtonPass {
  readonly name = "Proton Pass";

  async logins(): Promise<Login[]> {
    const shares = await this.shareIds();
    const lists = shares.length
      ? await Promise.all(shares.map((id) => this.list(["--share-id", id], id)))
      : [await this.list([], undefined)];
    return lists.flat();
  }

  async totp(id: string): Promise<string | undefined> {
    const value = parseJson(await runTool("pass-cli", ["item", "totp", id, "--output", "json"]));
    return findCode(value);
  }

  async saveLogin(login: SaveLogin): Promise<boolean> {
    const host = hostOf(login.url);
    await runToolDirect("pass-cli", [
      "item",
      "create",
      "login",
      "--title",
      login.name || host || "Saved login",
      "--username",
      login.username,
      "--password",
      login.password,
      ...(host ? ["--url", "https://" + host] : []),
      "--output",
      "json",
    ]);
    return true;
  }

  async status(): Promise<string> {
    await runTool("pass-cli", ["vault", "list", "--output", "json"]);
    return "unlocked";
  }

  private async shareIds(): Promise<string[]> {
    const value = parseJson(await runTool("pass-cli", ["vault", "list", "--output", "json"]));
    const ids = new Set<string>();
    walk(value, (node) => {
      const id = text(node, ["share_id", "shareId", "shareID"]);
      if (id) ids.add(id);
    });
    return [...ids];
  }

  private async list(args: string[], shareId: string | undefined): Promise<Login[]> {
    const value = parseJson(
      await runTool("pass-cli", ["item", "list", ...args, "--output", "json"]),
    );
    const logins: Login[] = [];
    walk(value, (node) => {
      const login = toLogin(node, shareId);
      if (login) logins.push(login);
    });
    return logins;
  }
}

function toLogin(node: Json, shareId: string | undefined): Login | undefined {
  const content = loginContent(node);
  if (!content) return undefined;
  const share = text(node, ["share_id", "shareId"]) ?? shareId;
  const item = text(node, ["item_id", "itemId", "id"]);
  return {
    id: share && item ? `pass://${share}/${item}` : "",
    name: text(node, ["title", "name"]) ?? text(content, ["title", "name"]) ?? "",
    username: text(content, ["username", "email", "itemEmail", "itemUsername"]) ?? "",
    password: text(content, ["password"]) ?? "",
    hasTotp: Boolean(text(content, ["totp", "totp_uri", "totpUri"])),
    urls: strings(content.urls ?? content.url ?? node.urls),
  };
}

/** The object holding the password, the item itself or something nested in it. */
function loginContent(node: Json): Json | undefined {
  if (typeof node.password === "string") return node;
  for (const key of ["content", "login", "data"]) {
    const inner = node[key];
    if (inner && typeof inner === "object" && !Array.isArray(inner)) {
      const found = loginContent(inner as Json);
      if (found) return found;
    }
  }
  return undefined;
}

function walk(value: unknown, visit: (node: Json) => void): void {
  if (Array.isArray(value)) return value.forEach((item) => walk(item, visit));
  if (!value || typeof value !== "object") return;
  const node = value as Json;
  if (loginContent(node) || text(node, ["share_id", "shareId"])) visit(node);
  if (loginContent(node)) return;
  for (const child of Object.values(node))
    if (child && typeof child === "object") walk(child, visit);
}

function text(node: Json, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = node[key];
    if (typeof value === "string" && value) return value;
  }
  return undefined;
}

function strings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (!Array.isArray(value)) return [];
  return value
    .map((item) =>
      typeof item === "string" ? item : text((item ?? {}) as Json, ["url", "uri", "value"]),
    )
    .filter((item): item is string => Boolean(item));
}

function findCode(value: unknown): string | undefined {
  if (typeof value === "string") return /^\d{6,8}$/.test(value.trim()) ? value.trim() : undefined;
  if (!value || typeof value !== "object") return undefined;
  for (const item of Object.values(value)) {
    const code = findCode(item);
    if (code) return code;
  }
  return undefined;
}
