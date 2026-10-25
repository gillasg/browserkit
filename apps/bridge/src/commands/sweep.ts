import { readFile } from "node:fs/promises";
import { BridgeClient } from "../client.js";
import { cliHost } from "../host.js";
import { flag, has, type Args } from "../args.js";
import { out, printJson } from "../output.js";
import type { Command } from "../usage.js";

// A sweep: every URL one record, with an outcome and (optionally) evidence. It runs as a durable
// job in the browser, so it survives this process; the command only starts it, watches progress
// and prints the result.

const SESSION = "browserkit-cli";

async function runInBrowser(code: string): Promise<unknown> {
  const host = cliHost();
  if (host) return host.runInBrowser(code, { session: SESSION });
  const bridge = await BridgeClient.connect();
  try {
    const reply = await bridge.request("run", { code, session: SESSION });
    if (reply.error) throw new Error(String(reply.error));
    return reply.value;
  } finally {
    bridge.close();
  }
}

async function stdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

async function urlsOf(inputs: string[]): Promise<string[]> {
  const urls: string[] = [];
  for (const input of inputs) {
    if (input === "-") urls.push(...lines(await stdin()));
    else if (input.startsWith("@")) urls.push(...lines(await readFile(input.slice(1), "utf8")));
    else urls.push(input);
  }
  return [...new Set(urls.map((url) => url.trim()).filter(Boolean))];
}

function lines(text: string): string[] {
  const trimmed = text.trim();
  if (trimmed.startsWith("[")) {
    try {
      const value = JSON.parse(trimmed) as unknown;
      if (Array.isArray(value)) return value.map(String);
    } catch {
      // Not JSON: treat it as lines.
    }
  }
  return trimmed.split(/\r?\n/).map((line) => line.trim());
}

interface Summary {
  counts?: Record<string, number>;
  warning?: string;
}

interface Status {
  jobId: string;
  status: string;
  done: number;
  total: number;
  summary?: Summary;
  warning?: string;
  error?: string;
  results?: (SweepRecord | undefined)[];
}

interface SweepRecord {
  url: string;
  outcome?: string;
  reason?: string;
  ms?: number;
  finalUrl?: string;
}

function countsLine(summary: Summary | undefined): string {
  const counts = summary?.counts ?? {};
  return Object.entries(counts)
    .sort((left, right) => right[1] - left[1])
    .map(([outcome, count]) => `${outcome} ${count}`)
    .join(", ");
}

function optionsOf(args: Args): Record<string, unknown> {
  const capture = flag(args, "capture");
  return {
    ...(flag(args, "concurrency") ? { concurrency: Number(flag(args, "concurrency")) } : {}),
    ...(flag(args, "checkpoint") ? { checkpoint: flag(args, "checkpoint") } : {}),
    gate: !has(args, "no-gate"),
    ...(capture ? { capture: capture === "false" ? false : capture } : {}),
    play: has(args, "play"),
    evidence: has(args, "evidence"),
    ...(flag(args, "timeout") ? { timeoutMs: Number(flag(args, "timeout")) } : {}),
  };
}

function show(result: Status, asJson: boolean): number {
  if (asJson) {
    printJson(result);
    return result.status === "complete" ? 0 : 1;
  }
  const counts = countsLine(result.summary);
  out(
    `${result.status === "complete" ? "Sweep complete" : `Sweep ${result.status}`}: ${result.done ?? 0}/${result.total ?? 0}${counts ? ` (${counts})` : ""}`,
  );
  if (result.summary?.warning ?? result.warning)
    out(`Warning: ${result.summary?.warning ?? result.warning}`);
  if (result.error) out(`  ${result.error}`);
  for (const item of (result.results ?? []).filter(Boolean).slice(0, 500)) {
    const record = item as SweepRecord;
    out(
      `  ${String(record.outcome ?? "?").padEnd(10)} ${String(record.ms ?? 0).padStart(6)}ms  ${record.url}${record.reason ? `  -  ${record.reason}` : ""}`,
    );
  }
  return result.status === "complete" ? 0 : 1;
}

async function sweep(args: Args): Promise<number> {
  const urls = await urlsOf(args.positional);
  if (!urls.length)
    throw new Error(
      "Usage: browserkit sweep <url...> | @urls.txt | - [--pilot n] [--checkpoint name]",
    );
  const options = optionsOf(args);
  const asJson = has(args, "json");
  // Pilot blocks for exactly n items and returns their evidence; a full sweep returns its job.
  if (flag(args, "pilot")) {
    const finished = (await runInBrowser(
      `await browser.sweep(${JSON.stringify(urls)}, ${JSON.stringify({ ...options, pilot: Number(flag(args, "pilot")) })})`,
    )) as Status;
    return show(finished, asJson);
  }
  const started = (await runInBrowser(
    `await browser.sweep(${JSON.stringify(urls)}, ${JSON.stringify({ ...options, wait: false })})`,
  )) as Status;
  if (!started?.jobId) throw new Error("The browser did not return a sweep job");
  if (has(args, "no-wait")) return show(started, asJson);
  let status = started;
  while (status.status === "running") {
    if (!has(args, "quiet"))
      process.stderr.write(`\r  ${status.done ?? 0}/${status.total ?? urls.length}`);
    await new Promise((done) => setTimeout(done, 1000));
    status = (await runInBrowser(
      `await browser.job.result(${JSON.stringify(started.jobId)})`,
    )) as Status;
  }
  if (!has(args, "quiet")) process.stderr.write("\n");
  return show(status, asJson);
}

export const sweepCommand: Command = {
  name: "sweep",
  group: "Browser",
  summary: "open many URLs, gate, capture and classify each (a durable job)",
  help: `Usage: browserkit sweep <url...> | @urls.txt | -
       [--concurrency 4] [--pilot n] [--checkpoint name] [--no-gate] [--capture network|media|false]
       [--play] [--evidence] [--timeout ms] [--json] [--quiet]

One record per URL: {url, outcome, reason, gate, captured, media, evidence, ms}. Outcomes are ok,
gated, shell, dead, parked, redirected, blocked and error; a run with no ok items warns that the
method is probably incomplete. --pilot runs n, prints their evidence and stops. --checkpoint
resumes by name, re-running only ambiguous items. --evidence keeps a screenshot, DOM text and
network summary per item in the session workspace. A sweep is a browser.job: browser.job.status,
.cancel and .resume work on it.`,
  run: sweep,
};
