import { createInterface } from "node:readline/promises";
import { resolve } from "node:path";
import {
  PassiveRecorder,
  RecordingSession,
  addLearnedNoise,
  checkCaptures,
  editApi,
  explore,
  importCaptures,
  learnedNoise,
  loadModel,
  nameOperations,
  performFlow,
  rebuild,
  saveRecording,
  siteName,
  STAGES,
  type Stage,
  type SiteModel,
} from "@browserkit/tools/site-to-api";
import { flag, has, list, type Args } from "../args.js";
import { cliModel } from "../host.js";
import { out, printJson, printRows } from "../output.js";
import type { Command } from "../usage.js";

// Mapping a site: record it in the browser (or import captures), then build its API.

export async function mappedModel(site: string): Promise<SiteModel> {
  const model = await loadModel(site);
  if (!model)
    throw new Error(`${siteName(site)} is not mapped yet. Map it first: browserkit map <url>`);
  return model;
}

async function waitForEnter(prompt: string): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  await rl.question(prompt);
  rl.close();
}

/** Without a terminal (an agent's shell), recording stops once the site has been quiet this long. */
const AGENT_IDLE_SECONDS = 15;
/** --until-idle never records longer than this. */
const IDLE_LIMIT_MS = 15 * 60_000;

const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

/**
 * How a recording ends: --for <seconds>, --until-idle <seconds> (no new request for that long),
 * or Enter. With no terminal and neither flag, it waits for the site to go quiet, so an agent
 * can map a site in one command.
 */
async function waitForStop(
  what: string,
  args: Args,
  requests: () => Promise<number>,
): Promise<void> {
  const seconds = Number(flag(args, "for"));
  const idleFlag = flag(args, "until-idle");
  if (seconds > 0) {
    process.stderr.write(`Recording ${what} for ${seconds}s…
`);
    return sleep(seconds * 1000);
  }
  if (!idleFlag && process.stdin.isTTY)
    return waitForEnter(`Recording ${what}. Use it in the browser, then press Enter here… `);
  const quiet = (Number(idleFlag) > 0 ? Number(idleFlag) : AGENT_IDLE_SECONDS) * 1000;
  process.stderr.write(`Recording ${what} until no new request for ${quiet / 1000}s…
`);
  await waitForQuiet(requests, quiet);
}

async function waitForQuiet(requests: () => Promise<number>, quietMs: number): Promise<void> {
  const started = Date.now();
  let last = await requests();
  let changed = Date.now();
  while (Date.now() - changed < quietMs && Date.now() - started < IDLE_LIMIT_MS) {
    await sleep(Math.min(2000, quietMs));
    const now = await requests();
    if (now !== last) {
      last = now;
      changed = Date.now();
    }
  }
}

async function buildAndReport(
  site: string,
  options: { until?: Stage; workDir?: string } = {},
): Promise<void> {
  const result = await rebuild(site, options);
  if (result.stage !== "trace") {
    out(
      `Stopped after ${result.stage}. ${options.workDir ? `Intermediate files are in ${options.workDir}.` : ""}`,
    );
    return;
  }
  const model = result.model;
  out(
    `${model.site}: ${model.operations.length} operations, ${model.pages.length} page endpoints, ${model.channels.length} streams (version ${result.version}).`,
  );
  for (const op of model.operations)
    out(`  ${op.bucket.padEnd(6)} ${op.method.padEnd(6)} ${op.id}  ${op.path}`);
  out(`Files: ${result.dir}`);
}

async function recordPassive(args: Args): Promise<void> {
  const domains = list(args, "passive").map((domain) => siteName(domain));
  if (!domains.length) throw new Error("--passive needs one or more domains");
  const recorder = await PassiveRecorder.start(domains);
  await waitForStop(`every tab on ${domains.join(", ")}`, args, () => recorder.requestCount());
  const recording = await recorder.stop();
  const site = domains[0] as string;
  await saveRecording(site, recording, { name: flag(args, "name") ?? `passive-${Date.now()}` });
  if (!has(args, "no-build")) await buildAndReport(site);
}

async function recordFlow(url: string, args: Args): Promise<void> {
  const target = /^[a-z]+:\/\//i.test(url) ? url : `https://${url}`;
  const attach = flag(args, "attach");
  const session = await RecordingSession.start({
    url: target,
    ...(attach ? { attach: /^\d+$/.test(attach) ? Number(attach) : attach } : {}),
  });
  await waitForStop(target, args, () => session.requestCount());
  const recording = await session.stop();
  const name = flag(args, "name");
  const path = await saveRecording(target, recording, name ? { name } : {});
  out(`Saved ${recording.har.log.entries.length} requests to ${path}`);
  if (!has(args, "no-build")) await buildAndReport(target);
}

async function exploreSites(args: Args): Promise<void> {
  const sites = args.positional;
  if (!sites.length)
    throw new Error("explore needs at least one site: browserkit map --explore <site>");
  const goal = flag(args, "goal");
  const model = await cliModel();
  await explore(sites, {
    ...(goal ? { goal } : {}),
    ...(has(args, "actions") ? { actions: true } : {}),
    ...(has(args, "loud") ? { quiet: false } : {}),
    ...(flag(args, "parallel") ? { parallel: Number(flag(args, "parallel")) } : {}),
    ...(model ? { model } : {}),
    onSite: (result) =>
      out(
        result.error
          ? `${result.site}\tfailed (${result.kind ?? "failed"}): ${result.error}`
          : `${result.site}\t${result.operations} operations (version ${result.version})`,
      ),
  });
}

async function map(args: Args): Promise<number> {
  if (has(args, "explore")) {
    await exploreSites(args);
    return 0;
  }
  if (flag(args, "passive")) {
    await recordPassive(args);
    return 0;
  }
  const url = args.positional[0];
  if (!url)
    throw new Error(
      "Usage: browserkit map <url> [--attach tab] [--name n] [--no-build] | browserkit map --passive <domain,...> | browserkit map --explore <site>",
    );
  await recordFlow(url, args);
  return 0;
}

async function build(args: Args): Promise<number> {
  const site = args.positional[0];
  if (!site)
    throw new Error("Usage: browserkit build <site> [--until filter|normalize|infer|trace]");
  const until = flag(args, "until") as Stage | undefined;
  if (until && !STAGES.includes(until))
    throw new Error(`--until must be one of ${STAGES.join(", ")}`);
  const work = flag(args, "work");
  await buildAndReport(site, {
    ...(until ? { until } : {}),
    ...(work ? { workDir: resolve(work) } : {}),
  });
  return 0;
}

async function learn(args: Args): Promise<number> {
  const [site, ...files] = args.positional;
  if (!site || !files.length)
    throw new Error("Usage: browserkit learn <site> <file.har|flows> ...");
  const paths = files.map((file) => resolve(file));
  await checkCaptures(paths);
  for (const path of await importCaptures(site, paths)) out(`Added ${path}`);
  await buildAndReport(site);
  return 0;
}

async function noise(args: Args): Promise<number> {
  const [action, pattern] = args.positional;
  if (action === "add" && pattern) await addLearnedNoise([pattern]);
  for (const item of await learnedNoise()) out(item);
  return 0;
}

async function describe(args: Args): Promise<number> {
  const site = args.positional[0];
  const flow = args.positional.slice(1).join(" ");
  if (!site || !flow) throw new Error('Usage: browserkit describe <site> "<flow>" [--url u]');
  const url = flag(args, "url");
  const model = await cliModel();
  const result = await performFlow(site, flow, {
    ...(url ? { startUrl: url } : {}),
    ...(model ? { model } : {}),
    onStep: (code) => process.stderr.write(`> ${code.split("\n")[0]?.slice(0, 120)}\n`),
  });
  out(result.summary);
  await buildAndReport(site);
  return 0;
}

export const mapCommand: Command = {
  name: "map",
  group: "Map a site",
  summary: "record a flow in the browser (or explore sites), then build its API",
  help: `Usage: browserkit map <url> [--attach <tab>] [--name <n>] [--for <s> | --until-idle <s>] [--no-build]
       browserkit map --passive <domain,...> [--name <n>] [--for <s> | --until-idle <s>] [--no-build]
       browserkit map --explore <site> [site ...] [--goal <g>] [--parallel <n>] [--loud] [--actions]

Records the site's own requests while you use it, then builds an OpenAPI spec, a typed
client and a callable API from them.

  <url>                  a page to open and record (https:// is added when missing)
  --attach <tab>         record a tab you already have open (id, or text from its title/URL)
  --passive <domains>    record every tab on these domains
  --for <s>              stop recording after this many seconds
  --until-idle <s>       stop once no new request has come for this many seconds (at most 15
                         minutes). Without a terminal and without either flag, recording stops
                         after ${AGENT_IDLE_SECONDS}s of quiet, so agents can map in one command.
                         Otherwise it records until you press Enter.
  --name <n>             the name to save this flow under
  --no-build             only record; build later with \`browserkit build <site>\`
  --explore              map sites with an agent instead of a person: it uses each site in a
                         background tab, looking only. Needs a model: the standalone CLI has
                         none, so call explore() in code with your model.
  --goal <g>             with --explore: extra things to do on each site
  --parallel <n>         with --explore: how many sites at once (default 1; max 3)
  --loud                 with --explore: allow popunders, autoplay and ads
  --actions              with --explore: also map actions in dry run (never sent)`,
  run: map,
};

export const buildCommand: Command = {
  name: "build",
  group: "Map a site",
  summary: "rebuild a site's API from every flow it has",
  help: `Usage: browserkit build <site> [--until filter|normalize|infer|trace] [--work <dir>]

  --until <stage>   stop after one pipeline stage
  --work <dir>      write each stage's output there (default: the site's build folder)`,
  run: build,
};

export const learnCommand: Command = {
  name: "learn",
  group: "Map a site",
  summary: "add HAR or mitmproxy captures, then rebuild",
  help: `Usage: browserkit learn <site> <file.har|flows> ...

Captures from any tool work, including flow files exported from a phone or desktop app.`,
  run: learn,
};

export const describeCommand: Command = {
  name: "describe",
  group: "Map a site",
  summary: "an agent performs a flow while it is recorded (needs a model)",
  help: `Usage: browserkit describe <site> "<flow>" [--url <u>]

  --url <u>   start here instead of the site's first recorded page`,
  run: describe,
};

export const noiseCommand: Command = {
  name: "noise",
  group: "Map a site",
  summary: "list learned noise patterns, or add one",
  help: `Usage: browserkit noise [add <regex>]

Noise patterns are URLs dropped from every build, learned across sites.`,
  run: noise,
};

export const editCommand: Command = {
  name: "edit",
  group: "Map a site",
  summary: 'change the API in plain English (needs a model): edit <site> "<change>"',
  help: `Usage: browserkit edit <site> "<change>"

Examples: "rename getMe to currentUser", "add a page extractor for product pages with name and
price". Needs a model from the caller.`,
  run: async (args) => {
    const [site, ...change] = args.positional;
    if (!site || !change.length) throw new Error('Usage: browserkit edit <site> "<change>"');
    const model = await cliModel();
    out((await editApi(site, change.join(" "), model ? { model } : {})).note);
    return 0;
  },
};

export const nameCommand: Command = {
  name: "name",
  group: "Map a site",
  summary: "AI names and descriptions for operations (needs a model)",
  help: `Usage: browserkit name <site>`,
  run: async (args) => {
    const site = args.positional[0];
    if (!site) throw new Error("Usage: browserkit name <site>");
    const model = await cliModel();
    printJson(await nameOperations(site, model ? { model } : {}));
    return 0;
  },
};

/** Where a site's files are: the folder `serve` and `export` write into. */
export const mapGroup = [
  mapCommand,
  buildCommand,
  learnCommand,
  describeCommand,
  noiseCommand,
  editCommand,
  nameCommand,
];
