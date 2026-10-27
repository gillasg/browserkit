// Manual screencast ownership for page.recordTab and page.recordMedia. The engine must not issue
// its own Page.startScreencast while a page-driven recording owns the stream.
const manual = new Set<number>();

export function beginManualScreencast(tabId: number): void {
  manual.add(tabId);
}

export function endManualScreencast(tabId: number): Promise<void> {
  manual.delete(tabId);
  return Promise.resolve();
}

export async function withManualScreencast<T>(
  tabId: number,
  method: string,
  run: () => Promise<T>,
): Promise<T> {
  const start = method === "Page.startScreencast";
  const stop = method === "Page.stopScreencast";
  if (start) beginManualScreencast(tabId);
  try {
    return await run();
  } catch (error) {
    if (start) await endManualScreencast(tabId);
    throw error;
  } finally {
    if (stop) await endManualScreencast(tabId);
  }
}
