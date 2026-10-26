// The offscreen document hosts browser_code realms and the flight recorder. It outlives the
// service worker, so both keep state while no cell is running.

export const OFFSCREEN = "code-offscreen.html";
let creating: Promise<void> | undefined;

export async function ensureOffscreen(): Promise<void> {
  if (await chrome.offscreen.hasDocument()) return;
  creating ??= chrome.offscreen
    .createDocument({
      url: OFFSCREEN,
      reasons: [chrome.offscreen.Reason.WORKERS],
      justification: "Runs browser_code cells in a persistent sandboxed JavaScript realm.",
    })
    .catch((error: unknown) => {
      if (!String(error).includes("Only a single offscreen")) throw error;
    })
    .finally(() => {
      creating = undefined;
    });
  await creating;
}

export async function toOffscreen(message: Record<string, unknown>): Promise<unknown> {
  await ensureOffscreen();
  return chrome.runtime.sendMessage(message);
}
