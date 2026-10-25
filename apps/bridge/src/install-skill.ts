import { existsSync, lstatSync, readdirSync, readlinkSync } from "node:fs";
import { mkdir, rmdir, symlink, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// browserkit setup links the skill where coding agents look for skills (~/.agents/skills, and
// ~/.claude/skills unless it already links there), so an agent started on this machine knows
// browserkit exists and how to use it. Safe to run again.

const cli = fileURLToPath(new URL("./cli.js", import.meta.url));

/** Every skill that ships beside the repo; a package install keeps them next to dist. */
function skillSources(): { name: string; path: string }[] {
  const bases = [
    resolve(dirname(cli), "..", "..", "..", "skills"),
    resolve(dirname(cli), "..", "skills"),
  ];
  for (const base of bases) {
    if (!existsSync(base)) continue;
    return readdirSync(base, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && existsSync(join(base, entry.name, "SKILL.md")))
      .map((entry) => ({ name: entry.name, path: join(base, entry.name) }));
  }
  return [];
}

/** Where the link already points, or undefined when nothing is there. */
function linkTarget(path: string): string | undefined {
  try {
    const stats = lstatSync(path);
    return stats.isSymbolicLink() ? resolve(dirname(path), readlinkSync(path)) : path;
  } catch {
    return undefined;
  }
}

/** Links folder/browserkit to source, replacing an older link (never a real folder someone made). */
async function linkSkill(folder: string, source: string): Promise<string | undefined> {
  // A skills folder that is itself a link (to ~/.agents/skills) already has the skill.
  const own = linkTarget(folder);
  if (own !== undefined && own !== folder) return undefined;
  const target = join(folder, "browserkit");
  const current = linkTarget(target);
  if (current !== undefined && current !== target) await unlink(target).catch(() => rmdir(target));
  else if (current === target) return target;
  await mkdir(folder, { recursive: true });
  await symlink(source, target, process.platform === "win32" ? "junction" : "dir");
  return target;
}

/** Installs every shipped skill; returns the paths linked, and nothing when none ship. */
export async function installSkill(): Promise<string[]> {
  const sources = skillSources();
  if (!sources.length) return [];
  const shared = join(homedir(), ".agents", "skills");
  const linked: string[] = [];
  for (const source of sources) {
    const agents = await linkSkill(shared, source.path);
    if (agents) linked.push(agents);
    // Claude Code reads ~/.claude/skills: link it to the shared copy.
    const claude = await linkSkill(join(homedir(), ".claude", "skills"), join(shared, source.name));
    if (claude) linked.push(claude);
  }
  return linked;
}
