// A durable job store: long work (a feed read, a provider consult, a batch of site calls) is a
// record on disk with a status, attempts and a result, so it survives the process that started
// it. The store is deliberately small: create, start, progress, finish, fail, cancel, retry,
// list and recover. Running work is claimed by a host id; a job left running by a host that is
// gone comes back as failed/recoverable instead of staying "running" forever.

import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";

export type JobStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

export interface JobRecord {
  id: string;
  kind: string;
  label?: string;
  status: JobStatus;
  input?: unknown;
  result?: unknown;
  error?: string;
  /** 1-based attempt counter: how many times the job has been started. */
  attempts: number;
  maxAttempts: number;
  progress?: { done: number; total?: number; label?: string };
  /** The process that owns a running job. */
  hostId: string;
  recovered?: boolean;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
  meta?: Record<string, unknown>;
}

export interface JobStoreOptions {
  /** Defaults to <directory>/jobs. */
  folder?: string;
  /** Completed/failed jobs kept. Defaults to 200. */
  keep?: number;
  /** Identifies this process; defaults to host:pid:random. */
  hostId?: string;
  now?: () => Date;
}

export interface JobSpec {
  kind: string;
  label?: string;
  input?: unknown;
  maxAttempts?: number;
  meta?: Record<string, unknown>;
}

const DEFAULT_KEEP = 200;
let fallbackHost = "";

export function jobHostId(): string {
  if (!fallbackHost)
    fallbackHost = `${hostname()}:${process.pid}:${Math.random().toString(36).slice(2, 8)}`;
  return fallbackHost;
}

function folderOf(directory: string, options: JobStoreOptions = {}): string {
  return options.folder ?? join(directory, "jobs");
}

function clock(options: JobStoreOptions): Date {
  return options.now ? options.now() : new Date();
}

export async function createJob(
  directory: string,
  spec: JobSpec,
  options: JobStoreOptions = {},
): Promise<JobRecord> {
  const at = clock(options);
  const id = `job-${at.toISOString().replace(/[:.]/g, "-")}-${Math.random().toString(36).slice(2, 7)}`;
  const record: JobRecord = {
    id,
    kind: spec.kind,
    status: "queued",
    attempts: 0,
    maxAttempts: Math.max(1, spec.maxAttempts ?? 1),
    hostId: options.hostId ?? jobHostId(),
    createdAt: at.toISOString(),
    updatedAt: at.toISOString(),
    ...(spec.label ? { label: spec.label } : {}),
    ...(spec.input === undefined ? {} : { input: spec.input }),
    ...(spec.meta ? { meta: spec.meta } : {}),
  };
  await write(directory, record, options);
  return record;
}

export async function readJob(
  directory: string,
  id: string,
  options: JobStoreOptions = {},
): Promise<JobRecord | undefined> {
  try {
    return JSON.parse(
      await readFile(join(folderOf(directory, options), `${id}.json`), "utf8"),
    ) as JobRecord;
  } catch {
    return undefined;
  }
}

export async function updateJob(
  directory: string,
  id: string,
  patch: Partial<JobRecord>,
  options: JobStoreOptions = {},
): Promise<JobRecord> {
  const current = await readJob(directory, id, options);
  if (!current) throw new Error(`No job ${id}`);
  const next: JobRecord = {
    ...current,
    ...patch,
    updatedAt: clock(options).toISOString(),
  };
  await write(directory, next, options);
  return next;
}

export async function startJob(
  directory: string,
  id: string,
  options: JobStoreOptions = {},
): Promise<JobRecord> {
  const current = await readJob(directory, id, options);
  if (!current) throw new Error(`No job ${id}`);
  const at = clock(options).toISOString();
  return updateJob(
    directory,
    id,
    {
      status: "running",
      attempts: current.attempts + 1,
      startedAt: current.startedAt ?? at,
      hostId: options.hostId ?? jobHostId(),
      ...(current.recovered ? { recovered: false } : {}),
    } as Partial<JobRecord>,
    options,
  );
}

export async function progressJob(
  directory: string,
  id: string,
  progress: { done: number; total?: number; label?: string },
  options: JobStoreOptions = {},
): Promise<JobRecord> {
  return updateJob(directory, id, { progress }, options);
}

export async function finishJob(
  directory: string,
  id: string,
  result: unknown,
  options: JobStoreOptions = {},
): Promise<JobRecord> {
  return settle(directory, id, { status: "completed", result }, options);
}

export async function failJob(
  directory: string,
  id: string,
  error: unknown,
  options: JobStoreOptions = {},
): Promise<JobRecord> {
  return settle(directory, id, { status: "failed", error: message(error) }, options);
}

/** Clears fields that only make sense while a job is unfinished. */
async function settle(
  directory: string,
  id: string,
  patch: { status: JobStatus; result?: unknown; error?: string },
  options: JobStoreOptions,
): Promise<JobRecord> {
  const current = await readJob(directory, id, options);
  if (!current) throw new Error(`No job ${id}`);
  const next: JobRecord = {
    ...current,
    ...patch,
    finishedAt: clock(options).toISOString(),
    updatedAt: clock(options).toISOString(),
  };
  if (patch.error === undefined) delete next.error;
  await write(directory, next, options);
  return next;
}

export async function cancelJob(
  directory: string,
  id: string,
  reason = "Cancelled",
  options: JobStoreOptions = {},
): Promise<JobRecord> {
  return updateJob(
    directory,
    id,
    { status: "cancelled", error: reason, finishedAt: clock(options).toISOString() },
    options,
  );
}

/** Failed or cancelled jobs go back to queued; completed ones are left alone. */
export async function retryJob(
  directory: string,
  id: string,
  options: JobStoreOptions = {},
): Promise<JobRecord> {
  const current = await readJob(directory, id, options);
  if (!current) throw new Error(`No job ${id}`);
  if (current.status === "completed" || current.status === "running") return current;
  const next: JobRecord = {
    ...current,
    status: "queued",
    updatedAt: clock(options).toISOString(),
  };
  delete next.error;
  delete next.finishedAt;
  delete next.progress;
  delete next.recovered;
  await write(directory, next, options);
  return next;
}

export async function listJobs(
  directory: string,
  query: { status?: JobStatus | JobStatus[]; kind?: string; limit?: number } = {},
  options: JobStoreOptions = {},
): Promise<JobRecord[]> {
  const folder = folderOf(directory, options);
  const files = (await readdir(folder).catch(() => [] as string[])).filter((file) =>
    file.endsWith(".json"),
  );
  const jobs: JobRecord[] = [];
  for (const file of files) {
    const job = await readJob(directory, file.slice(0, -5), options);
    if (!job) continue;
    const statuses =
      query.status === undefined ? [] : Array.isArray(query.status) ? query.status : [query.status];
    if (statuses.length && !statuses.includes(job.status)) continue;
    if (query.kind && job.kind !== query.kind) continue;
    jobs.push(job);
  }
  jobs.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  return jobs.slice(0, query.limit ?? jobs.length);
}

/**
 * Jobs left running (or queued) by a different host are stale: the process that owned them is
 * gone. They become failed and recoverable, so a supervisor can retry them deliberately.
 */
export async function recoverJobs(
  directory: string,
  options: JobStoreOptions = {},
): Promise<{ recovered: JobRecord[]; live: number }> {
  const host = options.hostId ?? jobHostId();
  const running = await listJobs(directory, { status: ["running", "queued"] }, options);
  const recovered: JobRecord[] = [];
  for (const job of running) {
    if (job.hostId === host) continue;
    recovered.push(
      await updateJob(
        directory,
        job.id,
        {
          status: "failed",
          error: `Interrupted: the host that owned this job stopped (${job.hostId})`,
          recovered: true,
          finishedAt: clock(options).toISOString(),
        },
        options,
      ),
    );
  }
  return { recovered, live: running.length - recovered.length };
}

export interface RunJobOptions extends JobStoreOptions {
  spec: JobSpec;
  signal?: AbortSignal;
  onStart?: (job: JobRecord) => void;
}

/** Creates, starts and settles a job around one function; retries only when asked to. */
export async function runJob<T>(
  directory: string,
  options: RunJobOptions,
  work: (job: JobRecord, signal?: AbortSignal) => Promise<T>,
): Promise<{ job: JobRecord; value?: T; error?: string }> {
  const created = await createJob(directory, options.spec, options);
  let job = await startJob(directory, created.id, options);
  options.onStart?.(job);
  try {
    const value = await work(job, options.signal);
    job = await finishJob(directory, created.id, value, options);
    return { job, value };
  } catch (error) {
    job = await failJob(directory, created.id, error, options);
    return { job, error: message(error) };
  }
}

/** Removes settled jobs beyond the newest `keep`, so the folder cannot grow without bound. */
export async function pruneJobs(directory: string, options: JobStoreOptions = {}): Promise<number> {
  const keep = options.keep ?? DEFAULT_KEEP;
  const settled = await listJobs(
    directory,
    { status: ["completed", "failed", "cancelled"] },
    options,
  );
  const extra = settled.slice(keep);
  for (const job of extra)
    await rm(join(folderOf(directory, options), `${job.id}.json`), { force: true });
  return extra.length;
}

async function write(
  directory: string,
  record: JobRecord,
  options: JobStoreOptions,
): Promise<void> {
  const folder = folderOf(directory, options);
  await mkdir(folder, { recursive: true });
  const path = join(folder, `${record.id}.json`);
  const temporary = `${path}.${record.hostId.replace(/[^\w.-]+/g, "-")}.tmp`;
  await writeFile(temporary, JSON.stringify(record, null, 2) + "\n", "utf8");
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await rename(temporary, path);
      return;
    } catch {
      // Windows keeps a file briefly locked by a reader; the last attempt writes in place.
      if (attempt === 2) {
        await writeFile(path, await readFile(temporary));
        await rm(temporary, { force: true });
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
}

/** Last time a job record changed, for a host that watches the folder. */
export async function jobUpdatedAt(
  directory: string,
  id: string,
  options: JobStoreOptions = {},
): Promise<string | undefined> {
  try {
    return (await stat(join(folderOf(directory, options), `${id}.json`))).mtime.toISOString();
  } catch {
    return undefined;
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
