import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { createRedactor, SECRET_HEADERS, SECRET_KEYS } from "./redact.js";
import { siteDir, siteName } from "./registry.js";

// A site pack is a zip of everything needed to use a mapped site on another machine: the model,
// spec and client, the recorded flows, and the browser skills and boosts written for it. Export
// strips sessions, cookies and credential-bearing headers/bodies; import writes the site files but
// hands the skills and boosts back to the caller to save disabled, because their code runs in the
// user's browser.

export const PACK_FORMAT = "browserkit-site-pack";
export const PACK_VERSION = 1;
const TOP_FILES = [
  "model.json",
  "openapi.json",
  "openapi.yaml",
  "client.ts",
  "overrides.json",
  "actions.json",
  "recipes.json",
  "health.json",
  "docs.md",
];
const SKIP = /^(sessions?|cookies?|storage|auth|credentials?|versions?|\.git)$/i;

export interface PackSkill {
  name: string;
  domains: string[];
  description?: string;
  examples?: string;
  code: string;
  enabled?: boolean;
  updatedAt?: number;
}

export interface PackBoost {
  id?: string;
  name: string;
  sites?: unknown[];
  css?: string;
  zaps?: unknown[];
  actions?: unknown[];
  network?: unknown;
  js?: string;
  enabled?: boolean;
  [key: string]: unknown;
}

export interface PackManifest {
  format: typeof PACK_FORMAT;
  version: typeof PACK_VERSION;
  site: string;
  exportedAt: string;
  files: string[];
  skills: string[];
  boosts: string[];
}

export interface PackExport {
  site: string;
  out: string;
  files: string[];
  skills: string[];
  boosts: string[];
}

export interface SitePack {
  manifest: PackManifest;
  /** Site files only, by pack-relative path. Skills and boosts are separate. */
  files: Map<string, string>;
  skills: PackSkill[];
  boosts: PackBoost[];
}

export async function exportSitePack(options: {
  site: string;
  out: string;
  skills?: PackSkill[];
  boosts?: PackBoost[];
}): Promise<PackExport> {
  const site = siteName(options.site);
  const root = siteDir(site);
  if (!existsSync(join(root, "model.json")))
    throw new Error(`No mapped site ${site}. Map it first (browserkit map).`);
  const redactor = createRedactor();
  const files: Record<string, Uint8Array> = {};
  const written: string[] = [];
  const add = (path: string, text: string) => {
    files[path] = strToU8(text);
    written.push(path);
  };
  for (const name of TOP_FILES) {
    const path = join(root, name);
    if (!existsSync(path)) continue;
    add(name, scrubFile(name, await readFile(path, "utf8"), redactor));
  }
  for (const name of await flowFiles(join(root, "flows"))) {
    const path = join(root, "flows", name);
    add(`flows/${name}`, scrubFile(name, await readFile(path, "utf8"), redactor));
  }
  const skills = (options.skills ?? []).map(sanitizeSkill);
  for (const skill of skills)
    add(`skills/${skill.name}.json`, JSON.stringify(skill, null, 2) + "\n");
  const boosts = (options.boosts ?? []).map(sanitizeBoost);
  boosts.forEach((boost, index) =>
    add(
      `boosts/${slug(boost.name || boost.id || `boost-${index + 1}`)}.json`,
      JSON.stringify(boost, null, 2) + "\n",
    ),
  );
  const manifest: PackManifest = {
    format: PACK_FORMAT,
    version: PACK_VERSION,
    site,
    exportedAt: new Date().toISOString(),
    files: written.filter((path) => !path.startsWith("skills/") && !path.startsWith("boosts/")),
    skills: skills.map((skill) => skill.name),
    boosts: boosts.map((boost) => String(boost.name ?? boost.id ?? "")),
  };
  add("pack.json", JSON.stringify(manifest, null, 2) + "\n");
  await mkdir(dirname(resolve(options.out)), { recursive: true });
  await writeFile(resolve(options.out), Buffer.from(zipSync(files, { level: 6 })));
  return {
    site,
    out: resolve(options.out),
    files: manifest.files,
    skills: manifest.skills,
    boosts: manifest.boosts,
  };
}

export async function readSitePack(file: string): Promise<SitePack> {
  const entries = await readZip(file);
  const paths = Object.keys(entries);
  for (const path of paths) safePath(path);
  const manifest = readManifest(entries);
  return {
    manifest,
    files: siteFiles(entries, paths),
    skills: jsonEntries<PackSkill>(entries, paths, /^skills\/[^/]+\.json$/, (item) => {
      return typeof item.name === "string" && typeof item.code === "string";
    }),
    boosts: jsonEntries<PackBoost>(entries, paths, /^boosts\/[^/]+\.json$/, (item) => {
      return typeof item.name === "string";
    }),
  };
}

async function readZip(file: string): Promise<Record<string, Uint8Array>> {
  try {
    return unzipSync(new Uint8Array(await readFile(file)));
  } catch {
    throw new Error(`${file} is not a zip file.`);
  }
}

function readManifest(entries: Record<string, Uint8Array>): PackManifest {
  const manifestText = text(entries["pack.json"]);
  if (!manifestText) throw new Error("The pack has no pack.json.");
  const manifest = JSON.parse(manifestText) as PackManifest;
  if (manifest.format !== PACK_FORMAT || manifest.version !== PACK_VERSION)
    throw new Error(`Unsupported pack format ${String(manifest.format)}.`);
  const site = siteName(String(manifest.site ?? ""));
  if (!/^[a-z0-9.-]+$/.test(site)) throw new Error("The pack has no valid site name.");
  return { ...manifest, site };
}

function siteFiles(entries: Record<string, Uint8Array>, paths: string[]): Map<string, string> {
  const files = new Map<string, string>();
  for (const path of paths) {
    if (path === "pack.json" || path.startsWith("skills/") || path.startsWith("boosts/")) continue;
    files.set(path, text(entries[path]) ?? "");
  }
  return files;
}

function jsonEntries<T>(
  entries: Record<string, Uint8Array>,
  paths: string[],
  pattern: RegExp,
  valid: (item: T) => boolean,
): T[] {
  return paths
    .filter((name) => pattern.test(name))
    .map((path) => JSON.parse(text(entries[path]) ?? "{}") as T)
    .filter(valid)
    .map((item) => ({ ...item, enabled: false }));
}

/** Writes the site files; the caller saves skills and boosts disabled. */
export async function installSitePack(
  pack: SitePack,
  site = pack.manifest.site,
): Promise<{ site: string; written: string[] }> {
  const name = siteName(site);
  const target = siteDir(name);
  const written: string[] = [];
  for (const [path, content] of pack.files) {
    const relative = safePath(path);
    const full = resolve(target, relative);
    if (!full.startsWith(resolve(target) + (process.platform === "win32" ? "\\" : "/")))
      throw new Error(`The pack contains an unsafe path: ${path}`);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, content);
    written.push(relative);
  }
  return { site: name, written };
}

/** Skills whose domains cover the site. */
export function skillsForSite(skills: PackSkill[], site: string): PackSkill[] {
  const host = siteName(site);
  return skills.filter((skill) =>
    (skill.domains ?? []).some((domain) => {
      const clean = String(domain).toLowerCase();
      return clean.startsWith("*.")
        ? host === clean.slice(2) || host.endsWith(clean.slice(1))
        : host === clean || host.endsWith("." + clean);
    }),
  );
}

function scrubFile(
  name: string,
  text: string,
  redactor: ReturnType<typeof createRedactor>,
): string {
  if (/\.(json|har)$/i.test(name)) {
    try {
      const value = JSON.parse(text) as unknown;
      return JSON.stringify(scrubValue(value, redactor), null, 2) + "\n";
    } catch {
      return scrubText(text, redactor);
    }
  }
  return scrubText(text, redactor);
}

function scrubValue(value: unknown, redactor: ReturnType<typeof createRedactor>): unknown {
  if (Array.isArray(value)) return value.map((item) => scrubValue(item, redactor));
  if (value && typeof value === "object")
    return scrubObject(value as Record<string, unknown>, redactor);
  return typeof value === "string" ? redactor.text(redactor.body(value) ?? value) : value;
}

function scrubObject(
  value: Record<string, unknown>,
  redactor: ReturnType<typeof createRedactor>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, scrubField(key, item, redactor)]),
  );
}

function scrubField(
  key: string,
  item: unknown,
  redactor: ReturnType<typeof createRedactor>,
): unknown {
  if (/^cookies?$/i.test(key)) return [];
  if (/^(local|session)storage$/i.test(key)) return {};
  if (/^headers?$/i.test(key)) return scrubHeaders(item, redactor);
  if (SECRET_KEYS.test(key) && (item === null || typeof item !== "object")) return "<redacted>";
  return scrubValue(item, redactor);
}

function scrubHeaders(value: unknown, redactor: ReturnType<typeof createRedactor>): unknown {
  if (Array.isArray(value))
    return value.map((header) => {
      if (!header || typeof header !== "object") return header;
      const item = header as { name?: unknown; value?: unknown };
      return {
        ...item,
        value:
          typeof item.name === "string"
            ? redactor.header(item.name, String(item.value ?? ""))
            : "<redacted>",
      };
    });
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([name, item]) => [
        name,
        SECRET_HEADERS.test(name) ? "<redacted>" : redactor.text(String(item)),
      ]),
    );
  return value;
}

function scrubText(text: string, redactor: ReturnType<typeof createRedactor>): string {
  return text
    .split(/\r?\n/)
    .map((line) => {
      const match = /^(\s*)([A-Za-z][\w-]*):\s*(.+)$/.exec(line);
      if (match && match[2] && SECRET_HEADERS.test(match[2]))
        return `${match[1] ?? ""}${match[2]}: <redacted>`;
      return redactLiterals(redactor.text(line));
    })
    .join("\n");
}

/** `const token = "..."`, `password: "..."`, `authorization: '...'` in code or examples. */
const SECRET_LITERAL =
  /(\b(?:token|secret|password|passwd|api[_-]?key|session(?:id)?|authorization)\b\s*[:=]\s*)(['"`])([^'"`\n]+)\2/gi;

function redactLiterals(text: string): string {
  return text
    .replace(SECRET_LITERAL, "$1$2<redacted>$2")
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, "$1 <redacted>")
    .replace(/\b(sk|ghp|gho|ghu|ghs|xox[baprs])[-_][A-Za-z0-9_-]{16,}/g, "<redacted>");
}

function sanitizeSkill(skill: PackSkill): PackSkill {
  const redactor = createRedactor();
  return {
    name: String(skill.name),
    domains: (skill.domains ?? []).map((domain) => String(domain)),
    description: redactor.text(String(skill.description ?? "")),
    examples: redactLiterals(redactor.text(String(skill.examples ?? ""))),
    code: redactLiterals(redactor.text(String(skill.code ?? ""))),
    enabled: false,
    updatedAt: Number(skill.updatedAt ?? Date.now()),
  };
}

function sanitizeBoost(boost: PackBoost): PackBoost {
  const redactor = createRedactor();
  const copy: PackBoost = { ...boost, enabled: false };
  delete copy.values;
  delete copy.settings;
  delete copy.health;
  delete copy.history;
  if (typeof copy.js === "string") copy.js = redactLiterals(redactor.text(copy.js));
  if (typeof copy.css === "string") copy.css = redactor.text(copy.css);
  return copy;
}

async function flowFiles(folder: string): Promise<string[]> {
  if (!existsSync(folder)) return [];
  const names = await readdir(folder);
  return names.filter((name) => !SKIP.test(name) && !name.endsWith(".tmp")).sort();
}

function safePath(path: string): string {
  const normal = path.replaceAll("\\", "/");
  if (normal.startsWith("/") || /^[a-z]:/i.test(normal) || normal.split("/").includes(".."))
    throw new Error(`Unsafe path in pack: ${path}`);
  return normal;
}

function text(value: Uint8Array | undefined): string | undefined {
  return value ? strFromU8(value) : undefined;
}

function slug(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9.-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "boost"
  );
}
