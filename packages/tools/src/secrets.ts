// Named secret profiles: the sign-in headers, cookies and web storage a host sees, kept in one
// encrypted file per name under BROWSERKIT_HOME/secrets. On Windows the blob is protected with
// DPAPI for the current user through PowerShell's ProtectedData, so another account cannot read
// it and there is no key to lose. Elsewhere a random 32-byte key sits next to the profiles with
// mode 0600. Values are only decrypted while a script runs and are scrubbed from its output.

import { spawn } from "node:child_process";
import { randomBytes, createCipheriv, createDecipheriv } from "node:crypto";
import { chmod, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { bridgeDataDirectory } from "@browserkit/site-mapper";

const FORMAT = 1;
const ENTROPY = "browserkit-secrets-v1";
const MAX_PROFILE = 2_000_000;
const NAME = /^[a-z][a-z0-9_-]{0,63}$/i;

export interface SecretCookie {
  name: string;
  value: string;
  domain: string;
  path?: string;
  expires?: number;
  secure?: boolean;
  httpOnly?: boolean;
  [key: string]: unknown;
}

export interface SecretValues {
  site: string;
  savedAt: string;
  headers: Record<string, string>;
  cookies: SecretCookie[];
  localStorage?: Record<string, Record<string, string>>;
  sessionStorage?: Record<string, Record<string, string>>;
}

export interface SecretProfile {
  name: string;
  site: string;
  savedAt: string;
  cipher: string;
  values: SecretValues;
}

export interface SecretMeta {
  name: string;
  site: string;
  savedAt: string;
  cipher: string;
}

export interface SecretRequest {
  secrets: {
    action: "save" | "list" | "run" | "delete";
    name?: unknown;
    script?: unknown;
    values?: unknown;
  };
}

export function isSecretRequest(value: unknown): value is SecretRequest {
  return Boolean(value && typeof (value as { secrets?: unknown }).secrets === "object");
}

export interface SecretCipher {
  name: string;
  encrypt(text: string): Promise<string>;
  decrypt(payload: string): Promise<string>;
}

let cipherForTests: SecretCipher | undefined;

/** Tests replace the platform cipher so they do not need the user's DPAPI key. */
export function setSecretCipherForTests(cipher: SecretCipher | undefined): void {
  cipherForTests = cipher;
}

export function secretsDirectory(home = bridgeDataDirectory()): string {
  return join(home, "secrets");
}

export async function saveSecretProfile(
  name: string,
  values: SecretValues,
  home = bridgeDataDirectory(),
): Promise<SecretMeta> {
  assertName(name);
  const directory = secretsDirectory(home);
  await mkdir(directory, { recursive: true });
  const cipher = cipherForTests ?? (await platformCipher(directory));
  const text = JSON.stringify(values);
  if (Buffer.byteLength(text) > MAX_PROFILE)
    throw new Error(`SECRET_TOO_LARGE: ${name} exceeds ${MAX_PROFILE} bytes`);
  const payload = await cipher.encrypt(text);
  const meta: SecretMeta = {
    name,
    site: values.site,
    savedAt: values.savedAt,
    cipher: cipher.name,
  };
  await writeFile(
    join(directory, `${name}.json`),
    JSON.stringify({ format: FORMAT, ...meta, payload }, null, 2) + "\n",
    {
      mode: 0o600,
    },
  );
  return meta;
}

export async function readSecretProfile(
  name: string,
  home = bridgeDataDirectory(),
): Promise<SecretProfile> {
  assertName(name);
  const path = join(secretsDirectory(home), `${name}.json`);
  let file: {
    format?: unknown;
    site?: unknown;
    savedAt?: unknown;
    cipher?: unknown;
    payload?: unknown;
  };
  try {
    file = JSON.parse(await readFile(path, "utf8")) as typeof file;
  } catch {
    throw new Error(`SECRET_PROFILE_MISSING: no secret profile ${name}`);
  }
  if (file.format !== FORMAT || typeof file.payload !== "string")
    throw new Error(`SECRET_PROFILE_INVALID: ${name} is not a secret profile`);
  const cipher = cipherForTests ?? (await platformCipher(secretsDirectory(home)));
  const values = JSON.parse(await cipher.decrypt(file.payload)) as SecretValues;
  return {
    name,
    site: String(file.site ?? values.site ?? ""),
    savedAt: String(file.savedAt ?? values.savedAt ?? ""),
    cipher: String(file.cipher ?? cipher.name),
    values,
  };
}

export async function listSecretProfiles(home = bridgeDataDirectory()): Promise<SecretMeta[]> {
  let names: string[];
  try {
    names = (await readdir(secretsDirectory(home))).filter((name) => name.endsWith(".json"));
  } catch {
    return [];
  }
  const out: SecretMeta[] = [];
  for (const name of names)
    try {
      const file = JSON.parse(await readFile(join(secretsDirectory(home), name), "utf8")) as {
        name?: unknown;
        site?: unknown;
        savedAt?: unknown;
        cipher?: unknown;
      };
      out.push({
        name: String(file.name ?? name.replace(/\.json$/, "")),
        site: String(file.site ?? ""),
        savedAt: String(file.savedAt ?? ""),
        cipher: String(file.cipher ?? ""),
      });
    } catch {
      // A broken profile is listed by name so it can be deleted; it never breaks the others.
      out.push({ name: name.replace(/\.json$/, ""), site: "", savedAt: "", cipher: "invalid" });
    }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export async function deleteSecretProfile(
  name: string,
  home = bridgeDataDirectory(),
): Promise<boolean> {
  assertName(name);
  try {
    await rm(join(secretsDirectory(home), `${name}.json`));
    return true;
  } catch {
    return false;
  }
}

/** Runs a Node script with the profile's values in BK_* variables and scrubs them from output. */
export async function runSecretScript(
  name: string,
  script: string,
  home = bridgeDataDirectory(),
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  const profile = await readSecretProfile(name, home);
  const values = secretValues(profile.values);
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const [key, value] of Object.entries(values)) env[`BK_${key}`] = value;
  const result = await runNode(script, env);
  return {
    stdout: redactSecrets(result.stdout, profile.values),
    stderr: redactSecrets(result.stderr, profile.values),
    code: result.code,
  };
}

export function redactSecrets(text: string, values: SecretValues): string {
  const secrets = secretStrings(values).sort((a, b) => b.length - a.length);
  let out = text;
  for (const secret of secrets) {
    if (!secret) continue;
    out = out.split(secret).join("[REDACTED]");
    const json = JSON.stringify(secret).slice(1, -1);
    if (json && json !== secret) out = out.split(json).join("[REDACTED]");
  }
  return out;
}

export async function captureSecretValues(site: string): Promise<SecretValues> {
  const { loadModel, readSession } = await import("@browserkit/site-mapper");
  const model = await loadModel(site);
  const session = model
    ? (await (await import("@browserkit/site-mapper")).exportSession(model)).session
    : await readSession(site);
  if (!session) throw new Error(`NO_SESSION: no exported session for ${site}; export one first`);
  return {
    site,
    savedAt: new Date().toISOString(),
    headers: {},
    cookies: session.cookies as SecretCookie[],
    ...(session.localStorage ? { localStorage: session.localStorage } : {}),
    ...(session.sessionStorage ? { sessionStorage: session.sessionStorage } : {}),
  };
}

async function platformCipher(directory: string): Promise<SecretCipher> {
  if (process.platform === "win32") return dpapiCipher();
  return keyFileCipher(directory);
}

function dpapiCipher(): SecretCipher {
  return {
    name: "dpapi",
    async encrypt(text) {
      return protect(Buffer.from(text, "utf8").toString("base64"), false);
    },
    async decrypt(payload) {
      return Buffer.from(await protect(payload, true), "base64").toString("utf8");
    },
  };
}

function protect(input: string, unprotect: boolean): Promise<string> {
  const method = unprotect ? "Unprotect" : "Protect";
  const script = [
    "Add-Type -AssemblyName System.Security",
    "$raw = [Console]::In.ReadToEnd()",
    "$data = [Convert]::FromBase64String($raw)",
    `$entropy = [Text.Encoding]::UTF8.GetBytes('${ENTROPY}')`,
    `$out = [Security.Cryptography.ProtectedData]::${method}($data, $entropy, [Security.Cryptography.DataProtectionScope]::CurrentUser)`,
    "[Console]::Out.Write([Convert]::ToBase64String($out))",
  ].join("\n");
  return runProcess("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], input);
}

async function keyFileCipher(directory: string): Promise<SecretCipher> {
  const key = await readKey(directory);
  return {
    name: "keyfile",
    async encrypt(text) {
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      const data = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
      return JSON.stringify({
        iv: iv.toString("base64"),
        tag: cipher.getAuthTag().toString("base64"),
        data: data.toString("base64"),
      });
    },
    async decrypt(payload) {
      const value = JSON.parse(payload) as { iv: string; tag: string; data: string };
      const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(value.iv, "base64"));
      decipher.setAuthTag(Buffer.from(value.tag, "base64"));
      return Buffer.concat([
        decipher.update(Buffer.from(value.data, "base64")),
        decipher.final(),
      ]).toString("utf8");
    },
  };
}

async function readKey(directory: string): Promise<Buffer> {
  const path = join(directory, ".key");
  try {
    const key = await readFile(path);
    if (key.length === 32) return key;
  } catch {
    // create below
  }
  await mkdir(directory, { recursive: true });
  const key = randomBytes(32);
  await writeFile(path, key, { mode: 0o600 });
  await chmod(path, 0o600).catch(() => undefined);
  return key;
}

function secretValues(values: SecretValues): Record<string, string> {
  const out: Record<string, string> = {
    SITE: values.site,
    HEADERS: JSON.stringify(values.headers),
    COOKIES: JSON.stringify(values.cookies),
  };
  for (const [key, value] of Object.entries(values.headers))
    out[key.toUpperCase().replace(/[^A-Z0-9]+/g, "_")] = value;
  for (const cookie of values.cookies)
    out[cookie.name.toUpperCase().replace(/[^A-Z0-9]+/g, "_")] = cookie.value;
  return out;
}

function secretStrings(values: SecretValues): string[] {
  return [
    ...Object.values(values.headers),
    ...values.cookies.map((cookie) => cookie.value),
    ...Object.values(values.localStorage ?? {}).flatMap((origin) => Object.values(origin)),
    ...Object.values(values.sessionStorage ?? {}).flatMap((origin) => Object.values(origin)),
  ].filter((value): value is string => typeof value === "string" && value.length > 0);
}

function runNode(
  script: string,
  env: NodeJS.ProcessEnv,
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["-"], { env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      stderr += "\n[SECRET_SCRIPT_TIMEOUT]";
      child.kill();
    }, 60_000);
    child.stdout.on("data", (chunk: Buffer) => (stdout = addOutput(stdout, chunk)));
    child.stderr.on("data", (chunk: Buffer) => (stderr = addOutput(stderr, chunk)));
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code });
    });
    child.stdin.end(script);
  });
}

function addOutput(current: string, chunk: Buffer): string {
  if (current.length > 1_000_000) return current;
  return (current + chunk.toString()).slice(0, 1_000_000);
}

function runProcess(command: string, args: string[], input: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(stdout.trim());
      else
        reject(new Error(`SECRET_CIPHER_FAILED: ${stderr.trim().slice(0, 400) || `exit ${code}`}`));
    });
    child.stdin.end(input);
  });
}

function assertName(name: string): void {
  if (!NAME.test(name)) throw new Error(`SECRET_PROFILE_INVALID: bad profile name ${name}`);
}
