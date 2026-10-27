import { z } from "zod";
import { BrowserTargetKeySchema as target } from "./browser-inventory.js";
const frame = { frameId: z.string().max(256).optional(), frameKey: z.string().max(256).optional() };
const method = z
  .string()
  .regex(/^[A-Za-z]+\.[A-Za-z]+$/)
  .max(120);
export const browserCapabilitySteps = [
  z
    .object({
      op: z.literal("event"),
      target,
      action: z.enum(["subscribe", "poll", "dispose"]),
      event: z.string().max(120).optional(),
      subscriptionId: z.string().uuid().optional(),
      timeoutMs: z.number().int().min(0).max(8000).default(0),
      ...frame,
    })
    .strict(),
  z
    .object({
      op: z.literal("frames"),
      target,
      action: z.enum(["list", "evaluate", "cdp", "snapshot", "click", "fill"]),
      selector: z.string().max(512).optional(),
      backendNodeId: z.number().int().positive().optional(),
      value: z.string().max(20000).optional(),
      expression: z.string().max(20000).optional(),
      method: method.optional(),
      params: z.record(z.string(), z.unknown()).default({}),
      ...frame,
    })
    .strict(),
  z
    .object({
      op: z.literal("upload"),
      target,
      files: z.array(z.string().min(1).max(4096)).max(20),
      selector: z.string().max(512).optional(),
      backendNodeId: z.number().int().positive().optional(),
      ...frame,
    })
    .strict(),
  z
    .object({
      op: z.literal("downloads"),
      target,
      action: z.enum(["start", "wait", "cancel", "resolve"]),
      url: z.string().url().max(8192).optional(),
      downloadId: z.number().int().nonnegative().optional(),
      filename: z.string().max(512).optional(),
      token: z.string().uuid().optional(),
      timeoutMs: z.number().int().min(0).max(8000).default(0),
    })
    .strict(),
  z
    .object({
      op: z.literal("pointer"),
      target,
      action: z.enum(["click", "doubleClick", "hover", "drag"]),
      x: z.number().finite().min(0).max(50000),
      y: z.number().finite().min(0).max(50000),
      toX: z.number().finite().min(0).max(50000).optional(),
      toY: z.number().finite().min(0).max(50000).optional(),
    })
    .strict(),
  z
    .object({ op: z.literal("keys"), target, keys: z.string().min(1).max(20000), ...frame })
    .strict(),
  z.object({ op: z.literal("reconnect"), target }).strict(),
] as const;
