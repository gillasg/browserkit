import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

// The user's form profile: name, email, address and anything else they chose to keep for
// filling forms. It lives on this machine (profile.json in browserkit's home). Agent code sees
// field names only; the engine asks for the values while it fills a page and types them itself.
// Logins, card numbers and government IDs never go here: they belong to the password manager.

export type ProfileRequest =
  | { profile: "fields" }
  | { profile: "values"; keys: string[] }
  | { profile: "save"; values: Record<string, unknown> }
  | { profile: "remove"; name: string };

export const profilePath = (home: string): string => join(home, "profile.json");

export function isProfileRequest(value: unknown): value is ProfileRequest {
  const kind = (value as { profile?: unknown } | null)?.profile;
  return kind === "fields" || kind === "values" || kind === "save" || kind === "remove";
}

export async function readProfile(home: string): Promise<Record<string, string>> {
  try {
    const value = JSON.parse(await readFile(profilePath(home), "utf8")) as unknown;
    if (!value || typeof value !== "object") return {};
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    );
  } catch {
    return {};
  }
}

async function writeProfile(home: string, profile: Record<string, string>): Promise<void> {
  await mkdir(home, { recursive: true });
  await writeFile(profilePath(home), JSON.stringify(profile, null, 2) + "\n");
}

/** "Passport city" → "passportCity": the key the engine matches labels against. */
export function profileKey(name: string): string {
  const words = name
    .trim()
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((word) => word.toLowerCase());
  return words
    .map((word, index) => (index ? word[0]!.toUpperCase() + word.slice(1) : word))
    .join("");
}

const SECRET_KEY =
  /password|passcode|pin$|cvv|cvc|card(number)?$|cardNumber|iban|accountNumber|routing|ssn|socialSecurity|aadhaar|aadhar|pan(number)?$|passportNumber|licenseNumber|taxId|otp/i;

function luhn(digits: string): boolean {
  let sum = 0;
  for (let index = 0; index < digits.length; index++) {
    let digit = Number(digits[digits.length - 1 - index]);
    if (index % 2) digit = digit * 2 > 9 ? digit * 2 - 9 : digit * 2;
    sum += digit;
  }
  return sum % 10 === 0;
}

/** Why a value may not be kept in the profile, or undefined when it may. */
export function refusedProfileValue(key: string, value: string): string | undefined {
  if (SECRET_KEY.test(key))
    return "logins, card and bank numbers and government IDs belong in the password manager";
  const digits = value.replace(/[\s-]/g, "");
  if (/^\d{13,19}$/.test(digits) && luhn(digits)) return "that looks like a card number";
  if (value.length > 2000) return "too long for a form field";
  return undefined;
}

export async function saveProfileValues(
  home: string,
  values: Record<string, unknown>,
): Promise<{ saved: string[]; refused: { field: string; reason: string }[] }> {
  const profile = await readProfile(home);
  const saved: string[] = [];
  const refused: { field: string; reason: string }[] = [];
  for (const [name, raw] of Object.entries(values)) {
    const key = profileKey(name);
    const value = String(raw ?? "").trim();
    const reason = key ? refusedProfileValue(key, value) : "empty field name";
    if (reason) refused.push({ field: name, reason });
    else if (value) {
      profile[key] = value;
      saved.push(key);
    }
  }
  if (saved.length) await writeProfile(home, profile);
  return { saved, refused };
}

export async function removeProfileField(home: string, name: string): Promise<boolean> {
  const profile = await readProfile(home);
  const key = profileKey(name);
  if (!(key in profile)) return false;
  delete profile[key];
  await writeProfile(home, profile);
  return true;
}

/** The answer to a profile request. Only the engine may ask for values; it refuses cells that try. */
export async function handleProfileRequest(
  request: ProfileRequest,
  home: string,
): Promise<unknown> {
  if (request.profile === "fields") return { fields: Object.keys(await readProfile(home)) };
  if (request.profile === "save") return saveProfileValues(home, request.values ?? {});
  if (request.profile === "remove")
    return { removed: await removeProfileField(home, request.name) };
  const profile = await readProfile(home);
  const keys = Array.isArray(request.keys) ? request.keys.map(String) : [];
  return {
    values: Object.fromEntries(
      keys.filter((key) => key in profile).map((key) => [key, profile[key]]),
    ),
  };
}
