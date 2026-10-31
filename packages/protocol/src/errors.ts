// The closed set of failures, for the browser and for everything Node-side (crawl, mapped sites,
// abilities). Each code carries the one move that recovers from it and who it belongs to:
//
// - model: the agent asked for something wrong (a bad selector, a missing input, its own code threw).
// - page:  the website did it (an overlay, a crash, a bot wall, a slow or broken site).
// - user:  the user's choice or setup (a blocked site, Cancel on the debugging bar, Chrome closed).
// - ours:  a bug or gap in browserkit. Every one of these is a defect to fix, never expected.
//
// A failure no code names is INTERNAL (ours): an unnamed failure is itself a bug.

export type ErrorOwner = "model" | "page" | "user" | "ours";

export const ERRORS = {
  TARGET_NOT_FOUND: [
    "model",
    "nothing on the page matches: read bu.state() and pick a listed element",
  ],
  AMBIGUOUS_TARGET: ["model", "several elements match: narrow the selector or use a bu id"],
  TARGET_HIDDEN: [
    "model",
    "the element is not visible: open the menu or section that holds it first",
  ],
  TARGET_DISABLED: ["model", "the control is disabled: fill what it depends on first"],
  TARGET_BLOCKED: ["page", "something covers the element: close the overlay first (bu.clear())"],
  TARGET_LOST: ["page", "the element or page changed under the step: read bu.state() again"],
  NOT_EDITABLE: ["model", "the element does not take typing: target its input"],
  INPUT_FAILED: ["ours", "typing did not land: click the field, then type again"],
  STALE_REF: ["model", "that bu id is from an older read: read bu.state() again"],
  TAB_DEAD: ["page", "the tab was closed or crashed: open a new one with browser.openTab(url)"],
  DEBUGGER_DETACHED: [
    "user",
    "Chrome dropped control of this tab (usually Cancel on its debugging bar): the next step takes it back; if it happens again, tell the user and stop",
  ],
  USER_TAB: [
    "model",
    "this tab is the user's: read and fill it in place, but open your own with browser.openTab(url) to go anywhere else",
  ],
  USER_HAS_CONTROL: ["user", "the user is using this tab: wait, or ask them"],
  USER_TOOK_CONTROL: [
    "user",
    "the user took this tab over: page.waitForControl() waits until it is given back",
  ],
  EXPECTATION_FAILED: [
    "model",
    "the page is not in the state the code expected: read bu.state() and adjust",
  ],
  PROTECTED_UI: [
    "user",
    "another extension's popup (usually a password manager's menu) keeps blocking this tab: ask the user to close it or finish the step (bu.handoff), then continue",
  ],
  CLAIM_CONFLICT: ["model", "another run holds this tab: open your own"],
  RUN_RESET: [
    "user",
    "this chat was stopped or reset while the step ran: start again from a fresh read",
  ],
  TIMEOUT: ["page", "the step took too long: check the page with bu.state() before retrying once"],
  SITE_BLOCKED: [
    "user",
    "the user blocked this site for agents: do not try another route; tell them",
  ],
  UNSUPPORTED: ["page", "this browser cannot do that here: use another way"],
  INVALID_TARGET: ["model", "the target is malformed: pass a tab, a page or a bu id"],
  BROWSER_OFFLINE: ["user", "the browser is not connected: ask the user to open Chrome"],
  DAEMON_OFFLINE: ["ours", "the local service is not running: ask the user to start it"],
  CHROME_ERROR: [
    "ours",
    "Chrome refused the step; its own message follows: change the step, do not repeat it",
  ],
  INVALID_INPUT: ["model", "a required input is missing or malformed: fix it and call again"],
  CODE_ERROR: ["model", "your code threw: fix the code (read the message), not the page"],
  NOT_MAPPED: [
    "model",
    "that site has no learned API yet: use the page, or site_mapper explore it first",
  ],
  SIGNED_OUT: ["user", "the site needs the user signed in: try bu.signIn(), else ask the user"],
  BOT_WALL: [
    "page",
    "the site's bot check refused the call: use the page in a tab; re-recording cannot fix it",
  ],
  SITE_BROKEN: [
    "page",
    "the site answered with an error or changed: retry once, then use the page instead",
  ],
  NETWORK: ["page", "the site could not be reached: retry once, then report it"],
  ABILITY_NEEDS: [
    "ours",
    "this host cannot run that way of the ability: run it where a browser is attached",
  ],
  INTERNAL: ["ours", "browserkit failed unexpectedly: report it; do not retry the same call"],
} as const satisfies Record<string, readonly [ErrorOwner, string]>;

export type ErrorCode = keyof typeof ERRORS;

export const ERROR_CODES = Object.keys(ERRORS) as ErrorCode[];

export function isErrorCode(value: string): value is ErrorCode {
  return Object.prototype.hasOwnProperty.call(ERRORS, value);
}

export function errorOwner(code: string): ErrorOwner {
  return isErrorCode(code) ? ERRORS[code][0] : "ours";
}

export function errorHint(code: string): string {
  return isErrorCode(code) ? ERRORS[code][1] : "";
}

/** "CODE: detail" plus the recovery hint, as the model sees it. */
export function describeError(code: string, detail = ""): string {
  const head = detail && detail !== code ? `${code}: ${detail}` : code;
  const hint = errorHint(code);
  return hint ? `${head}\nHint: ${hint}` : head;
}

/**
 * Narrower codes a feature throws, each standing for one shared code (and so one owner). The
 * narrow code stays in the message as detail; the shared one leads it.
 */
export const ERROR_ALIASES: Readonly<Record<string, ErrorCode>> = {
  // The model asked for something malformed or impossible.
  INVALID_RULE: "INVALID_INPUT",
  INVALID_ARGUMENT: "INVALID_INPUT",
  INVALID_PERMISSION: "INVALID_INPUT",
  INVALID_CDP_COMMAND: "INVALID_INPUT",
  INVALID_QUERY: "INVALID_INPUT",
  INVALID_EXTENSION_ID: "INVALID_INPUT",
  INVALID_ELEMENT: "INVALID_TARGET",
  WINDOW_ID: "INVALID_INPUT",
  SITE_UNKNOWN: "INVALID_INPUT",
  UNKNOWN_SETTING: "INVALID_INPUT",
  ZOOM: "INVALID_INPUT",
  TAB_SPLIT: "INVALID_INPUT",
  TOO_EARLY: "INVALID_INPUT",
  TOO_LARGE: "INVALID_INPUT",
  RESULT_TOO_LARGE: "INVALID_INPUT",
  COOKIES_FILTER_REQUIRED: "INVALID_INPUT",
  COLLECT_ROW: "INVALID_INPUT",
  EXTRACT_SCRIPT: "INVALID_INPUT",
  EXTRACT_SCHEMA: "INVALID_INPUT",
  CHALLENGE_STAGE_UNKNOWN: "INVALID_INPUT",
  NOT_RECORDING: "INVALID_INPUT",
  RECORDING_ACTIVE: "INVALID_INPUT",
  JOB_NOT_RESUMABLE: "INVALID_INPUT",
  SCREENSHOT_DIFF_PATH: "INVALID_INPUT",
  SCREENSHOT_DIFF_IMAGE: "INVALID_INPUT",
  SCREENSHOT_DIFF_THRESHOLD: "INVALID_INPUT",
  SCREENSHOT_BASELINE_REQUIRED: "INVALID_INPUT",
  SCREENSHOT_SIZE_MISMATCH: "EXPECTATION_FAILED",
  NOT_FOUND: "TARGET_NOT_FOUND",
  NO_OPTION: "TARGET_NOT_FOUND",
  NO_FRAME: "TARGET_NOT_FOUND",
  FRAME: "TARGET_NOT_FOUND",
  FRAME_NOT_FOUND: "TARGET_NOT_FOUND",
  AMBIGUOUS_PDF: "AMBIGUOUS_TARGET",
  NO_TAB: "INVALID_TARGET",
  NO_CONTEXT: "INVALID_TARGET",
  // The page or the site.
  HTTP: "SITE_BROKEN",
  GOOGLE_BLOCKED: "BOT_WALL",
  GOOGLE_FAILED: "NETWORK",
  DOWNLOAD_FAILED: "NETWORK",
  DOWNLOAD_INTERRUPTED: "NETWORK",
  PDF_TEXT_UNAVAILABLE: "UNSUPPORTED",
  CLIPBOARD_UNAVAILABLE: "UNSUPPORTED",
  // The user's choice or setup.
  PRIVATE_NETWORK: "SITE_BLOCKED",
  EXTENSION_BLOCKED: "SITE_BLOCKED",
  HANDOFF_CANCELLED: "RUN_RESET",
  DEMONSTRATION_STOPPED: "RUN_RESET",
  CLOSED_BY_YOU: "RUN_RESET",
  // Ours: Chrome refused something we asked it for.
  TAB_CLOSE_FAILED: "CHROME_ERROR",
  SCREENSHOT_CAPTURE_FAILED: "CHROME_ERROR",
  SCREENSHOT_DECODE_FAILED: "CHROME_ERROR",
  RECORDING_FAILED: "CHROME_ERROR",
  COOKIES_SET: "CHROME_ERROR",
  COOKIES_REMOVE: "CHROME_ERROR",
  CLIPBOARD_BUSY: "TIMEOUT",
};

/** The shared code a message leads with ("TARGET_BLOCKED: covered by …"), aliases included. */
export function leadingCode(message: string): ErrorCode | undefined {
  const head = /^([A-Z_]+)(?::|\s|$)/.exec(message)?.[1] ?? "";
  return isErrorCode(head) ? head : ERROR_ALIASES[head];
}

/**
 * Who wrote the code that threw. A TypeError in the model's own browser code is the model's
 * (CODE_ERROR); the same TypeError in a tool's Node code is ours (INTERNAL).
 */
export type ErrorSource = "model-code" | "tool";

/**
 * Names a failure: its own code when it leads with one, else the code its words mean; anything
 * left over is INTERNAL, a bug to fix.
 */
export function classifyError(error: unknown, source: ErrorSource = "tool"): ErrorCode {
  const message = error instanceof Error ? error.message : String(error);
  const named = leadingCode(message);
  if (named) return named;
  for (const [pattern, code] of NAMED) if (pattern.test(message)) return code;
  if (source === "model-code" && (jsErrorName(error) || JS_ERROR.test(message)))
    return "CODE_ERROR";
  return "INTERNAL";
}

/**
 * The model-facing text of a failure in the model's browser code: led by its shared code, the
 * narrower code or the JavaScript error name kept as detail.
 */
export function nameModelCodeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const head = /^([A-Z_]+)(?::|\s|$)/.exec(message)?.[1] ?? "";
  if (isErrorCode(head)) return message;
  const code = classifyError(error, "model-code");
  const name = jsErrorName(error);
  return `${code}: ${name && !message.startsWith(name) ? `${name}: ${message}` : message}`;
}

function jsErrorName(error: unknown): string {
  const name = error instanceof Error ? error.name : "";
  return /^(TypeError|ReferenceError|SyntaxError|RangeError|URIError|EvalError|DataCloneError)$/.test(
    name,
  )
    ? name
    : "";
}

// The model's own JavaScript, when the thrown value lost its class on the way (a realm boundary).
const JS_ERROR =
  /is not defined|is not a function|is not a constructor|is not iterable|Cannot (read|set) properties of|Unexpected (token|end of|identifier|non-whitespace|string|number)|is not valid JSON|Invalid regular expression|could not be cloned|Assignment to constant|Maximum call stack|Failed to fetch dynamically imported module/;

const NAMED: ReadonlyArray<[RegExp, ErrorCode]> = [
  // A schema refusing a request we built (a zod issue list) is ours, never the model's.
  [/^\[\s*\{\s*"(origin|code|expected)"/, "INTERNAL"],
  // Browser and runtime failures that arrive without a code.
  [/different extension|Cannot access a chrome-extension/i, "PROTECTED_UI"],
  [/Detached while handling command/i, "TARGET_LOST"],
  [/did not respond/i, "INTERNAL"],
  [/runtime reset|workflow cancelled|cell is no longer active/i, "RUN_RESET"],
  [/^No page is open yet/, "INVALID_TARGET"],
  [/before using an id/, "STALE_REF"],
  [/^Failed to fetch$/, "NETWORK"],
  // Mapped sites' and abilities' own codes.
  [
    /^(SITE_TOOL_(INVALID|PARAMS)|SITE_TOOLS_TOO_LARGE|INVALID_ABILITY_NAME|INVALID_ARGUMENT|MODEL_REQUIRED|YOUTUBE_URL|ABILITY_(EXISTS|BAD_WAY|BAD_SCRIPT|NO_WAYS|INPUT_UNUSED|CONTRACT_WEAKENED|BAD_CURSOR|TEST_WRITE))\b/,
    "INVALID_INPUT",
  ],
  [/^(SITE_TOOL_UNKNOWN|SITE_PAGE_TOOL_UNKNOWN|ABILITY_UNKNOWN)\b/, "NOT_MAPPED"],
  [/^(ABILITY_TIMEOUT|PROVIDER_TIMEOUT)\b/, "TIMEOUT"],
  [/^(INPUT_NOT_APPLIED|MEDIA_EMPTY|ABILITY_FAILED)\b/, "SITE_BROKEN"],
  [/^Challenged|bot (wall|check)|captcha|cloudflare|datadome|perimeterx|akamai/i, "BOT_WALL"],
  [/signed[ -]out|not signed in|log ?in required|session (expired|missing)/i, "SIGNED_OUT"],
  [/not mapped|no (learned )?api|unknown site|has no ability|ABILITY_UNKNOWN/i, "NOT_MAPPED"],
  [/^Give |required|missing (the )?\w+|invalid (input|param|argument)|must be/i, "INVALID_INPUT"],
  [/ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|fetch failed|network|socket hang up/i, "NETWORK"],
  [/HTTP (4\d\d|5\d\d)|status (4\d\d|5\d\d)|ABILITY_FAILED|site_broken|broken/i, "SITE_BROKEN"],
  [/timed? ?out|deadline/i, "TIMEOUT"],
  [/No browser is attached|browser (is )?not connected|BrowserNotConnected/i, "BROWSER_OFFLINE"],
];
