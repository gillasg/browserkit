import { z } from "zod";
import { BrowserTargetKeySchema } from "./browser-inventory.js";
import { SiteScriptDefinitionSchema } from "./site-scripts.js";
import { SemanticTargetSchema } from "./browser-elements.js";
const target = BrowserTargetKeySchema;
export const browserExtraSteps = [
  z
    .object({ op: z.literal("evaluate"), target, expression: z.string().min(1).max(20000) })
    .strict(),
  z
    .object({
      op: z.literal("cdp"),
      target,
      method: z
        .string()
        .regex(/^[A-Za-z]+\.[A-Za-z]+$/)
        .max(120),
      params: z.record(z.string(), z.unknown()).default({}),
    })
    .strict(),
  z
    .object({
      op: z.literal("waitFor"),
      target,
      expression: z.string().min(1).max(20000),
      timeoutMs: z.number().int().min(100).max(8000).default(5000),
    })
    .strict(),
  z
    .object({
      op: z.literal("press"),
      target,
      element: SemanticTargetSchema,
      focus: z.boolean().optional(),
      key: z.enum([
        "Enter",
        "Tab",
        "Escape",
        "Backspace",
        "Delete",
        "ArrowUp",
        "ArrowDown",
        "ArrowLeft",
        "ArrowRight",
        "Home",
        "End",
        "Space",
      ]),
    })
    .strict(),
  z
    .object({
      op: z.literal("read"),
      target,
      selector: z.string().min(1).max(512),
      limit: z.number().int().min(1).max(100).default(30),
      textLimit: z.number().int().min(1).max(4000).default(1000),
      attributes: z
        .array(z.string().regex(/^[\w-]{1,80}$/))
        .max(10)
        .default([]),
    })
    .strict(),
  z
    .object({
      op: z.literal("wait"),
      target,
      selector: z.string().min(1).max(512),
      state: z.enum(["attached", "visible", "hidden", "editable"]).default("visible"),
      timeoutMs: z.number().int().min(100).max(8000).default(5000),
    })
    .strict(),
  z
    .object({
      op: z.literal("navigate"),
      target,
      url: z
        .string()
        .url()
        .max(8192)
        .refine((value) => ["http:", "https:"].includes(new URL(value).protocol)),
      /** false for parallel reads: navigate without changing the Split View pair. */
      present: z.boolean().optional(),
      /** The Referer this navigation sends (some players gate on it). */
      referer: z.string().url().max(8192).optional(),
      /** How long to wait for the page to load; a slow page is reported, not waited on forever. */
      timeoutMs: z.number().int().min(500).max(120000).optional(),
    })
    .strict(),
  z.object({ op: z.literal("diagnostics"), target, clear: z.boolean().default(false) }).strict(),
  z
    .object({
      op: z.literal("console"),
      target,
      action: z.enum(["start", "stop", "status"]),
    })
    .strict(),
  z
    .object({
      op: z.literal("session"),
      target,
      action: z.enum(["list", "finish", "claim", "resolve"]),
      keep: z.array(z.string().max(40)).max(20).default([]),
      label: z.string().max(40).optional(),
      /** Claim the tab for reading only: ordinary write steps are refused. */
      readOnly: z.boolean().default(false),
    })
    .strict(),
  z
    .object({
      op: z.literal("control"),
      target,
      action: z.enum(["status", "wait", "giveback"]),
      timeoutMs: z.number().int().min(100).max(120_000).default(30_000),
    })
    .strict(),
  z
    .object({
      op: z.literal("stealth"),
      target,
      probe: z.record(z.string(), z.unknown()).optional(),
    })
    .strict(),
  z.object({ op: z.literal("popups"), target }).strict(),
  z.object({ op: z.literal("readiness"), target }).strict(),
  z
    .object({
      op: z.literal("settle"),
      target,
      quietMs: z.number().int().min(50).max(10000).default(500),
      timeoutMs: z.number().int().min(100).max(60000).default(10000),
    })
    .strict(),
  z.object({ op: z.literal("scheduler"), target }).strict(),
  z
    .object({
      op: z.literal("cookies"),
      target,
      action: z.enum(["list", "get", "set", "remove", "clear"]),
      url: z.string().url().max(8192).optional(),
      domain: z.string().min(1).max(253).optional(),
      name: z.string().min(1).max(512).optional(),
      value: z.string().max(8192).optional(),
      path: z.string().max(2048).optional(),
      secure: z.boolean().optional(),
      httpOnly: z.boolean().optional(),
      sameSite: z.enum(["no_restriction", "lax", "strict", "unspecified"]).optional(),
      expirationDate: z.number().optional(),
      values: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      op: z.literal("networkStore"),
      target,
      action: z.enum(["list", "get", "body", "curl", "origins", "stats", "clear", "har"]),
      id: z.string().max(160).optional(),
      match: z.string().max(2048).optional(),
      origin: z.string().max(2048).optional(),
      method: z.string().max(16).optional(),
      type: z.string().max(40).optional(),
      status: z.number().int().min(0).max(999).optional(),
      static: z.enum(["static", "dynamic"]).optional(),
      since: z.number().optional(),
      until: z.number().optional(),
      limit: z.number().int().min(1).max(1000).optional(),
      secrets: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      op: z.literal("siteScript"),
      target,
      action: z.enum(["preview", "install", "remove", "status"]),
      definition: SiteScriptDefinitionSchema.optional(),
      scriptId: z.string().uuid().optional(),
    })
    .strict(),
] as const;
