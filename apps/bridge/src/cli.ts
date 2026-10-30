#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { closeSharedBridge as closeCrawlBridge } from "@browserkit/tools/browser-crawl";
import { closeSharedBridge, errorKind } from "@browserkit/tools/site-to-api";
import { has, parseArgs } from "./args.js";
import { COMMANDS } from "./commands/index.js";
import { runNativeHost } from "./native-host.js";
import { printError, out } from "./output.js";
import { commandHelp, usageText, HELP_TOPICS } from "./usage.js";
/** Exit codes callers can act on: 2 needs input, 3 signed out, 4 no browser, 5 the API failed. */
const EXIT_CODES: Record<string, number> = {
  failed: 1,
  "missing-input": 2,
  "signed-out": 3,
  "browser-offline": 4,
  broken: 5,
  challenged: 6,
};

const HELP = new Set(["help", "--help", "-h"]);
const VERSION = new Set(["version", "--version", "-v"]);

function printVersion(): number {
  const manifest = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  ) as {
    version?: string;
  };
  out(`browserkit ${manifest.version ?? "unknown"}`);
  return 0;
}

async function main(argv: string[]): Promise<number> {
  // Chrome launches the native host with the calling extension's origin as the first argument.
  if (argv[0]?.startsWith("chrome-extension://")) {
    await runNativeHost();
    return 0;
  }
  if (VERSION.has(argv[0] ?? "")) return printVersion();
  if (HELP.has(argv[0] ?? "")) return printHelp(argv.slice(1));
  const args = parseArgs(argv);
  const [name, ...rest] = args.positional;
  const command = COMMANDS.find((item) => item.name === name);
  if (!command) {
    out(usageText(COMMANDS));
    return name ? 1 : 0;
  }
  if (has(args, "help")) {
    out(commandHelp(command));
    return 0;
  }
  return command.run({ ...args, positional: rest });
}

function printHelp(rest: string[]): number {
  const name = rest[0];
  const command = name ? COMMANDS.find((item) => item.name === name) : undefined;
  if (command) {
    out(commandHelp(command));
    return 0;
  }
  if (name && HELP_TOPICS[name]) {
    out(HELP_TOPICS[name] as string);
    return 0;
  }
  out(usageText(COMMANDS));
  const topics = Object.keys(HELP_TOPICS).sort().join(", ");
  out(`\nTopics: ${topics}\nRun \`browserkit help <topic>\` for one.`);
  return name ? 1 : 0;
}

main(process.argv.slice(2)).then(
  async (code) => {
    await Promise.all([closeSharedBridge(), closeCrawlBridge()]);
    process.exit(code);
  },
  async (error: unknown) => {
    const soft = process.argv.includes("--soft-fail");
    const json = process.argv.includes("--json");
    if (json) {
      out(
        JSON.stringify({
          ok: false,
          error: {
            message: error instanceof Error ? error.message : String(error),
            kind: errorKind(error),
          },
        }),
      );
    } else {
      printError(error);
    }
    await Promise.all([closeSharedBridge(), closeCrawlBridge()]);
    process.exit(soft ? 0 : (EXIT_CODES[errorKind(error)] ?? 1));
  },
);
