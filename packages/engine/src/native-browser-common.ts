import type { BrowserTargetKey } from "@browserkit/protocol";
import type { BrowserIdentity } from "./native-worker-identity.js";

export interface AxNode {
  nodeId?: string;
  parentId?: string;
  backendDOMNodeId?: number;
  ignored?: boolean;
  role?: { value?: unknown };
  name?: { value?: unknown };
  value?: { value?: unknown };
  properties?: { name?: string; value?: { value?: unknown } }[];
  /** The frame document this node belongs to (already set for same-process frames). */
  frameId?: string;
  /** The OOPIF debugger session this node was read through. */
  sessionId?: string;
  /** This node is the iframe element that owns the frame with this id. */
  frameOwner?: string;
}

export interface AxRef {
  backendNodeId: number;
  documentEpoch?: number;
  role: string;
  name: string;
  /** The iframe session a frame-scoped ref acts through (Input and DOM are local to it). */
  sessionId?: string;
  frameId?: string;
}

export interface ScreenshotRef {
  target: BrowserTargetKey;
  epoch: number;
  viewport: { width: number; height: number };
  capturedAt: number;
  fingerprint: string;
  scrollX: number;
  scrollY: number;
}

export function safePage(value: string): boolean {
  try {
    return ["http:", "https:"].includes(new URL(value).protocol);
  } catch {
    return false;
  }
}

export function textValue(value: unknown): string {
  return typeof value === "string" || typeof value === "number" ? String(value) : "";
}

export function booleanProperty(
  node: AxNode,
  name: "disabled" | "checked" | "focused" | "expanded" | "selected" | "pressed",
): {
  disabled?: boolean;
  checked?: boolean;
  focused?: boolean;
  expanded?: boolean;
  selected?: boolean;
  pressed?: boolean;
} {
  const value = node.properties?.find((item) => item.name === name)?.value?.value;
  return typeof value === "boolean"
    ? { [name]: value }
    : value === "true" || value === "false"
      ? { [name]: value === "true" }
      : {};
}

export function targetIdentity(target: BrowserTargetKey): string {
  return `${target.clientInstanceId}/${target.browserRunId}/${target.tabId}/${target.tabIncarnation}`;
}

export function sameTarget(left: BrowserTargetKey, right: BrowserTargetKey): boolean {
  return targetIdentity(left) === targetIdentity(right);
}

export function sameIdentity(target: BrowserTargetKey, identity: BrowserIdentity): boolean {
  return (
    target.clientInstanceId === identity.clientInstanceId &&
    target.browserRunId === identity.browserRunId
  );
}

export function errorCode(error: unknown): string {
  const value = error instanceof Error ? error.message : "";
  if (
    [
      "TARGET_LOST",
      "EXTENSION_BLOCKED",
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
    ].includes(value)
  )
    return value;
  return value.toLowerCase().includes("debugger") || value.toLowerCase().includes("not permitted")
    ? "UNSUPPORTED"
    : "OPERATION_FAILED";
}

export class BrowserActionError extends Error {
  constructor(
    code: string,
    readonly detail: string,
  ) {
    super(code);
  }
}
export function browserErrorDetail(error: unknown): string | undefined {
  return error instanceof BrowserActionError ? error.detail.slice(0, 2000) : undefined;
}
