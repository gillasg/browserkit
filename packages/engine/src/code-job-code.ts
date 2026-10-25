// The code of one browser.job cell. It runs in its own sandbox realm in the offscreen document,
// so it keeps going after the browser_code cell that started it has returned.
export interface JobOptions {
  concurrency: number;
  maxTabs: number;
  timeoutMs: number;
  quiet: boolean;
  label: string;
}

export function jobOptions(value: unknown): JobOptions {
  const options = (value ?? {}) as Record<string, unknown>;
  const count = (item: unknown, fallback: number, max: number) => {
    const number = Math.floor(Number(item));
    return Number.isFinite(number) ? Math.min(max, Math.max(1, number)) : fallback;
  };
  return {
    concurrency: count(options.concurrency, 1, 10),
    maxTabs: count(options.maxTabs, 4, 10),
    timeoutMs: count(options.timeoutMs, 120_000, 600_000),
    quiet: options.quiet !== false,
    label: typeof options.label === "string" ? options.label.slice(0, 200) : "Job",
  };
}

export function jobCode(spec: {
  jobId: string;
  items: unknown[];
  fn: string;
  options: JobOptions;
  /** Resume: results before this index are already stored. */
  offset?: number;
}): string {
  return `(async () => {
  const spec = ${JSON.stringify(spec)};
  const fn = (${spec.fn});
  const items = spec.items, options = spec.options, results = new Array(spec.offset || 0);
  const offset = spec.offset || 0;
  let next = 0, done = offset;
  const limit = Math.max(1, Math.min(options.concurrency, options.maxTabs, items.length));
  async function one(index) {
    const item = items[index];
    const url = typeof item === 'string' ? item : item && item.url;
    const started = Date.now();
    if (!url) return {ok:false, item, error:'ITEM_NEEDS_URL: each job item needs a url', kind:'failed', ms:0};
    let tab, timer;
    try {
      tab = await browser.openTab(String(url), {newTab:true, quiet:options.quiet});
      const cutoff = new Promise((_, reject) => {
        timer = setTimeout(() => reject(Object.assign(new Error('TIMEOUT: item took longer than ' + options.timeoutMs + 'ms'), {timeout:true})), options.timeoutMs);
      });
      const value = await Promise.race([Promise.resolve(fn(tab, item, index)), cutoff]);
      return {ok:true, item, value, ms:Date.now()-started};
    } catch (error) {
      return {ok:false, item, error:String(error && error.message || error), kind:error && error.timeout ? 'timeout' : 'failed', ms:Date.now()-started};
    } finally {
      clearTimeout(timer);
      if (tab && !__keptTabs.has(tab.target.tabId)) await tab.close().catch(() => {});
    }
  }
  await Promise.all(Array.from({length:limit}, async () => {
    while (next < items.length) {
      const index = next++;
      results[offset + index] = await one(index);
      done++;
      // Each finished item is reported at once: the durable job record survives a lost
      // completion message, and a resume knows exactly where to start.
      await __call({job:{action:'item', id:spec.jobId, index:offset + index, result:results[offset + index]}}).catch(() => {});
      bu.progress(done, offset + items.length, options.label);
    }
  }));
  return {jobId: spec.jobId, complete: true, total: offset + items.length, offset, results, finishedAt: Date.now()};
})()`;
}
