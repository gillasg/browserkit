import { z } from "zod";
import { BrowserTargetKeySchema } from "./browser-inventory.js";

// A browser_code cell runs inside the browser executor. Core sends the source once; the
// executor performs browser steps locally and calls back only for workspace and Core services.
export const BrowserCodeRunSchema = z
  .object({
    kind: z.literal("browser.code.run"),
    cellId: z.string().uuid(),
    chatId: z.string().uuid(),
    toolCallId: z.string().min(1).max(256),
    code: z.string().min(1).max(16000),
    targets: z.array(BrowserTargetKeySchema).max(64),
    timeoutMs: z.number().int().min(1000).max(600000),
    /** The chat, routine or session name for its tab group. */
    ownerTitle: z.string().min(1).max(120).optional(),
    /** Where this run's tabs go unless a step chooses: a background window or the user's window. */
    space: z.enum(["window", "tabs"]).optional(),
    /** Record a short screencast of agent tabs (default true); false turns it off for this run. */
    flight: z.boolean().optional(),
    /** Human-verification assistance is allowed only for chat-sourced cells. */
    challengeAssist: z.boolean().optional(),
  })
  .strict();
export type BrowserCodeRun = z.infer<typeof BrowserCodeRunSchema>;

export const BrowserCodeCancelSchema = z
  .object({ kind: z.literal("browser.code.cancel"), cellId: z.string().uuid(), reset: z.boolean() })
  .strict();

/** Executor → Core: a request the browser cannot serve itself (workspace files, upload paths, site scripts). */
export const BrowserCodeCallSchema = z
  .object({
    kind: z.literal("browser.code.call"),
    cellId: z.string().uuid(),
    callId: z.string().min(1).max(64),
    request: z.unknown(),
  })
  .strict();

export const BrowserCodeReplySchema = z
  .object({
    kind: z.literal("browser.code.reply"),
    cellId: z.string().uuid(),
    callId: z.string().min(1).max(64),
    value: z.unknown().optional(),
    error: z.string().max(20000).optional(),
  })
  .strict();

export const BrowserCodeProgressSchema = z
  .object({
    kind: z.literal("browser.code.progress"),
    cellId: z.string().uuid(),
    steps: z.array(z.record(z.string(), z.unknown())).max(256),
    // True while the cell is handed off to the user; the cell deadline is paused meanwhile.
    waitingForUser: z.boolean().optional(),
  })
  .strict();

export const BrowserCodeResultSchema = z
  .object({
    kind: z.literal("browser.code.result"),
    cellId: z.string().uuid(),
    output: z.string().max(1_100_000),
    value: z.unknown().optional(),
    error: z.string().max(20000).optional(),
    reset: z.boolean().optional(),
    /** Saved recordings from a failed run: {path, frames, durationMs, startedAt}. */
    flight: z.array(z.record(z.string(), z.unknown())).max(4).optional(),
    steps: z.array(z.record(z.string(), z.unknown())).max(256),
    opened: z.array(BrowserTargetKeySchema).max(64),
    openedUnused: z.array(BrowserTargetKeySchema).max(64).optional(),
    /** Tabs this run opened/closed, the ones still open, all tabs, and parked popups. */
    tabStats: z
      .object({
        opened: z.number().int().nonnegative(),
        closed: z.number().int().nonnegative(),
        mine: z.array(z.number().int().nonnegative()).max(64),
        total: z.number().int().nonnegative(),
        popups: z.number().int().nonnegative().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type BrowserCodeResult = z.infer<typeof BrowserCodeResultSchema>;
