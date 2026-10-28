// Writes that are safe to retry. A write remembers each key it ran under for a day (or the old
// receipt's ttlDays), so the same key never applies twice. A failure carries a code, whether the
// change may have reached the site (`write_status`, `possible_commit`) and what a retry needs
// (`retry`), and the runner never falls through to another way once one may have applied. A write
// can read the site back afterwards to confirm the change.

import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { abilityDirectory, type Ability } from "./abilities.js";
import { writeAtomic } from "./registry.js";

export type WriteStatus = "not_attempted" | "not_applied" | "may_have_applied" | "applied";
/**
 * never: check the outcome first and do not repeat the call as is. fix_input: correct the input
 * or the login, then call again. same_key: the call may be repeated as is. new_key: a repeat is a
 * new run, after reading the site back when possible_commit is true.
 */
export type RetryClass = "never" | "fix_input" | "same_key" | "new_key";
export type OutcomeCode =
  | "input_rejected"
  | "credentials_rejected"
  | "input_not_applied"
  | "no_response"
  | "outcome_unknown"
  | "execution_failed";

export interface WriteOutcome {
  code: OutcomeCode;
  write_status: WriteStatus;
  possible_commit: boolean;
  retry: RetryClass;
}

export interface ReadBack {
  /** A read ability on the same site. */
  ability: string;
  inputs?: Record<string, unknown>;
  /** Values (templated from the write's inputs) the read result must contain. */
  expect?: Record<string, unknown>;
}

export class AbilityWriteError extends Error {
  constructor(
    message: string,
    readonly outcome: WriteOutcome,
  ) {
    super(`${message} ${JSON.stringify(outcome)}`);
    this.name = "AbilityWriteError";
  }
}

interface KeyEntry {
  write_status: WriteStatus;
  at: string;
  result?: unknown;
}

type KeyFile = Record<string, Record<string, KeyEntry>>;

const KEYS = ".write-keys.json";
const DAY = 86_400_000;

function keyPath(site: string): string {
  return join(abilityDirectory(site), KEYS);
}

async function readKeys(site: string): Promise<KeyFile> {
  try {
    return JSON.parse(await readFile(keyPath(site), "utf8")) as KeyFile;
  } catch {
    return {};
  }
}

function keyTtl(ability: Ability): number {
  const write = ability.options.write as { ttlDays?: number } | undefined;
  return (write?.ttlDays && write.ttlDays > 0 ? write.ttlDays : 1) * DAY;
}

/** The key a write runs under: the caller's, or for old receipt writes, its inputs. */
export function writeKey(
  ability: Ability,
  inputs: Record<string, unknown>,
  key?: string,
): string | undefined {
  if (key) return key;
  if (ability.options.write) return "inputs:" + JSON.stringify(inputs);
  return undefined;
}

export async function findWriteKey(
  ability: Ability,
  key: string,
  now = Date.now(),
): Promise<KeyEntry | undefined> {
  const entry = (await readKeys(ability.site))[ability.name]?.[key];
  if (!entry || now - Date.parse(entry.at) > keyTtl(ability)) return undefined;
  return entry;
}

export async function recordWriteKey(
  ability: Ability,
  key: string,
  entry: Omit<KeyEntry, "at">,
): Promise<void> {
  const file = await readKeys(ability.site);
  const now = Date.now();
  const kept = Object.fromEntries(
    Object.entries(file[ability.name] ?? {}).filter(
      ([, value]) => now - Date.parse(value.at) <= keyTtl(ability),
    ),
  );
  file[ability.name] = { ...kept, [key]: { ...entry, at: new Date(now).toISOString() } };
  await mkdir(abilityDirectory(ability.site), { recursive: true });
  await writeAtomic(keyPath(ability.site), JSON.stringify(file, null, 2) + "\n");
}

/**
 * The answer to a key already used: an applied one returns its result without running again; one
 * that may have applied refuses until the caller has checked the site. Undefined: run it.
 */
export function answerRepeat(
  ability: Ability,
  key: string,
  entry: KeyEntry,
): { result: unknown } | undefined {
  if (entry.write_status === "applied") return { result: entry.result };
  if (entry.write_status === "may_have_applied")
    throw new AbilityWriteError(
      `WRITE_UNCERTAIN: ${ability.site} ${ability.name} under key ${key} may already have applied at ${entry.at}; ` +
        "read the site back, and call again with a new key only if the change is absent.",
      {
        code: "outcome_unknown",
        write_status: "may_have_applied",
        possible_commit: true,
        retry: "new_key",
      },
    );
  return undefined;
}

const NOT_SENT =
  /No (site API transport|browser is attached|workflow runtime)|has no operation|ABILITY_BAD|SITE_BLOCKED|not mapped/i;
const SIGNED_OUT = /\b401\b|signed[- ]out|unauthori[sz]ed|session expired|Challenged/i;
const REJECTED = /\b(400|404|405|409|410|422)\b|invalid|required|not allowed|forbidden|\b403\b/i;
const NO_RESPONSE =
  /timed? ?out|ETIMEDOUT|ECONNRESET|socket hang up|network|fetch failed|\b50[234]\b/i;

/** How a failed way left the site, from where it failed and what the error says. */
export function classifyFailure(error: unknown, reachedCommit: boolean): WriteOutcome {
  const message = error instanceof Error ? error.message : String(error);
  if (NOT_SENT.test(message))
    return outcome("execution_failed", "not_attempted", false, "same_key");
  if (SIGNED_OUT.test(message))
    return outcome(
      "credentials_rejected",
      reachedCommit ? "not_applied" : "not_attempted",
      false,
      "fix_input",
    );
  if (REJECTED.test(message))
    return outcome(
      "input_rejected",
      reachedCommit ? "not_applied" : "not_attempted",
      false,
      "fix_input",
    );
  if (!reachedCommit) return outcome("execution_failed", "not_applied", false, "same_key");
  if (NO_RESPONSE.test(message)) return outcome("no_response", "may_have_applied", true, "new_key");
  return outcome("outcome_unknown", "may_have_applied", true, "never");
}

function outcome(
  code: OutcomeCode,
  write_status: WriteStatus,
  possible_commit: boolean,
  retry: RetryClass,
): WriteOutcome {
  return { code, write_status, possible_commit, retry };
}

function contains(haystack: unknown, needle: unknown): boolean {
  if (needle === undefined || needle === null) return true;
  return JSON.stringify(haystack ?? "")
    .toLowerCase()
    .includes(String(needle).toLowerCase());
}

/** Reads the site back after a write and says whether the expected values are there. */
export async function readBack(
  rule: ReadBack,
  inputs: Record<string, unknown>,
  run: (name: string, inputs: Record<string, unknown>) => Promise<unknown>,
  fill: (value: unknown, inputs: Record<string, unknown>) => unknown,
): Promise<{ ok: boolean; missing: string[]; value?: unknown }> {
  try {
    const value = await run(
      rule.ability,
      fill(rule.inputs ?? {}, inputs) as Record<string, unknown>,
    );
    const expect = fill(rule.expect ?? {}, inputs) as Record<string, unknown>;
    const missing = Object.entries(expect)
      .filter(([, wanted]) => !contains(value, wanted))
      .map(([field]) => field);
    return { ok: !missing.length, missing, value };
  } catch (error) {
    return { ok: false, missing: [error instanceof Error ? error.message : String(error)] };
  }
}
