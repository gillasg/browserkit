import { mkdir, readdir, readFile, rm, writeFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

// Site skills: reusable browser_code helpers tied to sites, shared by every chat. A skill's
// code runs in the chat's REPL realm and usually defines functions built on page and bu.
export interface SiteSkill {
  name: string;
  domains: string[];
  description: string;
  examples: string;
  code: string;
  /** Imported skills are enabled, like every ability. */
  enabled?: boolean;
  updatedAt: number;
}
type Request =
  | { siteSkill: "list"; url?: string }
  | { siteSkill: "get"; name: string }
  | { siteSkill: "save"; skill: Partial<SiteSkill> }
  | { siteSkill: "delete"; name: string };

export function isSiteSkillRequest(value: unknown): value is Request {
  return typeof value === "object" && value !== null && "siteSkill" in value;
}

export async function siteSkillCall(directory: string, request: Request): Promise<unknown> {
  if (request.siteSkill === "list") {
    const host = hostOf(request.url);
    return (await all(directory))
      .filter((skill) => skill.enabled !== false)
      .filter((skill) => !host || skill.domains.some((domain) => matches(host, domain)))
      .map(({ name, domains, description }) => ({ name, domains, description }));
  }
  if (request.siteSkill === "get") {
    const skill = (await all(directory)).find(
      (item) => item.name === validName(request.name) && item.enabled !== false,
    );
    if (!skill) throw new Error(`SKILL_NOT_FOUND: ${request.name}`);
    return skill;
  }
  if (request.siteSkill === "delete") {
    await rm(join(directory, validName(request.name) + ".json"), { force: true });
    return { deleted: request.name };
  }
  const skill = validSkill(request.skill);
  await mkdir(directory, { recursive: true });
  const path = join(directory, skill.name + ".json");
  const temporary = path + "." + randomUUID() + ".tmp";
  await writeFile(temporary, JSON.stringify(skill, null, 2), { flag: "wx" });
  await rename(temporary, path);
  return { saved: skill.name, domains: skill.domains };
}

async function all(directory: string): Promise<SiteSkill[]> {
  const files = await readdir(directory).catch(() => [] as string[]);
  const skills = await Promise.all(
    files
      .filter((file) => file.endsWith(".json"))
      .map((file) =>
        readFile(join(directory, file), "utf8").then(
          (text) => JSON.parse(text) as SiteSkill,
          () => undefined,
        ),
      ),
  );
  return skills.filter((skill): skill is SiteSkill => !!skill?.name);
}

function validSkill(skill: Partial<SiteSkill> | undefined): SiteSkill {
  const domains = (skill?.domains ?? []).map((domain) => String(domain).toLowerCase().trim());
  if (
    !domains.length ||
    domains.length > 16 ||
    domains.some((d) => !/^(\*\.)?[a-z0-9.-]+$/.test(d))
  )
    throw new Error("Skill domains must be host names such as example.com or *.example.com");
  const text = (value: unknown, max: number, label: string) => {
    const result = typeof value === "string" ? value : "";
    if (result.length > max) throw new Error(`Skill ${label} exceeds ${max} characters`);
    return result;
  };
  const code = text(skill?.code, 64000, "code");
  if (!code.trim()) throw new Error("Skill code is required");
  return {
    name: validName(skill?.name),
    domains,
    description: text(skill?.description, 2000, "description"),
    examples: text(skill?.examples, 4000, "examples"),
    code,
    enabled: skill?.enabled !== false,
    updatedAt: Date.now(),
  };
}

function validName(name: unknown): string {
  if (typeof name !== "string" || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(name))
    throw new Error("Skill names use lowercase letters, digits and dashes");
  return name;
}

function hostOf(url: string | undefined): string | undefined {
  try {
    return url ? new URL(url).hostname.toLowerCase() : undefined;
  } catch {
    return undefined;
  }
}

function matches(host: string, domain: string): boolean {
  if (domain.startsWith("*.")) return host === domain.slice(2) || host.endsWith(domain.slice(1));
  return host === domain || host.endsWith("." + domain);
}

/** Every skill, including imported ones that are still disabled. */
export async function readSiteSkills(directory: string): Promise<SiteSkill[]> {
  return all(directory);
}

/** Saves skills from a site pack disabled; the user enables them explicitly. */
export async function importSiteSkills(
  directory: string,
  skills: Partial<SiteSkill>[],
): Promise<SiteSkill[]> {
  const saved: SiteSkill[] = [];
  for (const skill of skills) {
    const valid = validSkill({ ...skill, enabled: true });
    await writeSkill(directory, valid);
    saved.push(valid);
  }
  return saved;
}

export async function enableSiteSkills(directory: string, site: string): Promise<string[]> {
  const host = hostOf(site.includes("://") ? site : `https://${site}`);
  if (!host) throw new Error(`Not a site: ${site}`);
  const enabled: string[] = [];
  for (const skill of await all(directory)) {
    if (skill.enabled !== false || !skill.domains.some((domain) => matches(host, domain))) continue;
    await writeSkill(directory, { ...skill, enabled: true, updatedAt: Date.now() });
    enabled.push(skill.name);
  }
  return enabled;
}

async function writeSkill(directory: string, skill: SiteSkill): Promise<void> {
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, skill.name + ".json"), JSON.stringify(skill, null, 2) + "\n");
}
