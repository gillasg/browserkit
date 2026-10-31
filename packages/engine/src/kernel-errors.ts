// The kernel's closed set of failures. Every error a browser step raises is one of these codes,
// and each carries the one move that recovers from it, so the model never has to guess what a
// bare failure meant. help('errors') prints this table.

export const KERNEL_ERRORS = {
  TARGET_NOT_FOUND: "nothing on the page matches: read bu.state() and pick a listed element",
  AMBIGUOUS_TARGET: "several elements match: narrow the selector or use a bu id",
  TARGET_HIDDEN: "the element is not visible: open the menu or section that holds it first",
  TARGET_DISABLED: "the control is disabled: fill what it depends on first",
  TARGET_BLOCKED: "something covers the element: close the overlay first (bu.clear())",
  TARGET_LOST: "the element or page changed under the step: read bu.state() again",
  NOT_EDITABLE: "the element does not take typing: target its input",
  INPUT_FAILED: "typing did not land: click the field, then type again",
  STALE_REF: "that bu id is from an older read: read bu.state() again",
  TAB_DEAD: "the tab was closed or crashed: open a new one with browser.openTab(url)",
  DEBUGGER_DETACHED:
    "Chrome dropped control of this tab (usually Cancel on its debugging bar): the next step takes it back; if it happens again, tell the user and stop",
  USER_TAB:
    "this tab is the user's: read and fill it in place, but open your own with browser.openTab(url) to go anywhere else",
  USER_HAS_CONTROL: "the user is using this tab: wait, or ask them",
  CLAIM_CONFLICT: "another run holds this tab: open your own",
  RUN_RESET: "this chat was stopped or reset while the step ran: start again from a fresh read",
  TIMEOUT: "the step took too long: check the page with bu.state() before retrying once",
  SITE_BLOCKED: "the user blocked this site for agents: do not try another route; tell them",
  UNSUPPORTED: "this browser cannot do that here: use another way",
  INVALID_TARGET: "the target is malformed: pass a tab, a page or a bu id",
  BROWSER_OFFLINE: "the browser is not connected: ask the user to open Chrome",
  DAEMON_OFFLINE: "the local service is not running: ask the user to start it",
  CHROME_ERROR:
    "Chrome refused the step; its own message follows: change the step, do not repeat it",
} as const;

export type KernelErrorCode = keyof typeof KERNEL_ERRORS;

export const KERNEL_ERROR_CODES = Object.keys(KERNEL_ERRORS) as KernelErrorCode[];

export function isKernelErrorCode(value: string): value is KernelErrorCode {
  return Object.prototype.hasOwnProperty.call(KERNEL_ERRORS, value);
}

/** "CODE: detail" plus the recovery hint, as the model sees it. */
export function describeKernelError(code: string, detail = ""): string {
  const head = detail && detail !== code ? `${code}: ${detail}` : code;
  const hint = isKernelErrorCode(code) ? KERNEL_ERRORS[code] : "";
  return hint ? `${head}\nHint: ${hint}` : head;
}
