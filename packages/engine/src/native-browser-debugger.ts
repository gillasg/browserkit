import { noteActionTiming } from "./native-browser-action-timing.js";
import { hiddenTargetError } from "./native-browser-reveal.js";
import { showAgentCursor } from "./native-browser-cursor.js";
import {
  BrowserActionError,
  targetIdentity,
  textValue,
  type AxNode,
  type AxRef,
} from "./native-browser-common.js";
import type { BrowserElementTarget, BrowserTargetKey } from "@browserkit/protocol";
import { queryNodes, visibleNodes, scopedBackendIds } from "./native-browser-dom.js";
import { collectFrameAx } from "./native-browser-frames.js";
export { withBrowserDebugger as withDebugger } from "./native-browser-session.js";

export async function resolveElement(
  debuggee: chrome.debugger.Debuggee,
  element: BrowserElementTarget | undefined,
  target: BrowserTargetKey,
  refs: Map<string, Map<string, AxRef>>,
  latestSnapshots: Map<string, string>,
  documentEpoch?: number,
): Promise<AxRef> {
  const nodes = await getAxTree(debuggee);
  if (!element) throw new Error("INVALID_TARGET");
  if (element.kind === "backend") return resolveBackend(nodes, element, documentEpoch);
  if (element.kind === "ref") {
    const key = targetIdentity(target);
    if (latestSnapshots.get(key) !== element.snapshotId) throw new Error("STALE_REF");
    const prior = refs.get(element.snapshotId)?.get(element.ref);
    if (!prior) throw new Error("STALE_REF");
    if (documentEpoch !== undefined && prior.documentEpoch !== documentEpoch)
      throw new Error("STALE_REF");
    // A frame's node lives in that frame's session; its backend id means nothing on the tab's
    // own target, so revalidate it where it was read.
    if (prior.sessionId) {
      const tree = (await chrome.debugger
        .sendCommand({ ...debuggee, sessionId: prior.sessionId }, "Accessibility.getFullAXTree")
        .catch(() => {
          throw new Error("STALE_REF");
        })) as { nodes?: AxNode[] };
      const live = tree.nodes?.find((node) => node.backendDOMNodeId === prior.backendNodeId);
      if (!sameSemanticNode(live, prior)) throw new Error("STALE_REF");
      return prior;
    }
    const live = nodes.find((node) => node.backendDOMNodeId === prior.backendNodeId);
    if (!sameSemanticNode(live, prior)) throw new Error("STALE_REF");
    return prior;
  }
  if (element.kind === "point") throw new Error("STALE_REF");
  if (element.kind === "query") return resolveQuery(debuggee, nodes, element);
  return resolveRole(debuggee, nodes, element);
}
function resolveBackend(
  nodes: AxNode[],
  element: Extract<BrowserElementTarget, { kind: "backend" }>,
  documentEpoch?: number,
): AxRef {
  if (documentEpoch !== element.documentEpoch) throw new Error("STALE_REF");
  const live = nodes.find(
    (node) => node.backendDOMNodeId === element.backendNodeId && !node.ignored,
  );
  if (!live) throw new Error("STALE_REF");
  return {
    backendNodeId: element.backendNodeId,
    documentEpoch: element.documentEpoch,
    role: textValue(live.role?.value),
    name: textValue(live.name?.value),
  };
}

async function resolveRole(
  debuggee: chrome.debugger.Debuggee,
  nodes: AxNode[],
  element: Extract<BrowserElementTarget, { kind: "locator" }>,
): Promise<AxRef> {
  const scoped = element.scope ? await scopedBackendIds(debuggee, element.scope) : undefined;
  const eligible = scoped ? nodes.filter((node) => scoped.has(node.backendDOMNodeId ?? -1)) : nodes;
  const matches = locatorMatches(eligible, element.role, element.name, element.exact);
  if (!matches.length)
    throw new BrowserActionError(
      "TARGET_NOT_FOUND",
      `No ${element.role} named ${JSON.stringify(element.name)}. Nearby named controls: ${eligible
        .filter((node) => !node.ignored && textValue(node.name?.value))
        .slice(0, 12)
        .map(
          (node) => `${textValue(node.role?.value)}: ${textValue(node.name?.value).slice(0, 100)}`,
        )
        .join("; ")}. Use snapshot({query}) or a CSS/label locator.`,
    );
  const visible = await visibleNodes(
    debuggee,
    matches.map((node) => node.backendDOMNodeId ?? -1),
  );
  return uniqueNode(
    matches.filter((node) => visible.includes(node.backendDOMNodeId ?? -1)),
    "TARGET_HIDDEN",
  );
}

function sameSemanticNode(live: AxNode | undefined, prior: AxRef | undefined): boolean {
  return Boolean(
    prior &&
    live &&
    textValue(live.role?.value) === prior.role &&
    textValue(live.name?.value).slice(0, 512) === prior.name,
  );
}

function locatorMatches(nodes: AxNode[], role: string, name: string, exact = true): AxNode[] {
  const normalize = (value: string) => value.replace(/\s+/g, " ").trim();
  return nodes.filter(
    (node) =>
      !node.ignored &&
      node.backendDOMNodeId !== undefined &&
      textValue(node.role?.value).toLowerCase() === role.toLowerCase() &&
      (exact
        ? normalize(textValue(node.name?.value)) === normalize(name)
        : normalize(textValue(node.name?.value))
            .toLowerCase()
            .includes(normalize(name).toLowerCase())),
  );
}
function uniqueNode(nodes: AxNode[], missing: string): AxRef {
  if (nodes.length > 1)
    throw new BrowserActionError(
      "AMBIGUOUS_TARGET",
      "Multiple visible elements match. Narrow the name or scope to one container; no element was clicked.",
    );
  const node = nodes[0];
  if (!node || node.backendDOMNodeId === undefined) throw new Error(missing);
  return {
    backendNodeId: node.backendDOMNodeId,
    role: textValue(node.role?.value),
    name: textValue(node.name?.value),
  };
}
async function resolveQuery(
  debuggee: chrome.debugger.Debuggee,
  nodes: AxNode[],
  query: Extract<BrowserElementTarget, { kind: "query" }>,
): Promise<AxRef> {
  const ids = await queryNodes(debuggee, query);
  const visible = await visibleNodes(debuggee, ids);
  if (visible.length > 1) throw new Error("AMBIGUOUS_TARGET");
  const id = visible[0];
  if (id === undefined && ids[0] !== undefined) throw await hiddenTargetError(debuggee, ids[0]);
  if (id === undefined) throw new Error("TARGET_NOT_FOUND");
  const node = nodes.find((node) => node.backendDOMNodeId === id);
  return {
    backendNodeId: id,
    role: textValue(node?.role?.value),
    name: textValue(node?.name?.value),
  };
}

export async function getAxTree(debuggee: chrome.debugger.Debuggee): Promise<AxNode[]> {
  const result = (await chrome.debugger.sendCommand(debuggee, "Accessibility.getFullAXTree")) as {
    nodes?: AxNode[];
  };
  if (!Array.isArray(result.nodes)) throw new Error("UNSUPPORTED");
  const frames = (await chrome.debugger
    .sendCommand(debuggee, "Page.getFrameTree")
    .catch(() => undefined)) as { frameTree?: { frame?: { id?: string } } } | undefined;
  const rootFrameId = frames?.frameTree?.frame?.id;
  if (!rootFrameId) return result.nodes;
  return collectFrameAx(debuggee, rootFrameId, result.nodes);
}

export async function getViewportCenter(
  debuggee: chrome.debugger.Debuggee,
): Promise<{ x: number; y: number }> {
  const viewport = await getViewportSize(debuggee);
  return { x: Math.round(viewport.width / 2), y: Math.round(viewport.height / 2) };
}

export async function getViewportSize(
  debuggee: chrome.debugger.Debuggee,
): Promise<{ width: number; height: number }> {
  const result = (await chrome.debugger.sendCommand(debuggee, "Page.getLayoutMetrics")) as {
    cssVisualViewport?: { clientWidth?: number; clientHeight?: number };
  };
  const width = Math.floor(result.cssVisualViewport?.clientWidth ?? 0);
  const height = Math.floor(result.cssVisualViewport?.clientHeight ?? 0);
  if (width < 1 || height < 1) throw new Error("UNSUPPORTED");
  return { width, height };
}

export async function getCenter(
  debuggee: chrome.debugger.Debuggee,
  backendNodeId: number,
): Promise<{ x: number; y: number }> {
  await chrome.debugger.sendCommand(debuggee, "DOM.scrollIntoViewIfNeeded", { backendNodeId });
  const result = (await chrome.debugger.sendCommand(debuggee, "DOM.getBoxModel", {
    backendNodeId,
  })) as { model?: { content?: number[] } };
  const quad = result.model?.content;
  if (!quad || quad.length < 8) throw new Error("STALE_REF");
  const x = [quad[0], quad[2], quad[4], quad[6]];
  const y = [quad[1], quad[3], quad[5], quad[7]];
  if (
    x.some((coordinate) => coordinate === undefined) ||
    y.some((coordinate) => coordinate === undefined)
  )
    throw new Error("STALE_REF");
  return {
    x: centerOf(x),
    y: centerOf(y),
  };
}

function centerOf(coordinates: (number | undefined)[]): number {
  const total = coordinates.reduce<number>((sum, coordinate) => sum + (coordinate ?? 0), 0);
  return Math.round(total / coordinates.length);
}

export async function clickAt(
  debuggee: chrome.debugger.Debuggee,
  x: number,
  y: number,
): Promise<void> {
  showAgentCursor(debuggee, x, y, true);
  noteActionTiming(debuggee.tabId, { tAct: Date.now(), point: { x, y } });
  await chrome.debugger.sendCommand(debuggee, "Input.dispatchMouseEvent", {
    type: "mousePressed",
    x,
    y,
    button: "left",
    clickCount: 1,
  });
  await chrome.debugger.sendCommand(debuggee, "Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x,
    y,
    button: "left",
    clickCount: 1,
  });
}

export async function scrollAt(
  debuggee: chrome.debugger.Debuggee,
  x: number,
  y: number,
  direction: "up" | "down" | "left" | "right",
  amount: number,
): Promise<void> {
  const positive = direction === "down" || direction === "right" ? 1 : -1;
  await chrome.debugger.sendCommand(debuggee, "Input.dispatchMouseEvent", {
    type: "mouseWheel",
    x,
    y,
    deltaX: direction === "left" || direction === "right" ? amount * positive : 0,
    deltaY: direction === "up" || direction === "down" ? amount * positive : 0,
  });
}
