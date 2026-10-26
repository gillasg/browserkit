import { measureBox, noteActionTiming } from "./native-browser-action-timing.js";
import { showAgentCursor, showAgentKeys, type CursorUpdate } from "./native-browser-cursor.js";
import { onNode, nodeState, fillTextNode } from "./native-browser-dom.js";
import { beginReceipt, takeReceipt } from "./native-browser-receipts.js";
import { noteVaultFill } from "./native-browser-vault.js";
import { humanMouse, paceKey } from "./native-browser-human-input.js";
import { toOffscreen } from "./code-offscreen-host.js";
import {
  type BrowserExecutorRequest,
  type BrowserElementTarget,
  type BrowserStep,
  BrowserExecutorResultSchema,
  type BrowserExecutorResult,
} from "@browserkit/protocol";
import {
  resolveElement,
  clickAt,
  getViewportCenter,
  scrollAt,
  withDebugger,
} from "./native-browser-debugger.js";
import {
  browserObservationRefs,
  screenshotPoint,
  observeSemantic,
} from "./native-browser-observation.js";
import { type AxRef, BrowserActionError, safePage } from "./native-browser-common.js";
import {
  viewportFingerprint,
  primeBrowserSettle,
  settleBrowserPage,
  pageOutcome,
} from "./native-browser-navigation.js";
import { frameContext, rootFramePoint } from "./native-browser-frames.js";
import { refreshInventoryTab } from "./native-inventory-client.js";
import { scrollWithFeedback } from "./native-browser-scroll.js";
import { hiddenTargetError } from "./native-browser-reveal.js";

interface Point {
  x: number;
  y: number;
  activate?: boolean;
}
export async function actionablePoint(
  debuggee: chrome.debugger.Debuggee,
  id: number,
  editable = false,
): Promise<Point> {
  await chrome.debugger.sendCommand(debuggee, "DOM.scrollIntoViewIfNeeded", { backendNodeId: id });
  await onNode(debuggee, id, scrollNearest).catch(() => undefined);
  const state = await onNode<{ visible: boolean; enabled: boolean; editable: boolean }>(
    debuggee,
    id,
    nodeState,
  );
  if (!state.visible) throw await hiddenTargetError(debuggee, id);
  if (!state.enabled) throw new Error("TARGET_DISABLED");
  if (editable && !state.editable) throw new Error("NOT_EDITABLE");
  let prior: Point | undefined;
  for (let attempt = 0; attempt < 12; attempt++) {
    const current = await onNode<Point & { hit: boolean }>(debuggee, id, hitPoint);
    const stable = prior && Math.abs(current.x - prior.x) < 1 && Math.abs(current.y - prior.y) < 1;
    if (stable && current.hit)
      return { x: current.x, y: current.y, ...(current.activate ? { activate: true } : {}) };
    prior = current;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const cover = await onNode<string>(debuggee, id, coveringElement).catch(() => "");
  throw cover ? new BrowserActionError("TARGET_BLOCKED", cover) : new Error("TARGET_BLOCKED");
}
// Names what sits on top of the target, so the agent acts in the open dialog or closes the
// overlay instead of retrying the covered control.
function coveringElement(this: HTMLElement): string {
  const box = this.getBoundingClientRect();
  const x = Math.min(Math.max(box.left + box.width / 2, 0), innerWidth - 1);
  const y = Math.min(Math.max(box.top + box.height / 2, 0), innerHeight - 1);
  const hit = (this.getRootNode() as Document | ShadowRoot).elementFromPoint(x, y);
  if (!hit) return "";
  const layer =
    hit.closest(
      "dialog,[role=dialog],[role=alertdialog],[role=listbox],[role=menu],[aria-modal]",
    ) ?? hit;
  const label = (el: Element) =>
    (el.getAttribute("aria-label") || el.getAttribute("placeholder") || el.textContent || "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 60);
  const role = layer.getAttribute("role") || layer.tagName.toLowerCase();
  const fields = [...layer.querySelectorAll("input,textarea,select,[role=combobox]")]
    .slice(0, 5)
    .map((el) => `"${label(el) || el.getAttribute("name") || "field"}"`);
  const parts = [`covered by ${role} "${label(layer)}"`];
  if (fields.length) parts.push(`its fields: ${fields.join(", ")}`);
  parts.push("act inside it (bu.state() shows its ids) or close it first");
  return parts.join("; ");
}
// DOM-level activation for a target that cannot be hit-tested and has no reachable label.
function activateNode(this: HTMLElement): void {
  if (typeof this.click === "function") this.click();
  else this.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
}
// Brings the target into view inside its nearest scrollable container (dialogs, panels, lists).
function scrollNearest(this: HTMLElement): void {
  this.scrollIntoView({ block: "nearest", inline: "nearest" });
}
function hitPoint(this: HTMLElement) {
  const box = this.getBoundingClientRect();
  const left = Math.max(0, box.left),
    top = Math.max(0, box.top);
  const right = Math.min(innerWidth, box.right),
    bottom = Math.min(innerHeight, box.bottom);
  const x = (left + right) / 2,
    y = (top + bottom) / 2;
  const root = this.getRootNode() as Document | ShadowRoot;
  const hit = root.elementFromPoint(x, y);
  const covered = right > left && bottom > top && !!hit;
  const direct = covered && (hit === this || this.contains(hit));
  // Coordinates stay in this frame; the engine adds each owner iframe's box when it sends Input
  // on the root session (frameElement is null inside a cross-origin frame).
  if (!covered || direct || !ancestorOf(hit, this)) return { x, y, hit: direct };
  // The target sits inside the element that is hit but cannot be hit itself (hidden or
  // pointer-events:none control): use its label if that is reachable, else activate it in the DOM.
  const label = labelOf(this);
  const lbox = label?.getBoundingClientRect();
  const lx = lbox ? lbox.left + lbox.width / 2 : 0,
    ly = lbox ? lbox.top + lbox.height / 2 : 0;
  const lhit =
    label && lbox && lbox.width > 0 && lbox.height > 0 ? root.elementFromPoint(lx, ly) : null;
  if (label && lhit && (lhit === label || label.contains(lhit))) return { x: lx, y: ly, hit: true };
  return { x, y, hit: true, activate: true };
  function ancestorOf(other: Element | null, target: Element): boolean {
    let node: Node | null = target;
    while (node && other) {
      if (node === other) return true;
      const parent: Node | null = node.parentNode;
      node = parent instanceof ShadowRoot ? parent.host : parent;
    }
    return false;
  }
  function labelOf(target: HTMLElement): HTMLElement | null {
    const labels = (target as HTMLInputElement).labels;
    if (labels?.length) return labels[0] as HTMLElement;
    const wrapping = target.closest("label");
    if (wrapping) return wrapping;
    const ref = target.getAttribute("aria-labelledby")?.split(" ")[0];
    return ref ? (root.getElementById?.(ref) ?? null) : null;
  }
}
export async function fillNode(
  debuggee: chrome.debugger.Debuggee,
  id: number,
  value: string,
): Promise<void> {
  const native = await onNode<string>(debuggee, id, setNativeValue, [value]);
  if (native === "done") {
    await noteVaultFill(debuggee, id).catch(() => undefined);
    return;
  }
  if (native !== "text") throw new Error(native);
  await fillTextNode(debuggee, id, value);
  await noteVaultFill(debuggee, id).catch(() => undefined);
}
function setNativeValue(this: HTMLInputElement | HTMLSelectElement, value: string): string {
  if (this instanceof HTMLSelectElement) {
    const options = [...this.options].filter((option) => !option.disabled);
    const normalize = (text: string) => text.trim().toLowerCase();
    let matches = options.filter(
      (option) =>
        normalize(option.value) === normalize(value) || normalize(option.text) === normalize(value),
    );
    if (!matches.length)
      matches = options.filter((option) => normalize(option.text).startsWith(normalize(value)));
    if (matches.length !== 1) return matches.length ? "AMBIGUOUS_TARGET" : "TARGET_NOT_FOUND";
    const match = matches[0];
    if (!match) return "TARGET_NOT_FOUND";
    this.value = match.value;
  } else if (
    this instanceof HTMLInputElement &&
    ["date", "time", "datetime-local", "month", "week", "number", "range", "color"].includes(
      this.type,
    )
  ) {
    const before = this.value;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    setter?.call(this, value);
    if (this.value !== value) {
      setter?.call(this, before);
      return "INPUT_FAILED";
    }
  } else return "text";
  this.dispatchEvent(new Event("input", { bubbles: true }));
  this.dispatchEvent(new Event("change", { bubbles: true }));
  return "done";
}
export async function focusNode(debuggee: chrome.debugger.Debuggee, id: number): Promise<void> {
  const focused = await onNode<boolean>(debuggee, id, function (this: HTMLElement) {
    this.focus({ preventScroll: true });
    return (this.getRootNode() as Document | ShadowRoot).activeElement === this;
  });
  if (!focused) throw new Error("INVALID_TARGET");
}
const keys: Record<string, [string, number, string?]> = {
  Enter: ["Enter", 13, "\r"],
  Tab: ["Tab", 9],
  Escape: ["Escape", 27],
  Backspace: ["Backspace", 8],
  Delete: ["Delete", 46],
  ArrowUp: ["ArrowUp", 38],
  ArrowDown: ["ArrowDown", 40],
  ArrowLeft: ["ArrowLeft", 37],
  ArrowRight: ["ArrowRight", 39],
  Home: ["Home", 36],
  End: ["End", 35],
  Space: ["Space", 32, " "],
};
export async function pressKey(debuggee: chrome.debugger.Debuggee, key: string): Promise<void> {
  const entry = keys[key];
  if (!entry) throw new Error("INVALID_TARGET");
  const [code, windowsVirtualKeyCode, text] = entry;
  const event = { key: key === "Space" ? " " : key, code, windowsVirtualKeyCode };
  showAgentKeys(debuggee, [key]);
  await paceKey(debuggee);
  await chrome.debugger.sendCommand(debuggee, "Input.dispatchKeyEvent", {
    type: text ? "keyDown" : "rawKeyDown",
    ...event,
    ...(text ? { text, unmodifiedText: text } : {}),
  });
  await chrome.debugger.sendCommand(debuggee, "Input.dispatchKeyEvent", {
    type: "keyUp",
    ...event,
  });
}

type Step = Extract<BrowserExecutorRequest["step"], { op: "pointer" | "keys" }>;
export async function executeInteraction(
  debuggee: chrome.debugger.Debuggee,
  step: Step,
): Promise<unknown> {
  if (step.op === "keys") return keyboard(debuggee, step.keys);
  const send = async (type: string, x: number, y: number, extra: Record<string, unknown> = {}) => {
    const params = await humanMouse(debuggee, type, { x, y, ...extra });
    return chrome.debugger.sendCommand(debuggee, "Input.dispatchMouseEvent", { type, ...params });
  };
  if (step.action === "drag" && step.toX !== undefined && step.toY !== undefined)
    showAgentCursor(debuggee, step.toX, step.toY, false, {
      from: { x: step.x, y: step.y },
      caption: "Dragging",
    });
  else
    showAgentCursor(debuggee, step.x, step.y, step.action !== "hover", {
      caption: step.action === "hover" ? "Hovering" : "Clicking",
    });
  await send("mouseMoved", step.x, step.y);
  if (step.action === "hover") return { hovered: true };
  if (step.action === "drag") {
    if (step.toX === undefined || step.toY === undefined) throw new Error("INVALID_TARGET");
    await send("mousePressed", step.x, step.y, { button: "left", buttons: 1, clickCount: 1 });
    try {
      for (let i = 1; i <= 12; i++)
        await send(
          "mouseMoved",
          step.x + ((step.toX - step.x) * i) / 12,
          step.y + ((step.toY - step.y) * i) / 12,
          { button: "left", buttons: 1 },
        );
    } finally {
      await send("mouseReleased", step.toX, step.toY, {
        button: "left",
        buttons: 0,
        clickCount: 1,
      });
    }
    return { dragged: true };
  }
  const count = step.action === "doubleClick" ? 2 : 1;
  for (let click = 1; click <= count; click++) {
    await send("mousePressed", step.x, step.y, { button: "left", clickCount: click });
    await send("mouseReleased", step.x, step.y, { button: "left", clickCount: click });
  }
  return { clicked: true };
}
const IS_MAC = /Mac/i.test(globalThis.navigator?.platform ?? "");
const MAC_COMMANDS: Record<string, string> = {
  a: "selectAll",
  c: "copy",
  v: "paste",
  x: "cut",
  z: "undo",
};
async function keyboard(debuggee: chrome.debugger.Debuggee, combo: string): Promise<unknown> {
  const parts = combo.split("+"),
    key = parts.pop();
  if (!key) throw new Error("INVALID_TARGET");
  const masks: Record<string, number> = {
    Alt: 1,
    Control: 2,
    Ctrl: 2,
    Meta: 4,
    Command: 4,
    Shift: 8,
  };
  let modifiers = 0;
  for (const part of parts) {
    const mask = part === "ControlOrMeta" || part === "Mod" ? (IS_MAC ? 4 : 2) : masks[part];
    if (!mask) throw new Error("Unknown modifier: " + part);
    modifiers |= mask;
  }
  const names: Record<string, number> = {
    Enter: 13,
    Tab: 9,
    Escape: 27,
    Backspace: 8,
    Delete: 46,
    ArrowUp: 38,
    ArrowDown: 40,
    ArrowLeft: 37,
    ArrowRight: 39,
    Home: 36,
    End: 35,
    PageUp: 33,
    PageDown: 34,
    Space: 32,
  };
  const windowsVirtualKeyCode =
    names[key] ?? (key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0);
  if (!windowsVirtualKeyCode) throw new Error("Unsupported key");
  const params = { key: key === "Space" ? " " : key, modifiers, windowsVirtualKeyCode };
  // macOS runs Cmd shortcuts as editing commands, which synthetic key events do not trigger alone.
  const command = IS_MAC && modifiers === 4 ? MAC_COMMANDS[key.toLowerCase()] : undefined;
  showAgentKeys(debuggee, [combo]);
  await paceKey(debuggee);
  await chrome.debugger.sendCommand(debuggee, "Input.dispatchKeyEvent", {
    type: "keyDown",
    ...params,
    ...(!modifiers && key.length === 1 ? { text: key } : {}),
    ...(command ? { commands: [command] } : {}),
  });
  await chrome.debugger.sendCommand(debuggee, "Input.dispatchKeyEvent", {
    type: "keyUp",
    ...params,
  });
  return { pressed: combo };
}

async function pasteNode(
  debuggee: chrome.debugger.Debuggee,
  id: number,
  text: string,
  html: string,
): Promise<void> {
  await chrome.debugger.sendCommand(debuggee, "Page.bringToFront").catch(() => undefined);
  const swap = (await toOffscreen({
    target: "aeon-code-offscreen",
    kind: "clipboardSwap",
    text,
    html,
  }).catch((error: unknown) => ({ error: String(error) }))) as { error?: string } | undefined;
  let backup: string | undefined;
  let pageWritten = false;
  if (swap?.error) {
    backup = await pageClipboard(debuggee, "read");
    pageWritten = Boolean(await pageClipboard(debuggee, "write", text, html));
    if (!pageWritten) throw new BrowserActionError("CLIPBOARD_UNAVAILABLE", swap.error);
  }
  try {
    await onNode(debuggee, id, function (this: HTMLElement) {
      this.focus();
    });
    for (const type of ["rawKeyDown", "keyUp"] as const) {
      await chrome.debugger.sendCommand(debuggee, "Input.dispatchKeyEvent", {
        type,
        key: "v",
        code: "KeyV",
        modifiers: 2,
        windowsVirtualKeyCode: 86,
        ...(type === "rawKeyDown" ? { commands: ["paste"] } : {}),
      });
    }
    await new Promise((done) => setTimeout(done, 30));
    const landed = await onNode<string>(debuggee, id, function (this: HTMLElement) {
      return this.innerHTML || this.innerText || "";
    });
    if (!landed || (!landed.includes(text.slice(0, 20)) && !/text/i.test(landed)))
      await fillTextNode(debuggee, id, text);
  } finally {
    if (pageWritten) await pageClipboard(debuggee, "restore", backup ?? "");
    else
      await toOffscreen({ target: "aeon-code-offscreen", kind: "clipboardRestore" }).catch(
        () => undefined,
      );
  }
}

async function pageClipboard(
  debuggee: chrome.debugger.Debuggee,
  action: string,
  text = "",
  html = "",
): Promise<string | undefined> {
  const expression =
    action === "read"
      ? "navigator.clipboard.readText().catch(()=> '')"
      : action === "restore"
        ? `navigator.clipboard.writeText(${JSON.stringify(text)}).then(()=> 'ok',()=> 'fail')`
        : `navigator.clipboard.write([new ClipboardItem({"text/plain": new Blob([${JSON.stringify(text)}],{type:"text/plain"}), "text/html": new Blob([${JSON.stringify(html)}],{type:"text/html"})})]).then(()=> 'ok',()=> 'fail')`;
  const result = (await chrome.debugger
    .sendCommand(debuggee, "Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    })
    .catch(() => undefined)) as { result?: { value?: unknown } } | undefined;
  if (action === "read") return String(result?.result?.value ?? "");
  return result?.result?.value === "ok" ? "ok" : undefined;
}
function elementCaption(
  request: BrowserExecutorRequest,
  node: AxRef,
  editable: boolean,
): Omit<CursorUpdate, "x" | "y" | "press"> {
  const value = (request.step as { value?: unknown }).value;
  if (editable && typeof value === "string")
    return { text: true, typing: true, caption: `Typing "${value.slice(0, 60)}"` };
  const label = node.name ? `"${node.name.slice(0, 50)}"` : node.role || "element";
  const verb =
    request.step.op === "click"
      ? "Clicking "
      : request.step.op === "press"
        ? "Pressing on "
        : "Using ";
  return { text: editable, caption: verb + label };
}

// Retry only preparation. A delivered click, key or insertion is never replayed.
export async function prepareElement(
  debuggee: chrome.debugger.Debuggee,
  request: BrowserExecutorRequest,
  element: BrowserElementTarget,
  revalidate: () => Promise<void>,
  editable = false,
): Promise<{
  node: AxRef;
  point: Point;
  frame: chrome.debugger.Debuggee;
  top: { x: number; y: number; offsetX: number; offsetY: number };
}> {
  if (!("target" in request.step)) throw new Error("INVALID_TARGET");
  for (let attempt = 0; ; attempt++) {
    await revalidate();
    try {
      const node = await resolveElement(
        debuggee,
        element,
        request.step.target,
        browserObservationRefs.refs,
        browserObservationRefs.latestSnapshots,
        request.expectedDocumentEpoch,
      );
      // A frame's node acts through its own session: DOM ids and Input coordinates are local to it.
      const frame = node.sessionId ? { ...debuggee, sessionId: node.sessionId } : debuggee;
      const point = await actionablePoint(frame, node.backendNodeId, editable);
      // Input events go to the root session in main-viewport coordinates, however deep the frame.
      const top = node.frameId
        ? await rootFramePoint(debuggee, node.frameId, point)
        : { ...point, offsetX: 0, offsetY: 0 };
      showAgentCursor(debuggee, top.x, top.y, false, elementCaption(request, node, editable));
      await revalidate();
      return { node, point, frame, top };
    } catch (caught) {
      const error = normalizePreparationError(caught);
      if (attempt >= 2 || !(error instanceof Error) || !retryablePreparation(error, element))
        throw error;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
}

function retryablePreparation(error: Error, element: BrowserElementTarget): boolean {
  if (["TARGET_NOT_FOUND", "TARGET_HIDDEN", "TARGET_BLOCKED"].includes(error.message)) return true;
  return (
    element.kind !== "ref" &&
    (error.message === "STALE_REF" ||
      /could not find node|no node with|context.*destroyed|cannot find context/i.test(
        error.message,
      ))
  );
}

function normalizePreparationError(error: unknown): unknown {
  if (
    error instanceof Error &&
    /could not find node|no node with|context.*destroyed|cannot find context/i.test(error.message)
  )
    return new Error("STALE_REF");
  return error;
}

type ActionRequest = BrowserExecutorRequest & {
  step: Extract<BrowserStep, { op: "click" | "fill" | "paste" | "scroll" }>;
};
export async function clickScreenshotPoint(
  debuggee: chrome.debugger.Debuggee,
  request: ActionRequest,
): Promise<void> {
  if (request.step.op !== "click" || request.step.element.kind !== "point")
    throw new Error("INVALID_TARGET");
  const point = screenshotPoint(
    request.step.element.screenshotId,
    request.step.target,
    request.expectedDocumentEpoch ?? -1,
  );
  const metrics = (await chrome.debugger.sendCommand(debuggee, "Page.getLayoutMetrics")) as {
    cssVisualViewport?: {
      clientWidth?: number;
      clientHeight?: number;
      pageX?: number;
      pageY?: number;
    };
  };
  const viewport = metrics.cssVisualViewport;
  if (
    viewport?.clientWidth !== point.viewport.width ||
    viewport.clientHeight !== point.viewport.height ||
    Math.abs((viewport.pageX ?? 0) - point.scrollX) > 1 ||
    Math.abs((viewport.pageY ?? 0) - point.scrollY) > 1
  )
    throw new Error("STALE_REF");
  if ((await viewportFingerprint(debuggee)) !== point.fingerprint) throw new Error("STALE_REF");
  await clickAt(
    debuggee,
    Math.round(point.viewport.width * request.step.element.x),
    Math.round(point.viewport.height * request.step.element.y),
  );
}

export async function interactFrame(
  debuggee: chrome.debugger.Debuggee,
  frameId: string,
  selector: string | number,
  value?: string,
): Promise<unknown> {
  const objectId = await resolveFrameObject(debuggee, frameId, selector);
  try {
    const node = (await chrome.debugger.sendCommand(debuggee, "DOM.describeNode", {
      objectId,
    })) as { node: { backendNodeId: number } };
    if (value !== undefined) {
      await fillNode(debuggee, node.node.backendNodeId, value);
      return { filled: true };
    }
    const point = await onNode<{ x: number; y: number; activated?: boolean }>(
      debuggee,
      node.node.backendNodeId,
      framePoint,
    );
    if (point.activated) return { clicked: true, activated: "dom" };
    // Input is sent to this frame's renderer session; same-process frames need the owner offset.
    const offset = await frameOffset(debuggee, frameId);
    await clickAt(debuggee, point.x + offset.x, point.y + offset.y);
    return { clicked: true };
  } finally {
    await chrome.debugger
      .sendCommand(debuggee, "Runtime.releaseObject", { objectId })
      .catch(() => undefined);
  }
}
async function frameOffset(
  debuggee: chrome.debugger.Debuggee,
  frameId: string,
): Promise<{ x: number; y: number }> {
  const tree = (await chrome.debugger.sendCommand(debuggee, "Page.getFrameTree")) as {
    frameTree: { frame: { id: string } };
  };
  if (tree.frameTree.frame.id === frameId) return { x: 0, y: 0 };
  const owner = (await chrome.debugger.sendCommand(debuggee, "DOM.getFrameOwner", { frameId })) as {
    backendNodeId: number;
  };
  const box = (await chrome.debugger.sendCommand(debuggee, "DOM.getBoxModel", {
    backendNodeId: owner.backendNodeId,
  })) as { model: { content: number[] } };
  return { x: box.model.content[0] ?? 0, y: box.model.content[1] ?? 0 };
}

async function resolveFrameObject(
  debuggee: chrome.debugger.Debuggee,
  frameId: string,
  selector: string | number,
): Promise<string> {
  const contextId = await frameContext(debuggee, frameId);
  if (typeof selector === "number") {
    const node = (await chrome.debugger.sendCommand(debuggee, "DOM.resolveNode", {
      backendNodeId: selector,
      executionContextId: contextId,
    })) as { object: { objectId: string } };
    return node.object.objectId;
  }
  const result = (await chrome.debugger.sendCommand(debuggee, "Runtime.evaluate", {
    contextId,
    expression: `(()=>{const roots=[document],items=[];while(roots.length){const root=roots.pop();items.push(...root.querySelectorAll(${JSON.stringify(selector)}));for(const el of root.querySelectorAll('*'))if(el.shadowRoot)roots.push(el.shadowRoot);}if(items.length!==1)throw Error('Expected exactly one element');return items[0]})()`,
  })) as { result?: { objectId?: string }; exceptionDetails?: unknown };
  const objectId = result.result?.objectId;
  if (!objectId || result.exceptionDetails) throw new Error("TARGET_NOT_FOUND");
  return objectId;
}

type RevalidateTarget = (request: BrowserExecutorRequest, tabId: number) => Promise<void>;

export async function performAction(
  request: ActionRequest,
  revalidateTarget: RevalidateTarget,
): Promise<BrowserExecutorResult> {
  const tabId = request.step.target.tabId;
  let outcome: "navigated" | "changed" | "unchanged" | "unknown" = "unknown";
  let note: string | undefined;
  beginReceipt(tabId);
  const scroll = await withDebugger(tabId, async (debuggee) => {
    await revalidateTarget(request, tabId);
    if (request.step.op === "scroll")
      return scrollWithFeedback(debuggee, { ...request, step: request.step });
    const before = await primeBrowserSettle(debuggee);
    const since = Date.now();
    await dispatchAction(debuggee, request, revalidateTarget);
    const settled = await settleBrowserPage(debuggee, 800, since, 80);
    outcome = pageOutcome(before, settled.probe);
    if (request.step.op === "click" && outcome === "unchanged" && !settled.network)
      note = silentClickNote(request.step.element);
    return undefined;
  });
  if (scroll) await revalidateTarget(request, tabId);
  const current = await refreshInventoryTab(tabId);
  if (!current) throw new Error("TARGET_LOST");
  const liveTab = await chrome.tabs.get(tabId).catch(() => undefined);
  if (!liveTab?.url || !safePage(liveTab.url)) throw new Error("TARGET_LOST");
  const observation =
    scroll || (request.step.op !== "scroll" && request.step.observe === false)
      ? undefined
      : await observeSemantic(
          { ...request, expectedDocumentEpoch: current.documentEpoch },
          liveTab,
          revalidateTarget,
        );
  const receipt = takeReceipt(tabId);
  receipt.navigated ||= String(outcome) === "navigated";
  return BrowserExecutorResultSchema.parse({
    kind: "action",
    target: current.target,
    documentEpoch: current.documentEpoch,
    url: liveTab.url,
    outcome,
    receipt,
    ...(note ? { note } : {}),
    ...(observation ? { observation } : {}),
    ...(scroll ? { scroll } : {}),
  });
}

/** A real click that produced no navigation, DOM change or request is usually a miss. */
function silentClickNote(element: BrowserElementTarget): string {
  const what =
    element.kind === "locator"
      ? `${element.role} "${element.name}"${element.scope ? ` in ${element.scope}` : ""}`
      : element.kind === "query"
        ? `${element.by} selector ${JSON.stringify(element.value)}`
        : element.kind === "ref"
          ? `element ${element.ref}`
          : element.kind === "point"
            ? "the clicked point"
            : `backend node ${element.backendNodeId}`;
  return `clicked ${what}: nothing happened (no navigation, DOM change or network request). The card's link may be on a child element; try clicking the child, or a listener may need a pointer event: try page.clickAt(x, y).`;
}

async function dispatchAction(
  debuggee: chrome.debugger.Debuggee,
  request: ActionRequest,
  revalidateTarget: RevalidateTarget,
): Promise<void> {
  await revalidateTarget(request, request.step.target.tabId);
  if (request.step.op === "click" && request.step.element.kind === "point")
    return clickScreenshotPoint(debuggee, request);
  if (request.step.op === "scroll" && !request.step.element)
    return scrollViewport(debuggee, request);
  if (!request.step.element) throw new Error("INVALID_TARGET");
  const {
    node,
    point: box,
    frame,
    top,
  } = await prepareElement(
    debuggee,
    request,
    request.step.element,
    () => revalidateTarget(request, request.step.target.tabId),
    request.step.op === "fill",
  );
  const measured = await measureBox(frame, node.backendNodeId);
  noteActionTiming(debuggee.tabId, {
    box: measured
      ? { ...measured, x: measured.x + top.offsetX, y: measured.y + top.offsetY }
      : undefined,
    point: { x: top.x, y: top.y },
    tAct: Date.now(),
  });
  if (request.step.op === "click")
    await (box.activate
      ? onNode(frame, node.backendNodeId, activateNode)
      : clickAt(debuggee, top.x, top.y));
  else if (request.step.op === "fill")
    await fillNode(frame, node.backendNodeId, request.step.value);
  else if (request.step.op === "paste")
    await pasteNode(frame, node.backendNodeId, request.step.text, request.step.html);
  else await scrollAt(debuggee, top.x, top.y, request.step.direction, request.step.amount);
}

async function scrollViewport(
  debuggee: chrome.debugger.Debuggee,
  request: ActionRequest,
): Promise<void> {
  if (request.step.op !== "scroll" || request.step.element) throw new Error("INVALID_TARGET");
  const center = await getViewportCenter(debuggee);
  await scrollAt(debuggee, center.x, center.y, request.step.direction, request.step.amount);
}

// Page-side: the point to click for an element in a frame. A target inside the element that is hit
// (hidden or pointer-events:none control) is clicked through its label, else activated in the DOM.
function framePoint(this: HTMLElement): { x: number; y: number; activated?: boolean } {
  this.scrollIntoView({ block: "center", inline: "center" });
  const box = this.getBoundingClientRect();
  if (!box.width || !box.height || this.matches(':disabled,[aria-disabled="true"]'))
    throw Error("TARGET_DISABLED");
  const at = (x: number, y: number) => {
    let hit = this.ownerDocument.elementFromPoint(x, y);
    while (hit?.shadowRoot) {
      const next = hit.shadowRoot.elementFromPoint(x, y);
      if (!next || next === hit) break;
      hit = next;
    }
    return hit;
  };
  const x = box.left + box.width / 2,
    y = box.top + box.height / 2;
  const hit = at(x, y);
  if (hit === this || (hit && this.contains(hit))) return { x, y };
  let ancestor = false;
  for (let node: Node | null = this; node && hit; node = node.parentNode)
    if (node === hit) ancestor = true;
  if (!ancestor) throw Error("TARGET_BLOCKED");
  const label =
    (this as unknown as HTMLInputElement).labels?.[0] ?? this.closest("label") ?? undefined;
  const lbox = label?.getBoundingClientRect();
  if (label && lbox && lbox.width && lbox.height) {
    const lx = lbox.left + lbox.width / 2,
      ly = lbox.top + lbox.height / 2;
    const lhit = at(lx, ly);
    if (lhit && (lhit === label || label.contains(lhit))) return { x: lx, y: ly };
  }
  this.click();
  return { x, y, activated: true };
}
