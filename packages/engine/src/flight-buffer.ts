// The flight ring: the last 120 seconds of low-rate frames, capped at 40 MB across tabs. Pure so
// the order, age eviction and total cap can be tested without a browser.

export interface FlightFrame {
  at: number;
  data: string;
  bytes: number;
}

export interface FlightRecord {
  chatId: string;
  startedAt: number;
  frames: FlightFrame[];
  bytes: number;
}

export const FLIGHT_MAX_BYTES = 40 * 1024 * 1024;
export const FLIGHT_MAX_MS = 120_000;

export class FlightRing {
  private readonly tabs = new Map<number, FlightRecord>();
  private total = 0;

  get totalBytes(): number {
    return this.total;
  }

  add(tabId: number, chatId: string, at: number, data: string): void {
    const record = this.tabs.get(tabId) ?? {
      chatId,
      startedAt: at,
      frames: [],
      bytes: 0,
    };
    const bytes = Math.round(data.length * 0.75);
    record.frames.push({ at, data, bytes });
    record.bytes += bytes;
    this.total += bytes;
    this.tabs.set(tabId, record);
    this.prune(at);
  }

  get(tabId: number): FlightRecord | undefined {
    return this.tabs.get(tabId);
  }

  status(tabId: number): { frames: number; durationMs: number; bytes: number; startedAt: number } {
    const record = this.tabs.get(tabId);
    if (!record?.frames.length) return { frames: 0, durationMs: 0, bytes: 0, startedAt: 0 };
    return {
      frames: record.frames.length,
      durationMs: (record.frames.at(-1)?.at ?? 0) - (record.frames[0]?.at ?? 0),
      bytes: record.bytes,
      startedAt: record.startedAt,
    };
  }

  clear(tabId: number): void {
    const record = this.tabs.get(tabId);
    if (record) this.total -= record.bytes;
    this.tabs.delete(tabId);
  }

  clearAll(): void {
    this.tabs.clear();
    this.total = 0;
  }

  private prune(newest: number): void {
    for (const [tabId, record] of this.tabs) {
      while (record.frames.length && newest - (record.frames[0]?.at ?? newest) > FLIGHT_MAX_MS) {
        const frame = record.frames.shift();
        if (!frame) break;
        record.bytes -= frame.bytes;
        this.total -= frame.bytes;
      }
      if (!record.frames.length) this.tabs.delete(tabId);
    }
    while (this.total > FLIGHT_MAX_BYTES) {
      let oldest: { tabId: number; at: number } | undefined;
      for (const [tabId, record] of this.tabs) {
        const at = record.frames[0]?.at;
        if (at !== undefined && (!oldest || at < oldest.at)) oldest = { tabId, at };
      }
      if (!oldest) break;
      const record = this.tabs.get(oldest.tabId);
      const frame = record?.frames.shift();
      if (!record || !frame) break;
      record.bytes -= frame.bytes;
      this.total -= frame.bytes;
      if (!record.frames.length) this.tabs.delete(oldest.tabId);
    }
  }
}
