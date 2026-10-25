// Browser jobs outlive the cell that started them: their state is kept in session storage and
// restored when the worker restarts, so browser.job status still answers.
import type { Cell } from "./code-runtime-host.js";
import type { BrowserIdentity } from "./native-worker-identity.js";

export const jobs = new Map<string, Job>();
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
