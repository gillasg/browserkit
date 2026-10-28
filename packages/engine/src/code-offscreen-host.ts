// The offscreen document hosts browser_code realms. It outlives the service worker, so they keep
// state while no cell is running.

export const OFFSCREEN = "code-offscreen.html";
let creating: Promise<void> | undefined;

export async function ensureOffscreen(): Promise<void> {
  if (await chrome.offscreen.hasDocument()) return;
  creating ??= chrome.offscreen
    .createDocument({
      url: OFFSCREEN,
      reasons: [chrome.offscreen.Reason.WORKERS, chrome.offscreen.Reason.USER_MEDIA],
      justification:
        "Runs browser_code cells in a persistent sandboxed JavaScript realm and records tabs the user asks for.",
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
