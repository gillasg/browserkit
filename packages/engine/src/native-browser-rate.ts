// A per-host budget for the extension's own requests. A page can fire twenty calls at once; the
// agent asking for the same endpoint in a loop is the usual cause of a self-inflicted 429. This
// spaces requests to one host instead of letting the site rate-limit us.

export class HostBudget {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly limit = 30,
    private readonly windowMs = 10_000,
    private readonly now: () => number = Date.now,
  ) {}

  /** How long to wait before this request may go out; the slot is reserved. */
  take(host: string): number {
    const now = this.now();
    const recent = (this.hits.get(host) ?? []).filter((at) => now - at < this.windowMs);
    let wait = 0;
    if (recent.length >= this.limit) {
      const oldest = recent[0] ?? now;
      wait = Math.max(1, this.windowMs - (now - oldest) + 5);
    }
    recent.push(now + wait);
    this.hits.set(host, recent.slice(-Math.max(this.limit * 2, 40)));
    return wait;
  }

  /** For diagnostics: the requests this budget is still counting for a host. */
  recent(host: string): number {
    const now = this.now();
    return (this.hits.get(host) ?? []).filter((at) => now - at < this.windowMs).length;
  }
}
