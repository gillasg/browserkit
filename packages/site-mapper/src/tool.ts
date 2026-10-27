import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { coverage } from "./coverage.js";
import { readDocs } from "./docs.js";
import { generateClient } from "./emit/client.js";
import { htmlReport } from "./emit/html.js";
import { toAsyncApi, toOpenApi } from "./emit/openapi.js";
import { markdownReport, redactedSamples } from "./emit/report.js";
import { toYaml } from "./emit/yaml.js";
import { checkHealth, repair } from "./health.js";
import { loadCapture } from "./load/index.js";
import { loadModel, readOverrides, siteName } from "./registry.js";
import { listAbilities, runAbility } from "./abilities.js";
import type { ChannelOptions } from "./runtime/channels.js";
import { exportSession } from "./runtime/session-export.js";
import { siteMapper } from "./runtime/site-mapper.js";
import type { ModelLike } from "./agent.js";
import { loadFlows, rebuild } from "./workflow.js";

// The site_mapper actions beyond sites/operations/call/watch/learn/explore, shared by every host
// (this package's MCP server, browserkit's MCP tools, Aeon's site_mapper tool).

export const SITE_TOOL_ACTIONS = [
  "docs",
  "ability",
  "channel",
  "session",
  "export",
  "heal",
  "coverage",
  "edit",
  "name",
  "describe",
  "signing",
] as const;
export type SiteToolAction = (typeof SITE_TOOL_ACTIONS)[number];

export interface SiteToolInput {
  site: string;
  /** action: the saved action's name; channel: the channel id; signing: the operation. */
  name?: string;
  operation?: string;
  /** ability/action: inputs; channel: { send, seconds, match }. */
  params?: Record<string, unknown>;
  /** ability: only try this way (api, steps, script, page). */
  via?: "api" | "steps" | "script" | "page";
  /** actions: save a new action from these operation ids, in order. */
  steps?: string[];
  description?: string;
  /** edit: the change in plain English. */
  change?: string;
  /** describe: the flow to perform in plain English; url: where to start it. */
  flow?: string;
  url?: string;
  /** export: folder to write into. */
  folder?: string;
  /** heal: re-record the flows behind failing operations. */
  repair?: boolean;
  /** The model AI actions (edit, name, describe) use; the host supplies its own. */
  model?: ModelLike | (() => Promise<ModelLike>);
}

/** Plain-language guidance for each extra action, for tool descriptions. */
export const SITE_TOOL_HELP = [
  "how a site works (routes, endpoints): code(url) before guessing URLs.",
  "docs: the site's published API documents (OpenAPI/Swagger) and GraphQL schemas, read with the user's session: operations nobody clicked yet. Saved in the site's folder.",
  "actions: list saved multi-step actions, or save one with name, steps (operation ids in order) and description. action runs one by name with params as inputs; each step's result feeds the next.",
  "recipe: with no name, lists the site's recipes (API-then-page strategies, fields, health); with name and params, runs one and returns its mapped records. Recipes live in the site pack; a write recipe records a receipt so a repeat is skipped.",
  "channel: the site's live WebSocket/event streams (operations lists them); with name, listens on one from the site's page (params: send [messages], seconds, match) and returns what arrived.",
  "session: export the user's session so calls run without the browser (renewed from the browser when it expires). export: OpenAPI, AsyncAPI, a typed client and reports into folder.",
  "heal: probe every read operation and report broken or drifted ones (repair: true re-records them). coverage: what to capture next to widen the API. edit: change the API in plain English (change). name: AI names and descriptions. describe: an agent performs a flow in plain English (flow, url) while it is recorded, then rebuilds. signing: how a signed operation is signed.",
  "Mapping actions (like, send, post, buy) without doing them: explore with actions: true, or in browser code page.network.start({ types: 'all', dryRun: true }): requests that would change something are recorded and blocked, never sent.",
];

/** Checks captures can be read: HAR (from any tool) or mitmproxy flow files (phone and desktop apps). */
export async function checkCaptures(paths: string[]): Promise<void> {
  for (const path of paths) {
    const exchanges = await loadCapture(path).catch((error: unknown) => {
      throw new Error(
        `${path} is not a HAR or mitmproxy capture: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    });
    if (!exchanges.length) throw new Error(`${path} has no requests`);
  }
}

/** Writes OpenAPI (JSON and YAML), AsyncAPI, a typed client, reports and samples into dir. */
export async function exportSite(site: string, dir: string): Promise<string[]> {
  const model = await loadModel(site);
  if (!model) throw new Error(`${siteName(site)} is not mapped yet.`);
  const overrides = await readOverrides(site);
  await mkdir(dir, { recursive: true });
  const openapi = toOpenApi(model, overrides.redact);
  const asyncapi = toAsyncApi(model);
  const files: Record<string, string> = {
    "openapi.json": JSON.stringify(openapi, null, 2),
    "openapi.yaml": toYaml(openapi),
    ...(asyncapi ? { "asyncapi.yaml": toYaml(asyncapi) } : {}),
    "client.ts": generateClient(model),
    "report.md": markdownReport(model, overrides.redact),
    "report.html": htmlReport(model, overrides.redact),
    "samples.json": JSON.stringify(redactedSamples(model, overrides.redact), null, 2),
  };
  for (const [name, text] of Object.entries(files)) await writeFile(join(dir, name), text);
  return Object.keys(files).map((name) => join(dir, name));
}

/** How a signed operation is signed, with the code around the function that signs it. */
export async function signingInfo(site: string, operationId: string): Promise<unknown> {
  const model = await loadModel(site);
  const op = model?.operations.find((o) => o.id === operationId);
  if (!op?.signing) return { operation: operationId, signed: false };
  const frame = op.signing.initiator;
  let code: string | undefined;
  if (frame) {
    const source = await fetch(frame.url)
      .then((r) => r.text())
      .catch(() => "");
    const lines = source.split("\n");
    code =
      lines.length > 3
        ? lines
            .slice(Math.max(0, frame.line - 6), frame.line + 6)
            .join("\n")
            .slice(0, 4000)
        : source.slice(0, 1500) || undefined;
  }
  return {
    operation: operationId,
    signed: true,
    values: [...op.signing.headers, ...op.signing.query],
    via: op.signing.via,
    ...(frame
      ? { builtBy: `${frame.functionName || "anonymous"} at ${frame.url}:${frame.line}` }
      : {}),
    ...(code ? { code } : {}),
  };
}

async function channel(input: SiteToolInput): Promise<unknown> {
  const api = await siteMapper(input.site);
  if (!input.name) return api.model.channels.map((c) => ({ id: c.id, kind: c.kind, url: c.url }));
  return api.channel(input.name, (input.params ?? {}) as ChannelOptions);
}

async function heal(input: SiteToolInput): Promise<unknown> {
  const report = await checkHealth(input.site);
  const failing = report.results
    .filter((r) => r.status === "broken" || r.status === "drift")
    .map((r) => r.id);
  if (!input.repair || !failing.length) return report;
  return { before: report, after: (await repair(input.site, failing)).after };
}

const require = (value: string | undefined, what: string): string => {
  if (!value) throw new Error(`Give ${what}`);
  return value;
};

const modelFor = async (input: SiteToolInput): Promise<ModelLike | undefined> =>
  typeof input.model === "function" ? input.model() : input.model;

const HANDLERS: Record<SiteToolAction, (input: SiteToolInput) => Promise<unknown>> = {
  docs: (input) => readDocs(input.site),
  ability: async (input) => {
    if (!input.name) return listAbilities(input.site);
    return runAbility(
      input.site,
      input.name,
      input.params ?? {},
      input.via ? { via: input.via } : {},
    );
  },
  channel,
  session: async (input) => {
    const model = await loadModel(input.site);
    if (!model) throw new Error(`${input.site} is not mapped yet.`);
    const { session, path } = await exportSession(model);
    return { saved: path, cookies: session.cookies.length };
  },
  export: async (input) => ({
    files: await exportSite(input.site, require(input.folder, "folder: where to write")),
  }),
  heal,
  coverage: async (input) => {
    const model = await loadModel(input.site);
    if (!model) throw new Error(`${input.site} is not mapped yet.`);
    return coverage(model, (await loadFlows(input.site)).exchanges).map((s) => s.message);
  },
  edit: async (input) => {
    const { editApi, requireModel } = await import("./agent.js");
    return editApi(input.site, require(input.change, "change: what to change"), {
      model: requireModel(await modelFor(input)),
    });
  },
  name: async (input) => {
    const { nameOperations, requireModel } = await import("./agent.js");
    return nameOperations(input.site, { model: requireModel(await modelFor(input)) });
  },
  describe: async (input) => {
    const { performFlow, requireModel } = await import("./agent.js");
    const flow = await performFlow(
      input.site,
      require(input.flow ?? input.change, "flow: what to do on the site"),
      {
        model: requireModel(await modelFor(input)),
        ...(input.url ? { startUrl: input.url } : {}),
      },
    );
    const built = await rebuild(input.site);
    return { ...flow, version: built.version, operations: built.model.operations.length };
  },
  signing: (input) =>
    signingInfo(
      input.site,
      require(input.operation ?? input.name, "operation: the signed operation"),
    ),
};

export function isSiteToolAction(action: unknown): action is SiteToolAction {
  return SITE_TOOL_ACTIONS.includes(action as SiteToolAction);
}

/** Runs one of the extra site_mapper actions. */
export function runSiteToolAction(action: SiteToolAction, input: SiteToolInput): Promise<unknown> {
  return HANDLERS[action]({ ...input, site: siteName(input.site) });
}
