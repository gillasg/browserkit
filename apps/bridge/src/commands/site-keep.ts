import { resolve } from "node:path";
import {
  checkHealth,
  coverage,
  diffModels,
  exportSession,
  exportSite,
  formatDiff,
  loadFlows,
  loadModel,
  loadVersion,
  readDocs,
  readOverrides,
  repair,
  sessionStatus,
  signingInfo,
  siteMapper,
  siteName,
  versions,
  writeOverrides,
} from "@browserkit/tools/site-to-api";
import { flag, has, jsonValue, type Args } from "../args.js";
import { out, printJson, printRows } from "../output.js";
import type { Command } from "../usage.js";
import { mappedModel } from "./site-map.js";

// Keeping a mapped site working: probe it, see what changed, export it, keep its session.

async function heal(args: Args): Promise<number> {
  const site = args.positional[0];
  if (!site)
    throw new Error("Usage: browserkit heal <site> [--repair] [--include-actions] [--json]");
  const report = await checkHealth(site, { includeActions: has(args, "include-actions") });
  if (has(args, "json")) printJson(report);
  else
    printRows(
      report.results.map((result) => [
        result.status,
        result.id,
        result.httpStatus ? `HTTP ${result.httpStatus}` : undefined,
        result.error,
      ]),
    );
  const challenged = report.results.filter((result) => result.status === "challenged");
  if (challenged.length)
    out(
      `A bot wall answered ${challenged.length} operation(s) (${challenged.map((item) => item.id).join(", ")}). Use the site in a tab until the wall clears, then probe again: re-recording will not help.`,
    );
  const failing = report.results
    .filter((result) => result.status === "broken" || result.status === "drift")
    .map((result) => result.id);
  if (has(args, "repair") && failing.length) {
    out(`Re-recording the flows behind ${failing.join(", ")}…`);
    const result = await repair(site, failing);
    for (const item of result.after.results)
      out(`after repair: ${item.status.padEnd(10)} ${item.id}`);
  }
  return 0;
}

async function showCoverage(args: Args): Promise<number> {
  const site = args.positional[0];
  if (!site) throw new Error("Usage: browserkit coverage <site>");
  const model = await mappedModel(site);
  const { exchanges } = await loadFlows(site);
  const suggestions = coverage(model, exchanges);
  if (has(args, "json")) printJson(suggestions);
  else for (const suggestion of suggestions) out(`- ${suggestion.message}`);
  return 0;
}

async function showDiff(args: Args): Promise<number> {
  const site = args.positional[0];
  if (!site) throw new Error("Usage: browserkit diff <site> [from] [to]");
  const all = await versions(site);
  const to = Number(args.positional[2] ?? all[all.length - 1]?.version);
  const from = Number(args.positional[1] ?? to - 1);
  const after = (await loadVersion(site, to)) ?? (await mappedModel(site));
  const diff = diffModels(await loadVersion(site, from), after);
  if (has(args, "json")) printJson(diff);
  else out(formatDiff(diff));
  return 0;
}

async function session(args: Args): Promise<number> {
  // "session export <site>" reads naturally too.
  const site = args.positional[0] === "export" ? args.positional[1] : args.positional[0];
  if (!site) throw new Error("Usage: browserkit session <site> [--status]");
  if (has(args, "status")) {
    printJson(await sessionStatus(site));
    return 0;
  }
  // Exporting is a cookie and storage read: any site the browser has visited works, mapped or not.
  const host = siteName(site);
  const model = (await loadModel(site)) ?? { site: host, origins: [`https://${host}`] };
  const { session: saved, path } = await exportSession(model);
  if (has(args, "json")) {
    printJson({ path, ...saved });
    return 0;
  }
  out(
    `Saved ${saved.cookies.length} cookies and web storage to ${path} (readable only by you). Calls run without the browser, and the session renews itself from the browser when it expires.`,
  );
  return 0;
}

async function docs(args: Args): Promise<number> {
  const site = args.positional[0];
  if (!site) throw new Error("Usage: browserkit docs <site>");
  printJson(await readDocs(site));
  return 0;
}

async function runExport(args: Args): Promise<number> {
  const site = args.positional[0];
  if (!site) throw new Error("Usage: browserkit export <site> [--out <dir>]");
  const dir = resolve(flag(args, "out") ?? `${siteName(site)}-api`);
  await exportSite(site, dir);
  out(`Exported to ${dir}`);
  return 0;
}

async function action(args: Args): Promise<number> {
  const [site, name, json] = args.positional;
  if (!site) throw new Error("Usage: browserkit action <site> [name] [json] [--steps a,b,c]");
  const api = await siteMapper(site);
  if (!name) {
    printRows(
      Object.entries(api.actions).map(([id, saved]) => [
        id,
        saved.steps.map((step) => step.operation).join(" → "),
        saved.description,
      ]),
    );
    return 0;
  }
  const steps = flag(args, "steps");
  if (steps) {
    const overrides = await readOverrides(site);
    const description = flag(args, "description");
    overrides.actions = {
      ...(overrides.actions ?? {}),
      [name]: {
        ...(description ? { description } : {}),
        steps: steps.split(",").map((operation) => ({ operation: operation.trim() })),
      },
    };
    await writeOverrides(site, overrides);
    out(`Saved action ${name}.`);
    return 0;
  }
  const parsed = jsonValue(json);
  printJson(await api.action(name, (parsed as Record<string, unknown> | undefined) ?? {}));
  return 0;
}

async function channel(args: Args): Promise<number> {
  const [site, id] = args.positional;
  if (!site) throw new Error("Usage: browserkit channel <site> [id] [--send json] [--seconds n]");
  const api = await siteMapper(site);
  if (!id) {
    printRows(api.model.channels.map((item) => [item.id, item.kind, item.url]));
    return 0;
  }
  const send = flag(args, "send");
  const match = flag(args, "match");
  printJson(
    await api.channel(id, {
      ...(send ? { send: [JSON.parse(send) as unknown] } : {}),
      ...(match ? { match } : {}),
      seconds: Number(flag(args, "seconds") ?? 10),
    }),
  );
  return 0;
}

async function signing(args: Args): Promise<number> {
  const [site, operation] = args.positional;
  if (!site || !operation) throw new Error("Usage: browserkit signing <site> <operation>");
  const info = (await signingInfo(site, operation)) as {
    signed: boolean;
    values?: string[];
    via?: string;
    builtBy?: string;
    code?: string;
  };
  if (has(args, "json")) {
    printJson(info);
    return 0;
  }
  if (!info.signed) {
    out(`${operation} is not signed.`);
    return 0;
  }
  out(`Signed values: ${info.values?.join(", ")}; calls go through the page's ${info.via}.`);
  if (info.builtBy) out(`Built by ${info.builtBy}`);
  if (info.code) out(info.code);
  return 0;
}

export const healCommand: Command = {
  name: "heal",
  group: "Keep a site working",
  summary: "probe every operation and report drift, breakage, sign-out or a bot wall",
  help: `Usage: browserkit heal <site> [--repair] [--include-actions] [--json]

  --repair            re-record the flows behind failing operations, then probe again
  --include-actions   probe writes too (they are sent)
  --json              the whole report as JSON

Results are also kept in the site's health.json and events.jsonl.`,
  run: heal,
};

export const coverageCommand: Command = {
  name: "coverage",
  group: "Keep a site working",
  summary: "flows that would widen the API",
  help: `Usage: browserkit coverage <site> [--json]`,
  run: showCoverage,
};

export const diffCommand: Command = {
  name: "diff",
  group: "Keep a site working",
  summary: "what changed between two versions of a site's API",
  help: `Usage: browserkit diff <site> [from] [to] [--json]

Defaults to the two newest versions.`,
  run: showDiff,
};

export const sessionCommand: Command = {
  name: "session",
  group: "Keep a site working",
  summary: "export a site's session for calls without a browser, or say whether one is fresh",
  help: `Usage: browserkit session <site> [--status] [--json]

Saves the site's cookies (HttpOnly too) and web storage from your browser, for calls without
it. Works on any site you are signed in to, mapped or not.

  --status   report whether a session was exported, how old it is, and whether it is fresh
  --json     print the saved session (cookies with values) as JSON`,
  run: session,
};

export const docsCommand: Command = {
  name: "docs",
  group: "Keep a site working",
  summary: "the site's published API documents and GraphQL schemas",
  help: `Usage: browserkit docs <site>`,
  run: docs,
};

export const exportCommand: Command = {
  name: "export",
  group: "Keep a site working",
  summary: "OpenAPI, AsyncAPI, typed client, reports and samples",
  help: `Usage: browserkit export <site> [--out <dir>]

Writes openapi.json, openapi.yaml, asyncapi.yaml, client.ts, report.md, report.html and redacted
samples. Default folder: <site>-api in the current directory.`,
  run: runExport,
};

export const actionCommand: Command = {
  name: "action",
  group: "Keep a site working",
  summary: "list, run or save a multi-step action",
  help: `Usage: browserkit action <site> [name] [json]
       browserkit action <site> <name> --steps a,b,c [--description d]

An action runs several operations in order, each fed by the last one's answer.`,
  run: action,
};

export const channelCommand: Command = {
  name: "channel",
  group: "Keep a site working",
  summary: "list live channels (WebSocket, event streams), or listen on one",
  help: `Usage: browserkit channel <site> [id] [--send json] [--match text] [--seconds n]`,
  run: channel,
};

export const signingCommand: Command = {
  name: "signing",
  group: "Keep a site working",
  summary: "show the code that signs a request",
  help: `Usage: browserkit signing <site> <operation> [--json]`,
  run: signing,
};

export const keepGroup = [
  healCommand,
  coverageCommand,
  diffCommand,
  sessionCommand,
  docsCommand,
  exportCommand,
  actionCommand,
  channelCommand,
  signingCommand,
];
