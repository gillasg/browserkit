import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  cancelJob,
  createJob,
  failJob,
  finishJob,
  listJobs,
  progressJob,
  pruneJobs,
  readJob,
  recoverJobs,
  retryJob,
  runJob,
  startJob,
} from "../dist/jobs.js";

async function tempDir(t) {
  const dir = await mkdtemp(join(tmpdir(), "browserkit-jobs-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test("a job is created, started, progressed and finished", async (t) => {
  const dir = await tempDir(t);
  const created = await createJob(dir, { kind: "feed", label: "X thread" }, { hostId: "host-a" });
  assert.equal(created.status, "queued");
  assert.equal(created.attempts, 0);

  const started = await startJob(dir, created.id, { hostId: "host-a" });
  assert.equal(started.status, "running");
  assert.equal(started.attempts, 1);

  const progressed = await progressJob(
    dir,
    created.id,
    { done: 3, total: 10 },
    { hostId: "host-a" },
  );
  assert.deepEqual(progressed.progress, { done: 3, total: 10 });

  const finished = await finishJob(dir, created.id, { records: 3 }, { hostId: "host-a" });
  assert.equal(finished.status, "completed");
  assert.deepEqual(finished.result, { records: 3 });
  assert.ok(finished.finishedAt);

  const reread = await readJob(dir, created.id);
  assert.equal(reread.status, "completed");
});

test("a failure keeps the error and a retry queues it again", async (t) => {
  const dir = await tempDir(t);
  const job = await createJob(dir, { kind: "consult" }, { hostId: "host-a" });
  await startJob(dir, job.id, { hostId: "host-a" });
  const failed = await failJob(dir, job.id, new Error("provider refused"), { hostId: "host-a" });
  assert.equal(failed.status, "failed");
  assert.match(failed.error, /provider refused/);

  const retried = await retryJob(dir, job.id, { hostId: "host-a" });
  assert.equal(retried.status, "queued");
  assert.equal(retried.error, undefined);
  assert.equal(retried.finishedAt, undefined);
});

test("cancelling is terminal until retried", async (t) => {
  const dir = await tempDir(t);
  const job = await createJob(dir, { kind: "feed" }, { hostId: "host-a" });
  const cancelled = await cancelJob(dir, job.id, "user stopped it", { hostId: "host-a" });
  assert.equal(cancelled.status, "cancelled");
  assert.match(cancelled.error, /user stopped it/);
});

test("jobs left running by another host are recovered as failed", async (t) => {
  const dir = await tempDir(t);
  const stale = await createJob(dir, { kind: "feed" }, { hostId: "old-host" });
  await startJob(dir, stale.id, { hostId: "old-host" });
  const mine = await createJob(dir, { kind: "feed" }, { hostId: "new-host" });
  await startJob(dir, mine.id, { hostId: "new-host" });

  const result = await recoverJobs(dir, { hostId: "new-host" });
  assert.equal(result.recovered.length, 1);
  assert.equal(result.live, 1);
  assert.equal(result.recovered[0].id, stale.id);
  assert.equal(result.recovered[0].recovered, true);
  assert.match(result.recovered[0].error, /Interrupted/);

  const stillMine = await readJob(dir, mine.id);
  assert.equal(stillMine.status, "running");
});

test("a job survives the process that wrote it", async (t) => {
  const dir = await tempDir(t);
  const job = await createJob(
    dir,
    { kind: "feed", input: { url: "https://x.com/a" } },
    { hostId: "a" },
  );
  await startJob(dir, job.id, { hostId: "a" });

  // A new host reads the same folder: the record and its input are intact.
  const reread = await readJob(dir, job.id, { hostId: "b" });
  assert.equal(reread.input.url, "https://x.com/a");
  assert.equal(reread.status, "running");
  assert.equal(reread.hostId, "a");
});

test("runJob wraps work and settles the record either way", async (t) => {
  const dir = await tempDir(t);
  const okRun = await runJob(dir, { spec: { kind: "feed", label: "ok" } }, async () => ({
    count: 2,
  }));
  assert.equal(okRun.job.status, "completed");
  assert.deepEqual(okRun.value, { count: 2 });

  const failedRun = await runJob(dir, { spec: { kind: "feed" } }, async () => {
    throw new Error("boom");
  });
  assert.equal(failedRun.job.status, "failed");
  assert.match(failedRun.error, /boom/);
  assert.equal((await listJobs(dir, { status: "failed" })).length, 1);
});

test("pruning keeps the newest settled jobs", async (t) => {
  const dir = await tempDir(t);
  for (let index = 0; index < 5; index++) {
    const job = await createJob(
      dir,
      { kind: "feed" },
      { hostId: "a", now: () => new Date(2026, 0, 1, 0, 0, index) },
    );
    await finishJob(dir, job.id, index, { hostId: "a" });
  }
  const pruned = await pruneJobs(dir, { keep: 2 });
  assert.ok(pruned >= 3);
  assert.ok((await listJobs(dir)).length <= 2);
});
