import { viewportFingerprint, settleBrowserPage } from "./native-browser-navigation.js";
import {
  type BrowserSemanticNode,
  BrowserExecutorResultSchema,
  type BrowserExecutorRequest,
  type BrowserExecutorResult,
  type BrowserTargetKey,
} from "@browserkit/protocol";
import {
  booleanProperty,
  textValue,
  type AxNode,
  type AxRef,
  sameTarget,
  targetIdentity,
  type ScreenshotRef,
} from "./native-browser-common.js";
import { currentInventoryTabs } from "./native-inventory-client.js";
import { getAxTree, withDebugger } from "./native-browser-debugger.js";
import { scopedBackendIds } from "./native-browser-dom.js";

interface Capture {
  viewport: { width: number; height: number };
  scrollX: number;
  scrollY: number;
  fingerprint: string;
  dataBase64: string;
}
export async function captureViewport(debuggee: chrome.debugger.Debuggee): Promise<Capture> {
  const metrics = (await chrome.debugger.sendCommand(debuggee, "Page.getLayoutMetrics")) as {
    cssVisualViewport?: {
      clientWidth?: number;
      clientHeight?: number;
      pageX?: number;
      pageY?: number;
    };
  };
  await chrome.debugger.sendCommand(debuggee, "Page.enable");
  const fingerprint = await viewportFingerprint(debuggee);
  const capture = (await chrome.debugger.sendCommand(debuggee, "Page.captureScreenshot", {
    format: "jpeg",
    quality: 60,
    captureBeyondViewport: false,
  })) as { data?: string };
  const view = metrics.cssVisualViewport ?? {};
  const width = Math.floor(view.clientWidth ?? 0),
    height = Math.floor(view.clientHeight ?? 0);
  if (!capture.data || width < 1 || height < 1 || capture.data.length > 1_500_000)
    throw new Error("UNSUPPORTED");
  if ((await viewportFingerprint(debuggee)) !== fingerprint) throw new Error("STALE_REF");
  return {
    viewport: { width, height },
    scrollX: view.pageX ?? 0,
    scrollY: view.pageY ?? 0,
    fingerprint,
    dataBase64: capture.data,
  };
}

const interactiveRoles = new Set([
  "button",
  "link",
  "textbox",
  "searchbox",
  "combobox",
  "checkbox",
  "radio",
  "switch",
  "slider",
  "spinbutton",
  "tab",
  "menuitem",
  "option",
  "treeitem",
  "listbox",
  "menuitemcheckbox",
  "menuitemradio",
]);
interface Options {
  query?: string | undefined;
  interactive?: boolean | undefined;
  /** Keep every relevant node instead of the 180 most useful. */
  all?: boolean | undefined;
  /** Headings, landmarks and controls only; body text is left out. */
  summary?: boolean | undefined;
  /** Nodes the accessibility tree marks ignored (hidden from assistive tech). */
  includeHidden?: boolean | undefined;
  /** Leave out static text and paragraphs. */
  noText?: boolean | undefined;
  /** Only nodes at most this many levels below the root. */
  depth?: number | undefined;
  /** Short names and values, no state properties. */
  compact?: boolean | undefined;
  /** Drop nodes from the end until the observation fits. */
  maxBytes?: number | undefined;
}

const SUMMARY_ROLES = new Set([
  "heading",
  "button",
  "link",
  "textbox",
  "searchbox",
  "combobox",
  "checkbox",
  "radio",
  "tab",
  "switch",
  "menuitem",
  "menuitemcheckbox",
  "slider",
  "spinbutton",
  "main",
  "navigation",
  "banner",
  "contentinfo",
  "complementary",
  "form",
  "search",
  "dialog",
  "alertdialog",
]);

function depthsOf(nodes: AxNode[]): Map<string, number> {
  const parents = new Map(
    nodes.filter((node) => node.nodeId).map((node) => [node.nodeId as string, node.parentId]),
  );
  const depths = new Map<string, number>();
  const depthOf = (id: string | undefined, seen = 0): number => {
    if (!id || seen > 200) return 0;
    const known = depths.get(id);
    if (known !== undefined) return known;
    const depth = 1 + depthOf(parents.get(id), seen + 1);
    depths.set(id, depth);
    return depth;
  };
  for (const node of nodes) if (node.nodeId) depthOf(node.nodeId);
  return depths;
}
export function filterVisibleTextNodes(nodes: AxNode[], visibleText: string): AxNode[] {
  const normalized = visibleText.replace(/\s+/g, " ").toLowerCase();
  return nodes.filter((node) => {
    if (!["statictext", "heading", "paragraph"].includes(textValue(node.role?.value).toLowerCase()))
      return true;
    const text = textValue(node.name?.value).replace(/\s+/g, " ").trim().toLowerCase();
    return !text || normalized.includes(text);
  });
}
function relevant(node: AxNode, options: Options, depth: number): boolean {
  const role = textValue(node.role?.value).toLowerCase();
  const name = textValue(node.name?.value).trim();
  if (node.backendDOMNodeId === undefined || !role) return false;
  if (node.ignored && options.includeHidden !== true) return false;
  if (options.depth !== undefined && depth > options.depth) return false;
  if (options.interactive && !interactiveRoles.has(role)) return false;
  const textRole = ["statictext", "paragraph", "inlinetextbox"].includes(role);
  if (options.noText && textRole) return false;
  if (options.summary && textRole) return false;
  if (options.summary && !SUMMARY_ROLES.has(role) && !interactiveRoles.has(role)) return false;
  if (!name && !interactiveRoles.has(role) && !SUMMARY_ROLES.has(role)) return false;
  if (["generic", "none", "presentation", "inlinetextbox"].includes(role)) return false;
  return !options.query || `${role} ${name}`.toLowerCase().includes(options.query.toLowerCase());
}
function priority(node: AxNode): number {
  if (booleanProperty(node, "focused").focused) return 0;
  const role = textValue(node.role?.value).toLowerCase();
  if (["textbox", "searchbox", "combobox"].includes(role)) return 1;
  if (role === "button") return 2;
  return interactiveRoles.has(role) ? 3 : 4;
}
// Where a node sits: main content first, then the rest, then header, navigation and sidebars,
// then the footer. Snapshots list (and keep) main content before page chrome.
const REGIONS: Record<string, number> = {
  main: 0,
  banner: 2,
  navigation: 2,
  complementary: 2,
  contentinfo: 3,
};
function regionsOf(nodes: AxNode[]): Map<AxNode, number> {
  const byId = new Map(
    nodes.flatMap((node) => (node.nodeId ? [[node.nodeId, node] as const] : [])),
  );
  const memo = new Map<string, number>();
  const region = (node: AxNode | undefined, depth: number): number => {
    if (!node || depth > 200) return 1;
    if (node.nodeId && memo.has(node.nodeId)) return memo.get(node.nodeId) ?? 1;
    const own = REGIONS[textValue(node.role?.value).toLowerCase()];
    const value = own ?? region(node.parentId ? byId.get(node.parentId) : undefined, depth + 1);
    if (node.nodeId) memo.set(node.nodeId, value);
    return value;
  };
  return new Map(nodes.map((node) => [node, region(node, 0)]));
}
function selectionKey(node: AxNode, region: number): number {
  const rank = priority(node);
  return rank <= 1 ? rank : region * 5 + rank;
}
export function createSemanticNodes(
  nodes: AxNode[],
  options: Options = {},
): { refs: Map<string, AxRef>; nodes: BrowserSemanticNode[]; truncated: boolean } {
  const depths = depthsOf(nodes);
  const regions = regionsOf(nodes);
  const regionOf = (node: AxNode) => regions.get(node) ?? 1;
  const cap = options.summary ? 60 : options.all ? 800 : 180;
  const candidates = nodes
    .filter((node) => relevant(node, options, depthOfNode(node)))
    .map((node, index) => ({ node, index }))
    .sort((a, b) => regionOf(a.node) - regionOf(b.node) || a.index - b.index)
    .map(({ node }) => node);
  const selected = new Set(
    [...candidates]
      .sort((a, b) => selectionKey(a, regionOf(a)) - selectionKey(b, regionOf(b)))
      .slice(0, cap),
  );
  const refs = new Map<string, AxRef>();
  const compact: BrowserSemanticNode[] = [];
  for (const node of candidates) {
    if (!selected.has(node)) continue;
    const backendNodeId = node.backendDOMNodeId;
    if (backendNodeId === undefined) continue;
    const role = textValue(node.role?.value).slice(0, 80);
    const limit = options.compact ? 80 : 512;
    const name = textValue(node.name?.value).trim().slice(0, limit);
    const ref = `e${compact.length}`;
    refs.set(ref, { backendNodeId, role, name });
    compact.push({
      ref,
      backendNodeId,
      role,
      name,
      ...(node.ignored ? { hidden: true } : {}),
      ...(node.value ? { value: textValue(node.value.value).slice(0, limit) } : {}),
      ...(options.compact
        ? {}
        : {
            ...booleanProperty(node, "disabled"),
            ...booleanProperty(node, "checked"),
            ...booleanProperty(node, "focused"),
            ...booleanProperty(node, "expanded"),
            ...booleanProperty(node, "selected"),
            ...booleanProperty(node, "pressed"),
            ...(node.properties?.some((p) => p.name === "pressed" && p.value?.value === "mixed")
              ? { pressed: "mixed" as const }
              : {}),
            ...(node.properties?.some((p) => p.name === "checked" && p.value?.value === "mixed")
              ? { mixed: true }
              : {}),
          }),
    });
  }
  truncateToBudget(compact, options.maxBytes);
  return { refs, nodes: compact, truncated: candidates.length > compact.length };

  function depthOfNode(node: AxNode): number {
    return node.nodeId ? (depths.get(node.nodeId) ?? 0) : 0;
  }
}

/** Drops nodes from the end until the observation fits a byte budget (never below ten). */
function truncateToBudget(nodes: BrowserSemanticNode[], maxBytes?: number): void {
  if (!maxBytes || maxBytes <= 0) return;
  while (nodes.length > 10 && JSON.stringify(nodes).length > maxBytes) nodes.pop();
}

export async function visiblePageText(debuggee: chrome.debugger.Debuggee): Promise<string> {
  const response = (await chrome.debugger.sendCommand(debuggee, "Runtime.evaluate", {
    expression: `(${collectVisibleText.toString()})()`,
    returnByValue: true,
  })) as { result?: { value?: string } };
  return response.result?.value ?? "";
}
function collectVisibleText() {
  const roots: (Document | ShadowRoot)[] = [document];
  const lines: { text: string; region: number }[] = [];
  const visible = new WeakMap<Element, boolean>();
  let length = 0;
  for (let i = 0; i < roots.length && length < 20000; i++) {
    const root = roots[i];
    if (!root) continue;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node && length < 20000; node = walker.nextNode()) {
      if (node.nodeType === Node.ELEMENT_NODE) {
        const element = node as Element;
        if (element.shadowRoot) roots.push(element.shadowRoot);
        if (element instanceof HTMLIFrameElement && element.contentDocument)
          roots.push(element.contentDocument);
        continue;
      }
      const text = visibleLine(node);
      if (text) {
        lines.push({ text, region: regionOf(node.parentElement) });
        length += text.length + 1;
      }
    }
  }
  // Main content first, page chrome (header, navigation, footer) last; order kept within each.
  return lines
    .map((line, index) => ({ ...line, index }))
    .sort((a, b) => a.region - b.region || a.index - b.index)
    .map((line) => line.text)
    .join("\n")
    .slice(0, 20000);
  function regionOf(element: Element | null) {
    if (element?.closest("main,[role=main]")) return 0;
    if (element?.closest("footer,[role=contentinfo]")) return 3;
    if (element?.closest("header,nav,aside,[role=banner],[role=navigation],[role=complementary]"))
      return 2;
    return 1;
  }
  function visibleLine(node: Node) {
    let element = node.parentElement;
    const text = node.textContent?.replace(/\s+/g, " ").trim();
    if (!element || !text || element.closest("script,style,noscript,[data-aeon-overlay]"))
      return "";
    while (element.parentElement && getComputedStyle(element).display === "contents")
      element = element.parentElement;
    if (!visible.has(element))
      visible.set(
        element,
        element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }),
      );
    return visible.get(element) ? text : "";
  }
}

const SCREENSHOT_MAX_AGE_MS = 60_000;
const refs = new Map<string, Map<string, AxRef>>();
const latestSnapshots = new Map<string, string>();
const screenshots = new Map<string, ScreenshotRef>();
export const browserObservationRefs = { refs, latestSnapshots };

type RevalidateTarget = (request: BrowserExecutorRequest, tabId: number) => Promise<void>;

export async function observeSemantic(
  request: BrowserExecutorRequest,
  tab: chrome.tabs.Tab,
  revalidateTarget: RevalidateTarget,
): Promise<BrowserExecutorResult> {
  const target = targetForRequest(request);
  const current = currentInventoryTabs().find((item) => sameTarget(item.target, target));
  if (!current || current.documentEpoch !== request.expectedDocumentEpoch)
    throw new Error("TARGET_LOST");
  const { nodes, text } = await withDebugger(target.tabId, async (debuggee) => {
    await revalidateTarget(request, target.tabId);
    await settleBrowserPage(debuggee, 3000, 0);
    await revalidateTarget(request, target.tabId);
    const [nodes, text] = await Promise.all([getAxTree(debuggee), visiblePageText(debuggee)]);
    return { nodes, text };
  });
  const snapshotId = crypto.randomUUID();
  const options =
    request.step.op === "observe"
      ? request.step
      : { query: undefined, interactive: undefined, selector: undefined };
  const scopedIds = options.selector
    ? await withDebugger(target.tabId, (debuggee) =>
        scopedBackendIds(debuggee, options.selector ?? ""),
      )
    : undefined;
  const scoped = scopedIds
    ? nodes.filter((node) => scopedIds.has(node.backendDOMNodeId ?? -1))
    : nodes;
  await revalidateTarget(request, target.tabId);
  const semantic = createSemanticNodes(filterVisibleTextNodes(scoped, text), options);
  const key = targetIdentity(target);
  for (const ref of semantic.refs.values()) ref.documentEpoch = current.documentEpoch;
  refs.set(snapshotId, semantic.refs);
  latestSnapshots.set(key, snapshotId);
  trimOldRefs(snapshotId);
  return BrowserExecutorResultSchema.parse({
    kind: "semantic",
    source: "website",
    trust: "untrusted",
    target,
    documentEpoch: current.documentEpoch,
    snapshotId,
    url: tab.url ?? current.url,
    nodes: semantic.nodes,
    truncated: semantic.truncated,
    text,
  });
}

function targetForRequest(request: BrowserExecutorRequest): BrowserTargetKey {
  if (
    request.step.op === "listTabs" ||
    request.step.op === "openTab" ||
    request.step.op === "attachTab"
  )
    throw new Error("INVALID_TARGET");
  return request.step.target;
}

function trimOldRefs(snapshotId: string): void {
  for (const prior of refs.keys()) if (prior !== snapshotId && refs.size > 8) refs.delete(prior);
  for (const [key, id] of latestSnapshots) if (!refs.has(id)) latestSnapshots.delete(key);
}

export async function captureScreenshot(
  request: BrowserExecutorRequest,
  tab: chrome.tabs.Tab,
  revalidateTarget: RevalidateTarget,
): Promise<BrowserExecutorResult> {
  const target = targetForRequest(request);
  const result = await withDebugger(target.tabId, async (debuggee) => {
    await revalidateTarget(request, target.tabId);
    const capture = await captureViewport(debuggee);
    await revalidateTarget(request, target.tabId);
    const screenshotId = crypto.randomUUID();
    const capturedAt = Date.now();
    screenshots.set(screenshotId, {
      target,
      epoch: request.expectedDocumentEpoch ?? -1,
      viewport: capture.viewport,
      capturedAt,
      fingerprint: capture.fingerprint,
      scrollX: capture.scrollX,
      scrollY: capture.scrollY,
    });
    while (screenshots.size > 8) screenshots.delete(screenshots.keys().next().value ?? "");
    return {
      kind: "screenshot" as const,
      source: "website" as const,
      trust: "untrusted" as const,
      target,
      documentEpoch: request.expectedDocumentEpoch ?? -1,
      screenshotId,
      url: tab.url ?? "",
      viewport: capture.viewport,
      capturedAt,
      mimeType: "image/jpeg" as const,
      dataBase64: capture.dataBase64,
    };
  });
  return BrowserExecutorResultSchema.parse(result);
}

export function screenshotPoint(
  id: string,
  target: BrowserTargetKey,
  epoch: number,
): ScreenshotRef {
  const screenshot = screenshots.get(id);
  if (
    !screenshot ||
    !sameTarget(screenshot.target, target) ||
    screenshot.epoch !== epoch ||
    Date.now() - screenshot.capturedAt > SCREENSHOT_MAX_AGE_MS
  )
    throw new Error("STALE_REF");
  return screenshot;
}
