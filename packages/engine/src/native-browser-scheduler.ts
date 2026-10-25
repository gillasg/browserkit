// Two locks keep several sessions from stepping on each other: a FIFO per tab, so a session's own
// steps stay in the order it issued them, and one browser-wide write lock, so only one session
// changes a page (clicks, typing, navigation, uploads) at a time. Reads run in parallel across
// tabs. Every wait is bounded; a stuck holder turns into BUSY_TIMEOUT instead of a hung agent.

import type { BrowserStep } from "@browserkit/protocol";

interface TabQueue {
  tail: Promise<unknown>;
  depth: number;
}

const queues = new Map<number, TabQueue>();
const WRITE_WAIT_MS = 30_000;

let writeTail: Promise<unknown> = Promise.resolve();
let writing = false;
let waitingWrites = 0;

const WRITE_OPS = new Set([
  "click",
  "fill",
  "press",
  "pointer",
  "keys",
  "upload",
  "navigate",
  "scroll",
  "downloads",
]);

export function isWriteStep(step: BrowserStep): boolean {
  if (!WRITE_OPS.has(step.op)) return false;
  if (step.op === "downloads") return step.action === "start" || step.action === "cancel";
  return true;
}

export async function inTabQueue<T>(tabId: number, work: () => Promise<T>): Promise<T> {
  const queue = queues.get(tabId) ?? { tail: Promise.resolve(), depth: 0 };
  queues.set(tabId, queue);
  queue.depth += 1;
  const run = queue.tail.then(work, work);
  queue.tail = run.then(
    () => undefined,
    () => undefined,
  );
  try {
    return await run;
  } finally {
    queue.depth -= 1;
    if (queue.depth === 0 && queues.get(tabId) === queue) queues.delete(tabId);
  }
}

export async function withWriteLock<T>(work: () => Promise<T>): Promise<T> {
  const previous = writeTail;
  let release!: () => void;
  writeTail = new Promise<void>((resolve) => {
    release = resolve;
  });
  waitingWrites += 1;
  try {
    await withDeadline(
      previous,
      WRITE_WAIT_MS,
      "BUSY_TIMEOUT: another session has been writing to this browser for 30s",
    );
    writing = true;
    return await work();
  } finally {
    writing = false;
    waitingWrites -= 1;
    release();
  }
}

export interface SchedulerStatus {
  write: { busy: boolean; waiting: number };
  tabs: { tabId: number; busy: boolean; waiting: number }[];
}

export function schedulerStatus(): SchedulerStatus {
  return {
    write: { busy: writing, waiting: waitingWrites },
    tabs: [...queues].map(([tabId, queue]) => ({
      tabId,
      busy: queue.depth > 0,
      waiting: Math.max(0, queue.depth - 1),
    })),
  };
}

/** Runs one dispatch under the per-tab FIFO and, for writes, the browser-wide lock. */
export async function scheduleStep<T>(
  step: BrowserStep,
  tabId: number,
  dispatch: () => Promise<T>,
): Promise<T> {
  if (isWriteStep(step)) return withWriteLock(() => inTabQueue(tabId, dispatch));
  return inTabQueue(tabId, dispatch);
}

async function withDeadline<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
