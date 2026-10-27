import { z } from "zod";
import { browserExtraSteps } from "./browser-extra-steps.js";
import { browserCapabilitySteps } from "./browser-capability-steps.js";
import { BrowserTabSchema, BrowserTargetKeySchema } from "./browser-inventory.js";

const HttpUrlSchema = z
  .string()
  .url()
  .max(8192)
  .refine((value) => ["http:", "https:"].includes(new URL(value).protocol));

export { BrowserElementTargetSchema, type BrowserElementTarget } from "./browser-elements.js";
import { BrowserElementTargetSchema, SemanticTargetSchema } from "./browser-elements.js";

export const BrowserStepSchema = z.discriminatedUnion("op", [
  ...browserExtraSteps,
  ...browserCapabilitySteps,
  z
    .object({
      op: z.literal("listTabs"),
      query: z.string().max(160).optional(),
      mine: z.boolean().optional(),
      all: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      op: z.literal("openTab"),
      clientInstanceId: z.string().uuid(),
      url: HttpUrlSchema,
      foreground: z.boolean().default(false),
      /** Park popups, mute media and block ad hosts while the agent uses this tab. */
      quiet: z.boolean().optional(),
      /** Its own background window (bulk work) or a tab in the user's window (a chat). */
      space: z.enum(["window", "tabs"]).optional(),
      /** The Referer this page load sends (some providers allowlist it). */
      referer: z.string().url().max(8192).optional(),
      /** false for a background read pool: open without changing the Split View pair. */
      present: z.boolean().optional(),
      /** What the host calls the owner's tab group (a chat title, "Routine · …", "Mapping"). */
      ownerTitle: z.string().min(1).max(120).optional(),
      /** How long to wait for the page to load; a slow page is reported, not waited on forever. */
      timeoutMs: z.number().int().min(500).max(120000).optional(),
      // A separate, visible window of this size (e.g. for recording); otherwise a tab in the current window.
      window: z
        .object({
          width: z.number().int().min(200).max(7680),
          height: z.number().int().min(200).max(4320),
        })
        .strict()
        .optional(),
    })
    .strict(),
  z.object({ op: z.literal("attachTab"), target: BrowserTargetKeySchema }).strict(),
  z
    .object({
      op: z.literal("observe"),
      target: BrowserTargetKeySchema,
      kind: z.enum(["semantic", "screenshot"]),
      query: z.string().max(256).optional(),
      interactive: z.boolean().optional(),
      selector: z.string().min(1).max(512).optional(),
      /** A ref from the last observation: snapshot only that element's subtree (or that frame). */
      root: z
        .string()
        .regex(/^(?:f[0-9]{1,2}:)?e[0-9]{1,4}$/)
        .optional(),
      all: z.boolean().optional(),
      summary: z.boolean().optional(),
      includeHidden: z.boolean().optional(),
      noText: z.boolean().optional(),
      diff: z.boolean().optional(),
      depth: z.number().int().min(0).max(80).optional(),
      compact: z.boolean().optional(),
      maxBytes: z.number().int().min(500).max(400_000).optional(),
    })
    .strict(),
  z
    .object({
      op: z.literal("click"),
      target: BrowserTargetKeySchema,
      element: BrowserElementTargetSchema,
      observe: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      op: z.literal("fill"),
      target: BrowserTargetKeySchema,
      element: SemanticTargetSchema,
      value: z.string().max(20000),
      observe: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      op: z.literal("paste"),
      target: BrowserTargetKeySchema,
      element: SemanticTargetSchema,
      text: z.string().max(100000),
      html: z.string().max(200000),
      observe: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      op: z.literal("scroll"),
      target: BrowserTargetKeySchema,
      element: SemanticTargetSchema.optional(),
      direction: z.enum(["up", "down", "left", "right"]),
      amount: z.number().int().min(40).max(1200),
    })
    .strict(),
]);
export type BrowserStep = z.infer<typeof BrowserStepSchema>;

export const BrowserOperationCallSchema = z
  .object({ steps: z.array(BrowserStepSchema).min(1).max(8) })
  .strict();
export type BrowserOperationCall = z.infer<typeof BrowserOperationCallSchema>;

const WRITE_STEPS = new Set([
  "click",
  "fill",
  "press",
  "pointer",
  "keys",
  "upload",
  "navigate",
  "scroll",
  "downloads",
  "cdp",
]);

/** Whether a step changes the page: those queue and take the one-use claim; reads stay parallel. */
export function browserStepWrites(step: BrowserStep): boolean {
  if (step.op === "frames") return ["click", "fill", "cdp"].includes(step.action);
  if (step.op === "downloads") return step.action === "start" || step.action === "cancel";
  return WRITE_STEPS.has(step.op);
}

export const BrowserExecutorRequestSchema = z
  .object({
    kind: z.literal("browser.operation"),
    requestId: z.string().uuid(),
    operationId: z.string().uuid(),
    toolCallId: z.string().min(1).max(256),
    chatId: z.string().uuid(),
    claimId: z.string().uuid().optional(),
    claimGeneration: z.number().int().positive().optional(),
    expectedDocumentEpoch: z.number().int().nonnegative().optional(),
    step: BrowserStepSchema,
  })
  .strict()
  .superRefine((request, context) => {
    const targetAction = browserStepWrites(request.step);
    const hasClaim =
      request.claimId !== undefined &&
      request.claimGeneration !== undefined &&
      request.expectedDocumentEpoch !== undefined;
    const hasAnyClaim = request.claimId !== undefined || request.claimGeneration !== undefined;
    if ((targetAction && !hasClaim) || (!targetAction && hasAnyClaim && !hasClaim))
      context.addIssue({
        code: "custom",
        message: "Target actions require a complete one-use claim.",
      });
  });
export type BrowserExecutorRequest = z.infer<typeof BrowserExecutorRequestSchema>;

export const BrowserSemanticNodeSchema = z
  .object({
    ref: z.string().regex(/^(?:f[0-9]{1,2}:)?e[0-9]{1,4}$/),
    role: z.string().max(80),
    name: z.string().max(512),
    value: z.string().max(512).optional(),
    disabled: z.boolean().optional(),
    checked: z.boolean().optional(),
    focused: z.boolean().optional(),
    backendNodeId: z.number().int().positive().optional(),
    /** The frame label (f2) when the node lives inside an iframe's document. */
    frame: z.string().max(8).optional(),
    expanded: z.boolean().optional(),
    selected: z.boolean().optional(),
    pressed: z.union([z.boolean(), z.literal("mixed")]).optional(),
    mixed: z.boolean().optional(),
    hidden: z.boolean().optional(),
  })
  .strict();
export type BrowserSemanticNode = z.infer<typeof BrowserSemanticNodeSchema>;

const SemanticObservationSchema = z
  .object({
    kind: z.literal("semantic"),
    source: z.literal("website"),
    trust: z.literal("untrusted"),
    target: BrowserTargetKeySchema,
    documentEpoch: z.number().int().nonnegative(),
    snapshotId: z.string().uuid(),
    url: z.string().max(8192),
    nodes: z.array(BrowserSemanticNodeSchema).max(180),
    truncated: z.boolean(),
    text: z.string().max(20000).optional(),
    diff: z
      .object({
        added: z.array(z.number().int()),
        removed: z.array(z.number().int()),
        changed: z.array(z.number().int()),
        unchanged: z.number().int(),
        reset: z.boolean().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

const ScreenshotObservationSchema = z
  .object({
    kind: z.literal("screenshot"),
    source: z.literal("website"),
    trust: z.literal("untrusted"),
    target: BrowserTargetKeySchema,
    documentEpoch: z.number().int().nonnegative(),
    screenshotId: z.string().uuid(),
    url: z.string().max(8192),
    viewport: z
      .object({
        width: z.number().int().positive().max(8192),
        height: z.number().int().positive().max(8192),
      })
      .strict(),
    capturedAt: z.number().int().nonnegative(),
    mimeType: z.literal("image/jpeg"),
    dataBase64: z.string().max(1_500_000),
  })
  .strict();

export const BrowserScrollStateSchema = z
  .object({
    direction: z.enum(["up", "down", "left", "right"]),
    position: z.number().finite(),
    extent: z.number().finite(),
    viewport: z.number().finite(),
    moved: z.boolean(),
    atBoundary: z.boolean(),
  })
  .strict();
export type BrowserScrollState = z.infer<typeof BrowserScrollStateSchema>;

export const BrowserExecutorResultSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("page"),
      target: BrowserTargetKeySchema,
      url: z.string().max(8192),
      documentEpoch: z.number().int().nonnegative(),
      data: z.unknown(),
      source: z.literal("website"),
      trust: z.literal("untrusted"),
    })
    .strict(),
  z
    .object({
      kind: z.literal("tabs"),
      tabs: z.array(BrowserTabSchema).max(256),
      /** The window the user last focused; its active tab is the one activeTab() returns. */
      focusedWindowId: z.number().int().nonnegative().optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("tab"),
      tab: BrowserTabSchema,
      /** "failed" when the tab exists but its page did not load: the tab still belongs to the run. */
      navigation: z.enum(["ok", "failed"]).optional(),
      reason: z.string().max(500).optional(),
    })
    .strict(),
  SemanticObservationSchema,
  ScreenshotObservationSchema,
  z
    .object({
      kind: z.literal("action"),
      target: BrowserTargetKeySchema,
      documentEpoch: z.number().int().nonnegative(),
      url: z.string().max(8192),
      observation: SemanticObservationSchema.optional(),
      scroll: BrowserScrollStateSchema.optional(),
      outcome: z.enum(["navigated", "changed", "unchanged", "unknown"]).optional(),
      receipt: z
        .object({
          popups: z
            .array(z.object({ tabId: z.number().int(), url: z.string().max(8192) }).strict())
            .max(20),
          dialog: z
            .object({
              type: z.string().max(40),
              message: z.string().max(300),
              accepted: z.boolean(),
            })
            .strict()
            .optional(),
          navigated: z.boolean(),
          download: z
            .object({
              url: z.string().max(2000),
              filename: z.string().max(300),
              token: z.string().max(200).optional(),
            })
            .strict()
            .optional(),
        })
        .strict()
        .optional(),
      /** A click that visibly did nothing: what was clicked and what to try instead. */
      note: z.string().max(1000).optional(),
    })
    .strict(),
]);
export type BrowserExecutorResult = z.infer<typeof BrowserExecutorResultSchema>;

export const BrowserOperationResultSchema = z.discriminatedUnion("ok", [
  z
    .object({
      kind: z.literal("browser.operation.result"),
      requestId: z.string().uuid(),
      operationId: z.string().uuid(),
      ok: z.literal(true),
      result: BrowserExecutorResultSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("browser.operation.result"),
      requestId: z.string().uuid(),
      operationId: z.string().uuid(),
      ok: z.literal(false),
      detail: z.string().max(2000).optional(),
      code: z.enum([
        "TARGET_LOST",
        "AMBIGUOUS_TARGET",
        "TARGET_NOT_FOUND",
        "TARGET_HIDDEN",
        "TARGET_DISABLED",
        "TARGET_BLOCKED",
        "NOT_EDITABLE",
        "INPUT_FAILED",
        "STALE_REF",
        "CLAIM_CONFLICT",
        "UNSUPPORTED",
        "INVALID_TARGET",
        "TIMEOUT",
        "BROWSER_OFFLINE",
        "DAEMON_OFFLINE",
        "OPERATION_FAILED",
      ]),
    })
    .strict(),
]);
export type BrowserOperationResult = z.infer<typeof BrowserOperationResultSchema>;
