// Browser jobs outlive the cell that started them: their state is kept in session storage and
// restored when the worker restarts, so browser.job status still answers.
import type { Cell } from "./code-runtime-host.js";
import type { JobOptions } from "./code-job-code.js";
import type { SweepOptions } from "./code-sweep-code.js";
import type { BrowserIdentity } from "./native-worker-identity.js";

export const jobs = new Map<string, Job>();
/** Watchdogs for running jobs; a job whose realm is gone is settled by one. */
export const jobTimers = new Map<string, ReturnType<typeof setTimeout>>();
const JOB_STORAGE = "aeon-code-jobs";
export const MAX_JOB_ITEM_CHARS = 200_000;

export interface Job extends Cell {
  status: "running" | "complete" | "failed" | "cancelled" | "lost";
  startedAt: number;
  finishedAt?: number;
  total: number;
  results?: unknown[];
  progress?: { done: number; total: number; label?: string };
  error?: string;
  artifact?: string;
  /** The items and function a resume replays; a lost job keeps them. */
  items?: unknown[];
  fn?: string;
  options?: JobOptions | SweepOptions;
  /** A job of pages, or a sweep with outcomes and evidence per URL. */
  mode?: "job" | "sweep";
}

let jobsRestored: Promise<void> | undefined;
export function restoreJobs(): Promise<void> {
  jobsRestored ??= chrome.storage.session
    .get(JOB_STORAGE)
    .then((stored) => {
      const saved = stored[JOB_STORAGE];
      if (!Array.isArray(saved)) return;
      for (const item of saved as Record<string, unknown>[]) {
        if (typeof item.jobId !== "string" || jobs.has(item.jobId)) continue;
        jobs.set(item.jobId, {
          ...emptyJob(item.jobId, String(item.chatId ?? ""), Number(item.total ?? 0)),
          // A job that was still running when the worker or browser restarted cannot be resumed:
          // it is lost, not failed, so a caller can tell the difference.
          status:
            item.status === "complete" || item.status === "failed" || item.status === "cancelled"
              ? item.status
              : "lost",
          ...(item.status === "lost" ||
          !["complete", "failed", "cancelled"].includes(String(item.status))
            ? { error: "the job's cell is gone (browser or worker restarted); start it again" }
            : {}),
          startedAt: Number(item.startedAt ?? Date.now()),
          ...(item.finishedAt ? { finishedAt: Number(item.finishedAt) } : {}),
          ...(Array.isArray(item.results) ? { results: item.results } : {}),
          ...(item.progress && typeof item.progress === "object"
            ? {
                progress: {
                  done: Number((item.progress as { done?: unknown }).done ?? 0),
                  total: Number((item.progress as { total?: unknown }).total ?? item.total ?? 0),
                },
              }
            : {}),
          ...(Array.isArray(item.items) ? { items: item.items } : {}),
          ...(typeof item.fn === "string" ? { fn: item.fn } : {}),
          ...(item.options && typeof item.options === "object"
            ? { options: item.options as JobOptions | SweepOptions }
            : {}),
          ...(item.mode === "sweep" ? { mode: "sweep" as const } : {}),
          ...(typeof item.error === "string" ? { error: item.error } : {}),
          ...(typeof item.artifact === "string" ? { artifact: item.artifact } : {}),
        });
      }
    })
    .catch(() => undefined);
  return jobsRestored;
}

export function emptyJob(jobId: string, chatId: string, total: number): Job {
  return {
    run: {
      kind: "browser.code.run",
      cellId: jobId,
      chatId,
      toolCallId: "job-" + jobId,
      code: "browser.job",
      targets: [],
      timeoutMs: 600_000,
    },
    socket: undefined as unknown as WebSocket,
    identity: undefined as unknown as BrowserIdentity,
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
    done: true,
    popupsAtStart: 0,
    status: "complete",
    startedAt: Date.now(),
    total,
  };
}

let jobsWriting = Promise.resolve();
export function saveJobs(): Promise<void> {
  const saved = [...jobs.values()].map((job) => {
    const text = JSON.stringify(job.results) ?? "";
    return {
      jobId: job.run.cellId,
      chatId: job.run.chatId,
      status: job.status,
      total: job.total,
      startedAt: job.startedAt,
      ...(job.finishedAt ? { finishedAt: job.finishedAt } : {}),
      ...(job.results && text.length <= 1_000_000 ? { results: job.results } : {}),
      ...(job.progress ? { progress: job.progress } : {}),
      ...(job.items && job.items.length <= 500 ? { items: job.items } : {}),
      ...(job.fn ? { fn: job.fn } : {}),
      ...(job.options ? { options: job.options } : {}),
      ...(job.mode ? { mode: job.mode } : {}),
      ...(job.error ? { error: job.error } : {}),
      ...(job.artifact ? { artifact: job.artifact } : {}),
    };
  });
  jobsWriting = jobsWriting
    .catch(() => undefined)
    .then(() => chrome.storage.session.set({ [JOB_STORAGE]: saved }))
    .catch(() => undefined);
  return jobsWriting;
}
