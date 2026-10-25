import { COMMANDS } from "./index.js";
import { out } from "../output.js";
import { flag, has, type Args } from "../args.js";
import type { Command } from "../usage.js";

// Finding the right command: search names, summaries and help text. `browserkit help <topic>`
// covers the longer explanations.

async function search(args: Args): Promise<number> {
  const query = (flag(args, "find") ?? args.positional.join(" ")).trim().toLowerCase();
  // --summary is for a quick index: one line per command, nothing else.
  if (has(args, "summary")) {
    for (const command of COMMANDS) out(`${command.name}: ${command.summary}`);
    return 0;
  }
  if (!query) {
    for (const command of COMMANDS)
      out(`${command.name.padEnd(14)} ${command.group.padEnd(12)} ${command.summary}`);
    return 0;
  }
  const matches = COMMANDS.filter((command) =>
    `${command.name} ${command.group} ${command.summary} ${command.help}`
      .toLowerCase()
      .includes(query),
  ).map((command) => ({ name: command.name, group: command.group, summary: command.summary }));
  if (has(args, "json")) out(JSON.stringify(matches, null, 2));
  else if (!matches.length)
    out(`No command mentions ${JSON.stringify(query)}; browserkit commands lists them all.`);
  else
    for (const match of matches)
      out(`${match.name.padEnd(14)} ${match.group.padEnd(12)} ${match.summary}`);
  return 0;
}

export const commandsCommand: Command = {
  name: "commands",
  group: "Help",
  summary: "search every command by what it does",
  help: `Usage: browserkit commands [query] [--find <topic>] [--json]

Searches command names, summaries and help text. With no query, lists every command with its
group and summary. Topics with longer explanations: browserkit help <topic> (workflows, recipes,
sessions, network, readiness, cookies, surface).`,
  run: search,
};
