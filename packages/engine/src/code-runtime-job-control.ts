// Browser jobs: a durable record around a realm that opens pages in parallel. Every finished
// item is stored as it lands, so a lost realm (worker suspended, browser restarted) leaves a
// status a caller can act on: result says lost, resume continues from the last finished item,
// and cancel stops both the record and the realm.
import type { Cell } from "./code-runtime-host.js";
import { toOffscreen } from "./code-offscreen-host.js";
import { jobCode, jobOptions } from "./code-job-code.js";
import { sweepCode, sweepOptions, type SweepOptions } from "./code-sweep-code.js";
import { judgeOutcome, registrableDomain, summarizeOutcomes, type Outcome } from "./outcomes.js";
import {
  jobs,
  jobTimers,
  restoreJobs,
  saveJobs,
  MAX_JOB_ITEM_CHARS,
  type Job,
} from "./code-runtime-jobs.js";
import { agentTabSummary, reapChatPopups } from "./native-browser-tab-cleanup.js";

export async function jobCall(cell: Cell, request: Record<string, unknown>): Promise<unknown> {
  const action = String(request.action ?? "status");
  if (action === "start") return startJob(cell, request);
  await restoreJobs();
  if (action === "list")
    return {
      jobs: [...jobs.values()]
        .filter((job) => job.run.chatId === cell.run.chatId)
        .map((job) => jobState(job)),
    };
  const job = jobs.get(String(request.id ?? ""));
  if (!job) throw new Error("TARGET_LOST: no browser job " + String(request.id ?? ""));
  if (action === "item") {
    storeJobItem(job, request);
    return { ok: true };
  }
  if (action === "cancel") {
    if (job.status === "running") {
      job.status = "cancelled";
      job.error = "Cancelled";
      job.finishedAt = Date.now();
      job.done = true;
      clearJobTimer(job);
      await stopJob(job);
      await saveJobs();
    }
    return jobState(job);
  }
  if (action === "resume") return resumeJob(cell, job);
  if (action === "artifact") {
    if (typeof request.path === "string") job.artifact = request.path;
    else delete job.artifact;
    await saveJobs();
    return { ok: true, artifact: job.artifact };
  }
  if (action === "status") return jobState(job);
  if (action === "result")
    return {
      ...jobState(job),
      results: job.results ?? [],
      ...(job.status === "lost" ? { state: "lost" } : {}),
    };
  throw new Error("UNSUPPORTED: browser.job." + action);
}

function doneCount(job: Job): number {
  return job.results?.filter((item) => item !== undefined && item !== null).length ?? 0;
}

function jobState(job: Job): Record<string, unknown> {
  const done = job.progress?.done ?? doneCount(job);
  const outcomes = (job.results ?? [])
    .map((item) => (item as { outcome?: Outcome } | undefined)?.outcome)
    .filter((outcome): outcome is Outcome => Boolean(outcome));
  const summary = outcomes.length ? summarizeOutcomes(outcomes) : undefined;
  const showWarning =
    summary?.warning && (job.status !== "running" || done >= 10 || done >= job.total);
  return {
    jobId: job.run.cellId,
    status: job.status,
    state: job.status === "lost" ? "lost" : job.status === "running" ? "running" : "settled",
    total: job.total,
    done,
    ...(job.progress ? { progress: job.progress } : {}),
    ...(job.mode ? { mode: job.mode } : {}),
    ...(summary ? { summary } : {}),
    ...(showWarning ? { warning: summary?.warning } : {}),
    startedAt: job.startedAt,
    ...(job.finishedAt ? { finishedAt: job.finishedAt } : {}),
    ...(job.artifact ? { artifact: job.artifact } : {}),
    ...(job.error ? { error: job.error } : {}),
  };
}

/** One finished item, reported as it happens so the record survives a lost completion. */
function storeJobItem(job: Job, request: Record<string, unknown>): void {
  const index = Number(request.index);
  if (!Number.isSafeInteger(index) || index < 0 || index >= job.total) return;
  const results = job.results ?? [];
  results[index] = request.result;
  job.results = results;
  const done = doneCount(job);
  job.progress = { ...(job.progress ?? { total: job.total }), done, total: job.total };
  void saveJobs();
}

/** A job that outlived its realm is lost, not running: say so and let a resume continue it. */
function watchJob(job: Job): void {
  clearJobTimer(job);
  const options = job.options;
  const perItem = options?.timeoutMs ?? 120_000;
  const concurrency = options?.concurrency ?? 1;
  const budget = Math.min(
    3_600_000,
    Math.max(60_000, perItem * Math.ceil(job.total / Math.max(1, concurrency)) + 30_000),
  );
  jobTimers.set(
    job.run.cellId,
    setTimeout(() => {
      jobTimers.delete(job.run.cellId);
      if (job.status !== "running") return;
      job.status = "lost";
      job.done = true;
      job.finishedAt = Date.now();
      job.error =
        "the job's realm stopped answering (browser or worker restarted); browser.job.resume continues from the last finished item";
      void saveJobs();
    }, budget),
  );
}

function clearJobTimer(job: Job): void {
  const timer = jobTimers.get(job.run.cellId);
  if (timer) clearTimeout(timer);
  jobTimers.delete(job.run.cellId);
}

async function stopJob(job: Job): Promise<void> {
  await toOffscreen({
    target: "aeon-code-offscreen",
    kind: "stopJobs",
    jobId: job.run.cellId,
    chatId: job.run.chatId,
  }).catch(() => undefined);
}

/** Continues a lost or cancelled job from the last finished item, keeping its results. */
async function resumeJob(cell: Cell, job: Job): Promise<unknown> {
  if (job.status === "running" || job.status === "complete") return jobState(job);
  if (!Array.isArray(job.items) || !job.fn)
    throw new Error("JOB_NOT_RESUMABLE: this job did not keep its items and function");
  const offset = doneCount(job);
  if (offset >= job.total) {
    job.status = "complete";
    job.done = true;
    await saveJobs();
    return jobState(job);
  }
  const remaining = job.items.slice(offset);
  job.status = "running";
  job.done = false;
  delete job.finishedAt;
  delete job.error;
  await saveJobs();
  const code = jobCodeFor(job, remaining, offset);
  await toOffscreen({
    target: "aeon-code-offscreen",
    kind: "job",
    jobId: job.run.cellId,
    chatId: cell.run.chatId,
    code,
  });
  watchJob(job);
  return jobState(job);
}

/** The code for a job realm: the item function, or the generated sweep function. */
function jobCodeFor(job: Job, items: unknown[], offset?: number): string {
  if (job.mode === "sweep")
    return sweepCode({
      jobId: job.run.cellId,
      urls: items,
      options: (job.options as SweepOptions) ?? sweepOptions({}),
      ...(offset ? { offset } : {}),
      judge: judgeOutcome.toString(),
      domain: registrableDomain.toString(),
    });
  return jobCode({
    jobId: job.run.cellId,
    items,
    fn: job.fn ?? "",
    options: job.options ?? jobOptions({}),
    ...(offset ? { offset } : {}),
  });
}

async function startJob(cell: Cell, request: Record<string, unknown>): Promise<unknown> {
  const sweep = request.mode === "sweep";
  const requested = request.items;
  if (!Array.isArray(requested) || !requested.length || requested.length > 500)
    throw new Error("browser.job takes 1-500 items");
  let items: unknown[] = requested;
  const source = request.fn;
  if (!sweep && (typeof source !== "string" || !source.trim()))
    throw new Error("browser.job needs a function (items, page, index) => ...");
  if (typeof source === "string" && source.length > MAX_JOB_ITEM_CHARS)
    throw new Error("browser.job's function is too large");
  const options = sweep ? sweepOptions(request.options) : jobOptions(request.options);
  const retry = sweep ? ((options as SweepOptions).retry ?? []) : [];
  const checkpoint = sweep ? (options as SweepOptions).checkpoint : undefined;
  const previous = checkpoint
    ? [...jobs.values()].find(
        (job) =>
          job.mode === "sweep" &&
          job.run.chatId === cell.run.chatId &&
          (job.options as SweepOptions | undefined)?.checkpoint === checkpoint,
      )
    : undefined;
  if (previous && previous.status === "running") return jobState(previous);
  if (previous && previous.results?.some(Boolean)) {
    // A checkpoint re-runs only what is ambiguous or asked for, not the whole list.
    const rerun = previous.results
      .filter((item) => {
        const outcome = (item as { outcome?: string } | undefined)?.outcome;
        return (
          !outcome ||
          ["error", "gated", "blocked", "shell"].includes(outcome) ||
          (outcome !== undefined && retry.includes(outcome))
        );
      })
      .map((item) => (item as { url?: string } | undefined)?.url)
      .filter((url): url is string => Boolean(url));
    if (!rerun.length)
      return { ...jobState(previous), note: "checkpoint complete; no ambiguous items to re-run" };
    items = rerun;
  } else if (previous) {
    return resumeJob(cell, previous);
  }
  const jobId = crypto.randomUUID();
  const job: Job = {
    run: {
      kind: "browser.code.run",
      cellId: jobId,
      chatId: cell.run.chatId,
      toolCallId: "job-" + jobId,
      code: "browser.job",
      targets: [],
      timeoutMs: 600_000,
    },
    socket: cell.socket,
    identity: cell.identity,
    operationId: crypto.randomUUID(),
    allowed: new Map(),
    opened: new Map(),
    guarded: new Set(),
    steps: [],
    count: 0,
    calls: new Map(),
    sequence: 0,
    progressTimer: undefined,
    waitingForUser: false,
    done: false,
    popupsAtStart: agentTabSummary(cell.run.chatId).popups,
    status: "running",
    startedAt: Date.now(),
    total: items.length,
    items,
    ...(typeof source === "string" && source ? { fn: source } : {}),
    options,
    mode: sweep ? "sweep" : "job",
    progress: { done: 0, total: items.length },
  };
  jobs.set(jobId, job);
  await saveJobs();
  const code = jobCodeFor(job, items);
  try {
    await toOffscreen({
      target: "aeon-code-offscreen",
      kind: "job",
      jobId,
      chatId: cell.run.chatId,
      code,
    });
  } catch (error) {
    job.status = "failed";
    job.error = String(error);
    clearJobTimer(job);
    await saveJobs();
    throw error;
  }
  watchJob(job);
  return { jobId, status: "running", total: items.length, mode: job.mode };
}

export function finishJob(message: Record<string, unknown>): void {
  const job = jobs.get(String(message.jobId ?? ""));
  if (!job) return;
  job.done = true;
  job.finishedAt = Date.now();
  clearJobTimer(job);
  const value = message.value as { results?: unknown[] } | undefined;
  if (Array.isArray(value?.results)) job.results = value.results;
  else delete job.results;
  const error = typeof message.error === "string" ? message.error : undefined;
  job.status = error ? "failed" : "complete";
  if (error) job.error = error;
  else delete job.error;
  job.calls.clear();
  void saveJobs();
  void reapChatPopups(job.run.chatId);
}

export function cancelJobs(chatId: string): void {
  for (const job of jobs.values())
    if (job.run.chatId === chatId && job.status === "running") {
      job.status = "cancelled";
      job.finishedAt = Date.now();
      job.error = "Browser job cancelled";
      clearJobTimer(job);
    }
  void saveJobs();
}
