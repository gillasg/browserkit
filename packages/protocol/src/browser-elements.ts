import { z } from "zod";

const ref = z
  .object({
    kind: z.literal("ref"),
    snapshotId: z.string().uuid(),
    ref: z.string().regex(/^(?:f[0-9]{1,2}:)?e[0-9]{1,4}$/),
  })
  .strict();
const locator = z
  .object({
    kind: z.literal("locator"),
    role: z.string().min(1).max(80),
    name: z.string().max(256),
    exact: z.boolean().optional(),
    scope: z.string().min(1).max(512).optional(),
  })
  .strict();
const query = z
  .object({
    kind: z.literal("query"),
    by: z.enum(["css", "text", "label", "placeholder"]),
    value: z.string().min(1).max(512),
    exact: z.boolean().optional(),
    scope: z.string().min(1).max(512).optional(),
  })
  .strict();
const backend = z
  .object({
    kind: z.literal("backend"),
    backendNodeId: z.number().int().positive(),
    documentEpoch: z.number().int().nonnegative(),
  })
  .strict();
export const SemanticTargetSchema = z.discriminatedUnion("kind", [ref, locator, query, backend]);
export const BrowserElementTargetSchema = z.discriminatedUnion("kind", [
  ref,
  locator,
  query,
  backend,
  z
    .object({
      kind: z.literal("point"),
      screenshotId: z.string().uuid(),
      x: z.number().min(0).max(1),
      y: z.number().min(0).max(1),
    })
    .strict(),
]);
export type BrowserElementTarget = z.infer<typeof BrowserElementTargetSchema>;
