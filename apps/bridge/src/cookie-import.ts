import { execFile } from "node:child_process";
import { createDecipheriv } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { copyFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

async function chromiumKey(userData: string): Promise<Buffer | undefined> {
  try {
    const state = JSON.parse(await readFile(join(userData, "Local State"), "utf8")) as {
      os_crypt?: { encrypted_key?: string };
    };
    const raw = Buffer.from(String(state.os_crypt?.encrypted_key ?? ""), "base64");
    if (raw.subarray(0, 5).toString() !== "DPAPI") return undefined;
    const body = raw.subarray(5).toString("base64");
    const script =
      "Add-Type -AssemblyName System.Security;$b=[Convert]::FromBase64String($env:BK_KEY);$e=[Text.Encoding]::UTF8.GetBytes('browserkit-cookies');$o=[Security.Cryptography.ProtectedData]::Unprotect($b,$e,[Security.Cryptography.DataProtectionScope]::CurrentUser);[Console]::Out.Write([Convert]::ToBase64String($o))";
    const { stdout } = await exec(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      { env: { ...process.env, BK_KEY: body }, maxBuffer: 1024 * 1024 },
    );
    return Buffer.from(stdout.trim(), "base64");
  } catch {
    return undefined;
  }
}

function decryptChromium(value: string, key: Buffer): string | undefined {
  try {
    const raw = Buffer.from(value, "base64");
    if (raw.subarray(0, 3).toString() !== "v10") return undefined;
    const nonce = raw.subarray(3, 15);
    const tag = raw.subarray(raw.length - 16);
    const data = raw.subarray(15, raw.length - 16);
    const decipher = createDecipheriv("aes-256-gcm", key, nonce);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
  } catch {
    return undefined;
  }
}

// Read cookies from another browser's profile without writing to it. The DB (and its WAL/SHM) is
// copied first because a running browser locks it. Values stay in memory and are never printed.
export interface ImportedCookie {
  domain: string;
  path: string;
  name: string;
  value: string;
  secure: boolean;
  httpOnly: boolean;
  expirationDate?: number;
  sameSite?: "no_restriction" | "lax" | "strict";
}

export interface CookieSource {
  from: "firefox" | "edge" | "brave" | "opera";
  profile: string;
  domains: string[];
  includeSession: boolean;
}

export async function readCookies(source: CookieSource): Promise<{
  cookies: ImportedCookie[];
  skippedV20: number;
  skippedEncrypted: number;
}> {
  const dbPath = profileDb(source.from, source.profile);
  const temp = await mkdtemp(join(tmpdir(), "bue-cookies-"));
  const db = join(temp, "cookies.sqlite");
  try {
    await copyFile(dbPath, db).catch(() => undefined);
    await copyFile(dbPath + "-wal", db + "-wal").catch(() => undefined);
    await copyFile(dbPath + "-shm", db + "-shm").catch(() => undefined);
    const sqlite = new DatabaseSync(db);
    try {
      if (source.from === "firefox") return firefox(sqlite, source.domains, source.includeSession);
      const root = join(dbPath, "..", "..", "..");
      return chromium(sqlite, source.domains, source.includeSession, await chromiumKey(root));
    } finally {
      sqlite.close();
    }
  } finally {
    await rm(temp, { recursive: true, force: true }).catch(() => undefined);
  }
}

export function profileDb(from: CookieSource["from"], profile: string): string {
  if (profile.includes("/") || profile.includes("\\")) return profile;
  if (from === "firefox") {
    const base = process.env.APPDATA
      ? join(process.env.APPDATA, "Mozilla", "Firefox", "Profiles")
      : "";
    return join(base, profile, "cookies.sqlite");
  }
  const local = process.env.LOCALAPPDATA ?? "";
  const roots: Record<string, string> = {
    edge: join(local, "Microsoft", "Edge", "User Data"),
    brave: join(local, "BraveSoftware", "Brave-Browser", "User Data"),
    opera: process.env.APPDATA ? join(process.env.APPDATA, "Opera Software", "Opera Stable") : "",
  };
  return join(roots[from] ?? "", profile, "Network", "Cookies");
}

function firefox(db: DatabaseSync, domains: string[], includeSession: boolean) {
  const rows = db
    .prepare(
      "SELECT host, path, name, value, expiry, isSecure, isHttpOnly, sameSite FROM moz_cookies",
    )
    .all() as Record<string, unknown>[];
  return {
    cookies: rows.flatMap((row) => {
      const cookie = fromRow(row, domains, includeSession);
      return cookie ? [cookie] : [];
    }),
    skippedV20: 0,
    skippedEncrypted: 0,
  };
}

async function chromium(
  db: DatabaseSync,
  domains: string[],
  includeSession: boolean,
  key?: Buffer,
) {
  const rows = db
    .prepare(
      "SELECT host_key, path, name, value, encrypted_value, expires_utc, is_secure, is_httponly, samesite, is_persistent FROM cookies",
    )
    .all() as Record<string, unknown>[];
  let skippedV20 = 0;
  let skippedEncrypted = 0;
  const cookies: ImportedCookie[] = [];
  for (const row of rows) {
    const encrypted = String(row.encrypted_value ?? "");
    const value = String(row.value ?? "");
    if (!value && encrypted.startsWith("v20")) {
      skippedV20++;
      continue;
    }
    if (!value && encrypted) {
      const plain = key ? decryptChromium(encrypted, key) : undefined;
      if (plain === undefined) {
        skippedEncrypted++;
        continue;
      }
      row.value = plain;
    }
    const cookie = fromRow(
      {
        ...row,
        host: row.host_key,
        expiry: chromiumExpiry(row.expires_utc),
        isSecure: row.is_secure,
        isHttpOnly: row.is_httponly,
      },
      domains,
      includeSession,
    );
    if (cookie) cookies.push(cookie);
  }
  return { cookies, skippedV20, skippedEncrypted };
}

function chromiumExpiry(value: unknown): number | undefined {
  const micros = Number(value);
  if (!micros) return undefined;
  return Math.floor(micros / 1_000_000 - 11_644_473_600);
}

function fromRow(
  row: Record<string, unknown>,
  domains: string[],
  includeSession: boolean,
): ImportedCookie | undefined {
  const domain = String(row.host ?? "").replace(/^\./, "");
  if (
    domains.length &&
    !domains.some((wanted) => domain === wanted || domain.endsWith("." + wanted))
  )
    return undefined;
  const expiry = Number(row.expiry ?? 0);
  if (!expiry && !includeSession) return undefined;
  const sameSite = { 0: "no_restriction", 1: "lax", 2: "strict" }[
    Number(row.sameSite ?? row.samesite)
  ] as ImportedCookie["sameSite"];
  return {
    domain: String(row.host ?? ""),
    path: String(row.path ?? "/"),
    name: String(row.name ?? ""),
    value: String(row.value ?? ""),
    secure: Boolean(row.isSecure),
    httpOnly: Boolean(row.isHttpOnly),
    ...(expiry ? { expirationDate: expiry } : {}),
    ...(sameSite ? { sameSite } : {}),
  };
}
