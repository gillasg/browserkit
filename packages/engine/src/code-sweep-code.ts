// A sweep is a job whose per-item function is generated here: open, get past the gate, wait,
// capture, read, close. It uses the same realm, durability, progress and resume as browser.job;
// the caller gets one record per URL with an outcome and (optionally) evidence.
import type { JobOptions } from "./code-job-code.js";

export interface SweepOptions extends JobOptions {
  /** Run only this many, then stop (evidence for a look before committing). */
  pilot?: number;
  /** Resume by name: a running or lost sweep with the same name continues. */
  checkpoint?: string;
  /** Dismiss gates and click the affirmative control. */
  gate: boolean;
  /** "network" keeps interesting requests, "media" parses manifests, false records neither. */
  capture: "network" | "media" | false;
  /** If nothing was captured, click a play/watch control once and look again. */
  play: boolean;
  /** Save each item's screenshot, text and network summary in the session workspace. */
  evidence: boolean;
  /** Source of an optional (page, item) function, run after the capture. */
  each?: string;
  /** Outcomes that a checkpoint resume re-runs. */
  retry?: string[];
}

const OUTCOMES = new Set([
  "ok",
  "gated",
  "shell",
  "dead",
  "parked",
  "redirected",
  "blocked",
  "error",
]);

export function sweepOptions(value: unknown): SweepOptions {
  const options = (value ?? {}) as Record<string, unknown>;
  const count = (item: unknown, fallback: number, max: number) => {
    const number = Math.floor(Number(item));
    return Number.isFinite(number) ? Math.min(max, Math.max(1, number)) : fallback;
  };
  const capture =
    options.capture === "media" ? "media" : options.capture === false ? false : "network";
  const retry = Array.isArray(options.retry)
    ? options.retry.map(String).filter((item) => OUTCOMES.has(item))
    : [];
  return {
    concurrency: count(options.concurrency, 4, 10),
    maxTabs: count(options.maxTabs, 4, 10),
    timeoutMs: count(options.timeoutMs, 45_000, 600_000),
    quiet: options.quiet !== false,
    label: typeof options.label === "string" ? options.label.slice(0, 200) : "Sweep",
    ...(Number.isFinite(Number(options.pilot)) && Number(options.pilot) > 0
      ? { pilot: count(options.pilot, 1, 500) }
      : {}),
    ...(typeof options.checkpoint === "string" && options.checkpoint.trim()
      ? { checkpoint: options.checkpoint.trim().slice(0, 80) }
      : {}),
    gate: options.gate !== false,
    capture,
    play: options.play === true,
    evidence: options.evidence === true,
    ...(typeof options.each === "string" && options.each.trim()
      ? { each: options.each.slice(0, 200_000) }
      : {}),
    ...(retry.length ? { retry } : {}),
  };
}

/**
 * The job's per-item function. judge and domain are the pure functions from outcomes.ts, passed
 * in as source so there is one classifier, not a copy per realm.
 */
export function sweepCode(spec: {
  jobId: string;
  urls: unknown[];
  options: SweepOptions;
  offset?: number;
  judge: string;
  domain: string;
}): string {
  return `(async () => {
  const spec = ${JSON.stringify({ jobId: spec.jobId, urls: spec.urls, options: spec.options, offset: spec.offset ?? 0 })};
  const registrableDomain = (${spec.domain});
  const judgeOutcome = (${spec.judge});
  const options = spec.options, items = spec.urls, offset = spec.offset || 0;
  const results = new Array(offset);
  let next = 0, done = offset;
  const limit = Math.max(1, Math.min(options.concurrency, options.maxTabs, items.length));
  const INTERESTING = /\\.(m3u8|mpd|mp4|webm|m4s|ts)(\\?|$)|json|octet-stream|video\\//i;
  async function grab(tab) {
    const entries = await tab.network.list({frames:'all'}).catch(() => []);
    return (entries || []).filter((entry) => INTERESTING.test(entry.url + ' ' + (entry.mimeType || '')));
  }
  async function one(tab, item, index) {
    const url = String(item && item.url || item);
    const started = Date.now();
    let ready = null, gate = null, captured = [], media = null, playClicked = null, evidence = null;
    try {
      ready = await tab.waitReady({timeoutMs: options.timeoutMs});
      if (options.gate) {
        gate = await tab.enterSite().catch(() => null);
        if (gate && gate.clicked) {
          await tab.wait(600);
          ready = await tab.waitReady({timeoutMs: options.timeoutMs});
        }
      }
      captured = options.capture === false ? [] : await grab(tab);
      if (options.capture === 'media') media = await tab.media().catch(() => null);
      if (!captured.length && !(media && media.masters && media.masters.length) && options.play) {
        playClicked = await tab.evaluate(() => {
          const pattern = /play|watch|start|▶|►/i;
          const nodes = [...document.querySelectorAll('button,[role=button],a,video')];
          const el = nodes.find((node) => pattern.test((node.innerText || node.getAttribute('aria-label') || node.title || '').trim()));
          if (!el) return null;
          el.click();
          return (el.innerText || el.getAttribute('aria-label') || 'play').trim().slice(0, 40);
        }).catch(() => null);
        if (playClicked) {
          await tab.wait(1800);
          captured = options.capture === false ? [] : await grab(tab);
          if (options.capture === 'media') media = await tab.media().catch(() => null);
          try { await __call({learn:{url: String(await tab.url().catch(() => url)), play: true}}); } catch {}
        }
      }
      const finalUrl = await tab.url().catch(() => url);
      const title = await tab.title().catch(() => '');
      if (options.evidence) {
        const text = await tab.evaluate(() => document.body ? document.body.innerText.slice(0, 1200) : '').catch(() => '');
        let saved = null;
        try {
          const shot = await tab.screenshot();
          const base64 = shot && (shot.dataBase64 || (shot.data && shot.data.dataBase64));
          if (base64) {
            const name = 'sweep/' + (options.checkpoint || spec.jobId) + '/' + (offset + index) + '.png';
            await __call({workspace:'artifact', name, value: base64, base64:true});
            saved = name;
          }
        } catch {}
        evidence = {finalUrl, title, text, screenshot: saved, network: captured.slice(-8).map((entry) => entry.method + ' ' + entry.status + ' ' + entry.url.slice(0, 160))};
      }
      let extra = null;
      if (options.each) extra = await (0, eval)('(' + options.each + ')')(tab, item);
      const judged = judgeOutcome({readiness: ready && ready.state, captured: captured.length + (media && media.masters && media.masters.length ? 1 : 0), gate: gate && gate.gate, gateClicked: !!(gate && gate.clicked), challenge: ready && ready.state === 'challenge', requestedUrl: url, finalUrl});
      return {url, finalUrl, title, outcome: judged.outcome, reason: judged.reason, readiness: ready && ready.state, gate, playClicked, captured: captured.length, media, evidence, extra, ms: Date.now() - started};
    } catch (error) {
      return {url, outcome: 'error', reason: String(error && error.message || error).slice(0, 300), gate, playClicked, captured: captured.length, ms: Date.now() - started};
    }
  }
  await Promise.all(Array.from({length:limit}, async () => {
    while (next < items.length) {
      const index = next++;
      const item = items[index];
      const url = String(item && item.url || item);
      let tab;
      try {
        tab = await browser.openTab(url, {newTab:true, quiet:options.quiet});
        results[offset + index] = await one(tab, item, index);
      } catch (error) {
        results[offset + index] = {url, outcome:'error', reason:String(error && error.message || error).slice(0,300)};
      } finally {
        if (tab && !__keptTabs.has(tab.target.tabId)) await tab.close().catch(() => {});
      }
      done++;
      await __call({job:{action:'item', id:spec.jobId, index:offset + index, result:results[offset + index]}}).catch(() => {});
      bu.progress(done, offset + items.length, options.label);
    }
  }));
  return {jobId: spec.jobId, complete: true, total: offset + items.length, offset, results, finishedAt: Date.now()};
})()`;
}
