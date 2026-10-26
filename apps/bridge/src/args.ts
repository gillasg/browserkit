// Argument parsing for the browserkit command line: positional words, `--flag`, `--flag value`
// and `--key=value`. Flags that never take a value are listed here so that
// `browserkit crawl --json https://example.com` does not swallow the URL.

export interface Args {
  positional: string[];
  flags: Record<string, string | true>;
}

const BOOLEAN = new Set([
  "all",
  "actions",
  "all",
  "dry-run",
  "evidence",
  "explore",
  "feed",
  "first-wins",
  "help",
  "include-actions",
  "hidden",
  "http-only",
  "json",
  "media",
  "no-build",
  "no-flight",
  "no-boosts",
  "no-color",
  "no-gate",
  "no-register",
  "no-wait",
  "off",
  "play",
  "quiet",
  "ready",
  "repair",
  "screenshot",
  "no-screenshot",
  "no-diff",
  "full",
  "secrets",
  "secure",
  "site",
  "static",
  "summary",
  "dynamic",
  "status",
  "unreviewed",
  "values",
  "verbose",
  "window",
]);

export function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index] as string;
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const [name, inline] = arg.slice(2).split("=", 2) as [string, string | undefined];
    const next = argv[index + 1];
    if (inline !== undefined) flags[name] = inline;
    else if (!BOOLEAN.has(name) && next !== undefined && !next.startsWith("--")) {
      flags[name] = next;
      index++;
    } else flags[name] = true;
    if (name === "param") {
      const [key, value] = String(flags.param).split("=", 2);
      flags[`param.${key ?? ""}`] = value ?? "";
    }
  }
  return { positional, flags };
}

/** The value of a flag, or undefined when it was left out or given without one. */
export function flag(args: Args, name: string): string | undefined {
  return typeof args.flags[name] === "string" ? (args.flags[name] as string) : undefined;
}

export function has(args: Args, name: string): boolean {
  return args.flags[name] !== undefined;
}

/** A flag that holds a comma-separated list. */
export function list(args: Args, name: string): string[] {
  const value = flag(args, name);
  return value
    ? value
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean)
    : [];
}

/** A positional or flag value as JSON; a bare word is a JSON string, not an error. */
export function jsonValue(text: string | undefined): unknown {
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** Call parameters: a JSON object, then `--param name=value` pairs on top. */
export function callParams(args: Args, json?: string): Record<string, unknown> {
  const parsed = jsonValue(json);
  const params: Record<string, unknown> =
    typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  for (const [key, value] of Object.entries(args.flags))
    if (key.startsWith("param.")) params[key.slice(6)] = value;
  return params;
}
