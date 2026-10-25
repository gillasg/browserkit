import { BridgeClient } from "../client.js";
import { cliHost } from "../host.js";
import { flag, has, type Args } from "../args.js";
import { out, printJson } from "../output.js";
import type { Command } from "../usage.js";

// browser.job is durable: a cell can return while pages keep opening, and a lost realm says so.
// These commands are the shell's view of the same records (there is no second job store).

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

interface JobView {
  jobId?: string;
  status?: string;
  state?: string;
  mode?: string;
  done?: number;
  total?: number;
  summary?: { counts?: Record<string, number>; warning?: string };
  error?: string;
  note?: string;
}

function line(job: JobView): string {
  const counts = Object.entries(job.summary?.counts ?? {})
    .map(([outcome, count]) => `${outcome} ${count}`)
    .join(", ");
  return `${job.jobId ?? "?"}  ${String(job.status ?? "?").padEnd(9)} ${job.mode ?? "job"}  ${job.done ?? 0}/${job.total ?? 0}${counts ? `  ${counts}` : ""}${job.note ? `  ${job.note}` : ""}${job.error ? `  ${job.error}` : ""}`;
}

async function job(args: Args): Promise<number> {
  const action = args.positional[0] ?? "list";
  const id = args.positional[1];
  if (!["list", "status", "result", "cancel", "resume"].includes(action))
    throw new Error(
      "Usage: browserkit job list | status <id> | result <id> | cancel <id> | resume <id> [--json]",
    );
  if (action !== "list" && !id) throw new Error(`Usage: browserkit job ${action} <id> [--json]`);
  const code =
    action === "list"
      ? "await browser.job.list()"
      : `await browser.job.${action}(${JSON.stringify(id)})`;
  const value = (await runInBrowser(code)) as JobView | { jobs?: JobView[] };
  if (has(args, "json")) {
    printJson(value);
    return 0;
  }
  if (action === "list") {
    const jobs = (value as { jobs?: JobView[] }).jobs ?? [];
    if (!jobs.length) out("No browser jobs in this session.");
    for (const item of jobs) out(line(item));
    return 0;
  }
  const view = value as JobView;
  out(line(view));
  return view.status === "failed" ? 1 : 0;
}

export const jobCommand: Command = {
  name: "job",
  group: "Browser",
  summary: "list, inspect, cancel or resume durable browser jobs",
  help: `Usage: browserkit job list | status <id> | result <id> | cancel <id> | resume <id> [--json]

A browser.job (and a sweep) is a record that survives the cell that started it: every finished
item is stored as it lands, a lost realm reports state "lost" instead of an empty result, resume
continues from the last finished item, and cancel stops both the record and the pages.`,
  run: job,
};
