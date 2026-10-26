import type { BrowserStep } from "@browserkit/protocol";
import { BrowserActionError } from "./native-browser-common.js";
import { controlOf, giveBack, waitForGiveBack } from "./native-browser-control.js";
import { claimSpace, finishSpace, listSpaces, resolveLabel } from "./native-browser-spaces.js";
import { refreshInventoryTab } from "./native-inventory-client.js";

type ControlStep = Extract<BrowserStep, { op: "control" | "session" }>;

/** The control and session steps: who drives a tab, and ending or handing over its space. */
export async function controlOrSessionStep(step: ControlStep, chatId: string): Promise<unknown> {
  if (step.op === "control") {
    if (step.action === "giveback") {
      const changed = giveBack(step.target.tabId);
      return { control: controlOf(step.target.tabId), changed };
    }
    if (step.action === "wait") {
      const given = await waitForGiveBack(step.target.tabId, step.timeoutMs);
      if (!given)
        throw new BrowserActionError(
          "TIMEOUT",
          "The user still has control of this tab; wait for them to give it back.",
        );
      return { control: controlOf(step.target.tabId) };
    }
    return { control: controlOf(step.target.tabId) };
  }
  if (step.action === "finish") return finishSpace(chatId, step.keep);
  if (step.action === "claim") return claimSpace(chatId);
  if (step.action === "resolve") {
    const hit = await resolveLabel(chatId, step.label ?? "");
    const tab = hit ? await refreshInventoryTab(hit.tabId) : undefined;
    if (!tab)
      throw new BrowserActionError(
        "TARGET_NOT_FOUND",
        "No tab has that label in this session; browser.tabs() shows each label.",
      );
    return { label: step.label, tab };
  }
  return { spaces: await listSpaces() };
}
