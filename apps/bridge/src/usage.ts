import type { Args } from "./args.js";

/** One browserkit command: what it is for, its own help, and what it does. */
export interface Command {
  name: string;
  group: string;
  summary: string;
  /** Printed by `browserkit <command> --help`. */
  help: string;
  /** Kept for callers but not listed in usage. */
  hidden?: boolean;
  run(args: Args): Promise<number>;
}

const PROGRAM = "browserkit";

/** Short answers for `browserkit help <topic>`, so the full explanation is a command away. */
export const HELP_TOPICS: Record<string, string> = {
  abilities: `Abilities (browserkit abilities *)
An ability is one named thing a site can do, read or write. It is tried as an API call/chain, a
saved replay of steps, page code or node code, in that order unless --via picks one. Abilities
carry inputs (JSON schema), run/failure stats and notes.md beside them in the site pack.
  browserkit abilities list [site]
  browserkit abilities show <site> <name>
  browserkit abilities run <site> <name> --inputs '{"q":"lamps"}'
Old recipes, actions, workflows and site tools migrate once into abilities; their command names
remain as hidden aliases for one release.`,
  sessions: `Sessions (browserkit sessions *)
A named session owns one quiet tab or its own window, runs its cells in the order sent, and
reports live tabs, busy cells and queued work. create/ensure/reopen/info/cleanup/delete; the name
and url survive a bridge restart. Writes across sessions are serialized by the engine.`,
  network: `Network store (browserkit network *)
Every finished request from every tab the session used is kept for an hour (bounded). Filter by
--match, --origin, --method, --type, --status, --static/--dynamic and --since; then get, body,
curl, origins, stats, clear, or export a HAR. Values like cookies are left out of curl unless
--secrets. Bodies exist only for calls captured while a tab was open.`,
  readiness: `Readiness (page.readiness / page.waitReady)
Returns ready, empty, loading, login, challenge, not-found or error with the evidence behind it.
"browserkit check <url> --ready" adds it to a site check.`,
  cookies: `Cookies (browserkit cookies *)
List, set, delete and clear by --domain or --url. Values are hidden unless --values; nothing is
sent anywhere.`,
  surface: `Browser surface (page.*)
page.html({stripScripts}) rendered HTML; page.state() url/title/scroll/forms/counts; page.find(text)
page search; page.styles(selector) computed styles; page.diagnoseFrames()/page.frame()/page.mainFrame();
page.extract({url, script, retries, rowKey, format}) deterministic read in a fresh tab;
page.collect({row, fields, scroll, expand, max, out}) rows with field specs; page.settle();
page.screenshot({fullPage, annotate, save}); page.emulateNetwork/emulateCPU/emulateViewport/touch;
page.abort(patterns)/abortClear(); page.animations()/performance()/iconTiles(); browser.windows.list/
resize/setZoom. Read shaping: bu.state({summary, all, includeHidden, noText, depth, compact, maxBytes}).`,
};

/** The help of one command, with the host's own program name when it is not browserkit. */
export function commandHelp(command: Command, program = PROGRAM): string {
  const help = command.help.trimEnd();
  return program === PROGRAM ? help : help.replace(/\bbrowserkit\b/g, program);
}

export function usageText(allCommands: Command[], program = PROGRAM): string {
  const commands = allCommands.filter((command) => !command.hidden);
  const groups = [...new Set(commands.map((command) => command.group))];
  const lines = [
    `${program}: let agents use your real Chrome, and turn sites into APIs and data.`,
    "",
    `  ${program} <command> [arguments] [--flags]`,
    `  ${program} <command> --help`,
    "",
  ];
  for (const group of groups) {
    lines.push(group);
    const width = Math.max(...commands.map((command) => command.name.length)) + 2;
    for (const command of commands.filter((item) => item.group === group))
      lines.push(`  ${command.name.padEnd(width)}${command.summary}`);
    lines.push("");
  }
  lines.push(`Run \`${program} <command> --help\` for the arguments and flags of one command.`);
  return lines.join("\n");
}
