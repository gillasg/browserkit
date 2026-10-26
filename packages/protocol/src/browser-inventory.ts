import { z } from "zod";

export const BrowserTargetKeySchema = z
  .object({
    clientInstanceId: z.string().uuid(),
    browserRunId: z.string().uuid(),
    tabId: z.number().int().nonnegative(),
    tabIncarnation: z.string().uuid(),
  })
  .strict();
export type BrowserTargetKey = z.infer<typeof BrowserTargetKeySchema>;

export const BrowserWindowSchema = z
  .object({
    windowId: z.number().int().nonnegative(),
    focused: z.boolean(),
    state: z.enum(["normal", "minimized", "maximized", "fullscreen"]),
    type: z.enum(["normal", "popup"]),
  })
  .strict();
export type BrowserWindow = z.infer<typeof BrowserWindowSchema>;

export const BrowserTabSchema = z
  .object({
    target: BrowserTargetKeySchema,
    windowId: z.number().int().nonnegative(),
    index: z.number().int().nonnegative(),
    url: z.string().max(8192),
    title: z.string().max(1024),
    status: z.enum(["loading", "complete", "discarded"]),
    active: z.boolean(),
    pinned: z.boolean(),
    groupId: z.number().int().min(-1),
    documentEpoch: z.number().int().nonnegative(),
    /** Set by browser.tabs(): true only for tabs this chat or session opened. */
    mine: z.boolean().optional(),
    /** Who is driving: the agent (default) or the user, after taking the tab over. */
    control: z.enum(["agent", "user"]).optional(),
    /** Stable session label (p1, p2…), accepted anywhere a tab id is. */
    label: z
      .string()
      .regex(/^p[0-9]{1,3}$/)
      .optional(),
  })
  .strict();
export type BrowserTab = z.infer<typeof BrowserTabSchema>;

export const BrowserInventoryFullSchema = z
  .object({
    kind: z.literal("browser.inventory.full"),
    clientInstanceId: z.string().uuid(),
    browserRunId: z.string().uuid(),
    generation: z.number().int().positive(),
    capabilities: z
      .array(
        z.enum([
          "site-scripts",
          "browser-actions-v2",
          "browser-runtime-v3",
          "browser-runtime-v4",
          "browser-code-v1",
        ]),
      )
      .max(8)
      .optional(),
    windows: z.array(BrowserWindowSchema).max(256),
    tabs: z.array(BrowserTabSchema).max(2048),
  })
  .strict();
export type BrowserInventoryFull = z.infer<typeof BrowserInventoryFullSchema>;

const BrowserInventoryDeltaSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("tab.upsert"), tab: BrowserTabSchema }).strict(),
  z.object({ kind: z.literal("tab.remove"), target: BrowserTargetKeySchema }).strict(),
  z.object({ kind: z.literal("window.upsert"), window: BrowserWindowSchema }).strict(),
  z.object({ kind: z.literal("window.remove"), windowId: z.number().int().nonnegative() }).strict(),
]);

export const BrowserInventoryDeltaMessageSchema = z
  .object({
    kind: z.literal("browser.inventory.delta"),
    clientInstanceId: z.string().uuid(),
    browserRunId: z.string().uuid(),
    generation: z.number().int().positive(),
    sequence: z.number().int().positive(),
    delta: BrowserInventoryDeltaSchema,
  })
  .strict();
export type BrowserInventoryDeltaMessage = z.infer<typeof BrowserInventoryDeltaMessageSchema>;

export const BrowserInventoryReplySchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("browser.inventory.applied"),
      generation: z.number().int().positive(),
      lastSequence: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("browser.inventory.resync"),
      generation: z.number().int().positive(),
      expectedSequence: z.number().int().positive(),
    })
    .strict(),
]);
export type BrowserInventoryReply = z.infer<typeof BrowserInventoryReplySchema>;

export const BrowserExecutorHeartbeatSchema = z
  .object({
    kind: z.literal("browser.executor.heartbeat"),
    clientInstanceId: z.string().uuid(),
    browserRunId: z.string().uuid(),
  })
  .strict();
export type BrowserExecutorHeartbeat = z.infer<typeof BrowserExecutorHeartbeatSchema>;

export const BrowserExecutorHeartbeatReplySchema = z
  .object({
    kind: z.literal("browser.executor.heartbeat.ack"),
    clientInstanceId: z.string().uuid(),
    browserRunId: z.string().uuid(),
  })
  .strict();
export type BrowserExecutorHeartbeatReply = z.infer<typeof BrowserExecutorHeartbeatReplySchema>;
