// What runs learned about a site, kept in the site's pack next to its model and recipes. Small on
// purpose: a gate and the label that opened it, a referer the site requires, a play click, or a
// page function that answered. Every later session that opens the host starts with these notes.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { siteDir, siteName } from "./registry.js";

export interface LearnedNote {
  site: string;
  /** age | consent | terms | region | enter */
  gate?: string;
  /** The control that opened it, as it read on the page. */
  clicked?: string;
  /** A Referer the site requires for its player or API. */
  referer?: string;
  /** A play/watch click is needed before media is requested. */
  play?: boolean;
  /** Callable page globals that answered (page.functions()). */
  functions?: string[];
  note?: string;
  /** How many runs contributed. */
  runs: number;
  updatedAt: string;
}

function file(site: string): string {
  return join(siteDir(site), "learned.json");
}

export async function readLearned(site: string): Promise<LearnedNote | undefined> {
  try {
    return JSON.parse(await readFile(file(siteName(site)), "utf8")) as LearnedNote;
  } catch {
    return undefined;
  }
}

/** Merges one run's findings; a newer value wins, list values add up without duplicates. */
export async function learnAbout(
  site: string,
  patch: Partial<Omit<LearnedNote, "site" | "runs" | "updatedAt">>,
): Promise<LearnedNote> {
  const name = siteName(site);
  const previous = await readLearned(name);
  const next: LearnedNote = {
    site: name,
    ...(previous ?? { runs: 0, updatedAt: new Date().toISOString() }),
    ...Object.fromEntries(
      Object.entries(patch).filter(([, value]) => value !== undefined && value !== ""),
    ),
    runs: (previous?.runs ?? 0) + 1,
    updatedAt: new Date().toISOString(),
  };
  if (patch.functions?.length || previous?.functions?.length)
    next.functions = [
      ...new Set([...(previous?.functions ?? []), ...(patch.functions ?? [])]),
    ].slice(0, 40);
  await mkdir(siteDir(name), { recursive: true });
  await writeFile(file(name), JSON.stringify(next, null, 2) + "\n", "utf8");
  return next;
}

/** One line for a session that just opened the host; empty when nothing is known. */
export function learnedHint(note: LearnedNote | undefined): string {
  if (!note) return "";
  const parts: string[] = [];
  if (note.gate && note.gate !== "none")
    parts.push(
      "gate: " +
        note.gate +
        (note.clicked ? " (clicked " + JSON.stringify(note.clicked) + ")" : ""),
    );
  if (note.referer) parts.push("referer required: " + note.referer);
  if (note.play) parts.push("needs a play/watch click before media is requested");
  if (note.functions?.length)
    parts.push("page functions: " + note.functions.slice(0, 6).join(", "));
  if (note.note) parts.push(note.note);
  return parts.length ? "learned about " + note.site + ": " + parts.join("; ") : "";
}
