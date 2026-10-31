// One chat's browser_code realm. Runs in a manifest sandbox page, where eval is allowed and
// no extension APIs exist; every browser or workspace request goes to the parent document.
import { toReplScript } from "./code-repl.js";
import { errorHint, leadingCode, nameModelCodeError } from "@browserkit/protocol";
import { browserCodeApi } from "./code-api.js";
import { browserFastApi } from "./code-api-page.js";
import { browserCapabilityApi, browserDocumentApi } from "./code-api-hooks.js";
import { browserPlaywrightApi } from "./code-api-playwright.js";
import { browserDataApi } from "./code-api-data.js";
import { browserListApi } from "./code-api-list.js";
import { browserScrollersApi } from "./code-api-scrollers.js";
import { browserEventsApi } from "./code-api-events.js";
import { browserDemonstrationApi } from "./code-api-demonstration.js";
import { browserRecordingApi } from "./code-api-recording.js";
import { browserSitesApi } from "./code-api-sites.js";
import { browserContextApi } from "./code-api-context.js";
import { browserSnipeApi } from "./code-api-snipe.js";
import { browserTablesApi } from "./code-api-tables.js";
import { browserHelpApi } from "./code-api-help.js";
import { browserControlsApi } from "./code-api-controls.js";
import { browserMediaChallengesApi } from "./code-api-media-challenges.js";
import { browserMediaApi } from "./code-media-api.js";
import { browserSurfaceApi, browserWindowApi } from "./code-api-surface.js";

type Waiter = { resolve: (value: unknown) => void; reject: (error: Error) => void };
const scope = globalThis as unknown as Record<string, unknown>;
const evaluate = (source: string): unknown => (0, eval)(source);
const pending = new Map<string, Waiter>();
let cellId = "";
let sequence = 0;
let output = "";
let asynchronousError: string | undefined;

function format(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined) return "undefined";
  // page.url and page.title are callable strings; print them as the string they stand for.
  if (typeof value === "function" && Symbol.toPrimitive in value) return String(value);
  if (typeof value === "function") return `[Function ${value.name || "anonymous"}]`;
  try {
    return (
      JSON.stringify(
        value,
        (_key, item: unknown) => (typeof item === "bigint" ? String(item) : item),
        2,
      ) ?? String(value)
    );
  } catch {
    return String(value);
  }
}
/** Binary artifact data as bytes: typed arrays, ArrayBuffers, Blobs read first, or byte arrays. */
function asBytes(data: unknown): Uint8Array {
  if (data instanceof Uint8Array) return data;
  if (ArrayBuffer.isView(data))
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (Array.isArray(data)) return Uint8Array.from(data as number[]);
  throw new Error(
    "artifact() takes a string, Uint8Array, ArrayBuffer or byte array; for a Blob, pass new Uint8Array(await blob.arrayBuffer())",
  );
}
const print = (...values: unknown[]) => {
  output += values.map(format).join(" ") + "\n";
  if (output.length > 1_000_000)
    output =
      output.slice(0, 999_900) +
      "\n[Console limit reached; save large data with artifact() instead.]\n";
};
scope.console = Object.freeze({ log: print, info: print, warn: print, error: print, debug: print });
scope.__encodeBytes = (data: unknown) => {
  const bytes = asBytes(data);
  if (bytes.byteLength > 16_000_000) throw new Error("Binary artifact exceeds 16 MB; split it");
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  return btoa(binary);
};
// Skills are evaluated with the same REPL rules as cells, so `const helper = ...` persists.
scope.__repl = toReplScript;
scope.__call = (request: unknown) =>
  new Promise((resolve, reject) => {
    const callId = String(++sequence);
    pending.set(callId, { resolve, reject });
    parent.postMessage({ kind: "call", cellId, callId, request }, "*");
  });
evaluate(
  [
    browserWindowApi,
    browserSurfaceApi,
    browserMediaApi,
    browserCodeApi,
    browserSitesApi,
    browserContextApi,
    browserSnipeApi,
    browserTablesApi,
    browserHelpApi,
    browserFastApi,
    browserCapabilityApi,
    browserDocumentApi,
    browserPlaywrightApi,
    browserDataApi,
    browserListApi,
    browserScrollersApi,
    browserEventsApi,
    browserRecordingApi,
    browserDemonstrationApi,
    browserControlsApi,
    browserMediaChallengesApi,
  ].join("\n"),
);

window.addEventListener("unhandledrejection", (event) => {
  asynchronousError = event.reason instanceof Error ? event.reason.message : String(event.reason);
  event.preventDefault();
});

window.addEventListener("message", (event) => {
  if (event.source !== parent) return;
  const message = event.data as Record<string, unknown>;
  if (message.kind === "reply") {
    const waiter = pending.get(String(message.callId));
    pending.delete(String(message.callId));
    if (typeof message.error === "string") waiter?.reject(new Error(message.error));
    else waiter?.resolve(message.value);
  } else if (message.kind === "cell") void run(message);
});

async function run(message: Record<string, unknown>): Promise<void> {
  cellId = String(message.cellId);
  parent.postMessage({ kind: "started", cellId }, "*");
  output = "";
  asynchronousError = undefined;
  let value: unknown;
  let error: string | undefined;
  try {
    evaluate("__beginCell()");
    if (message.attached) scope.__attachedTarget = message.attached;
    if (message.attached && !evaluate("__lastTarget"))
      (scope.bu as { use(target: unknown): unknown }).use(message.attached);
    value = await evaluate(toReplScript(String(message.code)));
    const delivered = evaluate("__hasDelivered ? {value: __deliveryValue} : null") as {
      value: unknown;
    } | null;
    // finish_from_js: the value is the run's answer, handed to the user as it is.
    if (delivered) value = { delivered: true, answer: delivered.value };
  } catch (caught) {
    error = withHint(
      nameModelCodeError(caught),
      caught instanceof Error ? caught.message : String(caught),
      String(message.code),
    );
  }
  // Calls the cell started but did not await still finish before the final observation.
  for (let waited = 0; pending.size && waited < 10_000; waited += 5)
    await new Promise((resolve) => setTimeout(resolve, 5));
  try {
    await evaluate("__finishCell()");
  } catch (caught) {
    print("Final observation unavailable:", String(caught));
  }
  error ??= asynchronousError;
  if (!error) tip(String(message.code));
  parent.postMessage(
    { kind: "done", cellId, value: portable(value), output, ...(error ? { error } : {}) },
    "*",
  );
}

/** Adds a one-line "Tip:" to the output when the cell took the long way to something. */
function tip(code: string): void {
  try {
    const text = String((scope.__tip as (code: string) => string)(code) || "");
    if (text) print("Tip: " + text);
  } catch {
    // No tip.
  }
}

/** The error with a "did you mean" from the realm's real API, when one applies. */
/** `raw` is the error as thrown, which the API's own "did you mean" reads; `message` is named. */
function withHint(message: string, raw: string, code: string): string {
  let hint = "";
  try {
    hint = String((scope.__hint as (text: string, code: string) => string)(raw, code) || "");
  } catch {
    // No hint: the error stands as it is.
  }
  // Without a hint of its own, the error's shared code still says how to recover.
  hint ||= message.includes("\nHint: ") ? "" : errorHint(leadingCode(message) ?? "");
  return hint ? `${message}\nHint: ${hint}` : message;
}

function portable(value: unknown): unknown {
  if (value === undefined) return undefined;
  try {
    return JSON.parse(JSON.stringify(value)) as unknown;
  } catch {
    return String(value);
  }
}
