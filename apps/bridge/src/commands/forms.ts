import { browserkitHome } from "@browserkit/tools/host";
import { readProfile, removeProfileField, saveProfileValues } from "@browserkit/tools/profile";
import { has, type Args } from "../args.js";
import { out, printJson } from "../output.js";
import type { Command } from "../usage.js";

// The form profile bu.fillProfile() fills pages from: name, email, address and anything else the
// user keeps. Listing shows field names; --values shows what is stored, for the user only.

async function forms(args: Args): Promise<number> {
  const [action = "list", ...rest] = args.positional;
  const home = browserkitHome();
  if (action === "set") return setFields(home, rest);
  if (action === "remove") {
    const name = rest[0];
    if (!name) throw new Error("Usage: browserkit forms remove <field>");
    out((await removeProfileField(home, name)) ? `Removed ${name}.` : `No field ${name}.`);
    return 0;
  }
  if (action !== "list") throw new Error(`Unknown forms action: ${action}`);
  const profile = await readProfile(home);
  const shown = has(args, "values") ? profile : Object.keys(profile);
  if (has(args, "json")) printJson(shown);
  else if (!Object.keys(profile).length) out("The form profile is empty.");
  else if (Array.isArray(shown)) for (const name of shown) out(name);
  else for (const [name, value] of Object.entries(shown)) out(`${name}\t${value}`);
  return 0;
}

async function setFields(home: string, pairs: string[]): Promise<number> {
  const values: Record<string, string> = {};
  for (const pair of pairs) {
    const at = pair.indexOf("=");
    if (at < 1) throw new Error("Usage: browserkit forms set <field>=<value> ...");
    values[pair.slice(0, at)] = pair.slice(at + 1);
  }
  const { saved, refused } = await saveProfileValues(home, values);
  if (saved.length) out(`Saved ${saved.join(", ")}.`);
  for (const item of refused) out(`Not saved ${item.field}: ${item.reason}.`);
  return refused.length && !saved.length ? 2 : 0;
}

export const formsCommand: Command = {
  name: "forms",
  group: "Sign in",
  summary: "the form profile agents fill forms from",
  help: `Usage: browserkit forms [list] [--values] [--json]
       browserkit forms set <field>=<value> ...
       browserkit forms remove <field>

Agents fill forms with bu.fillProfile(): they see field names (firstName, email, address1,
city, postalCode, phone, company, linkedin, or any name you choose) and never the values.
Logins, card and bank numbers and government IDs are refused; keep them in your password
manager. The profile lives in profile.json in browserkit's data folder.`,
  run: forms,
};
