import { BrowserActionError } from "./native-browser-common.js";
import type { AxNode } from "./native-browser-common.js";
import type { BrowserExecutorRequest } from "@browserkit/protocol";
import { onNode } from "./native-browser-dom.js";
import { onEngineInstall } from "./native-engine-install.js";

interface FrameNode {
  frame: { id: string; url: string; loaderId?: string; parentId?: string };
  childFrames?: FrameNode[];
}
interface FrameInfo {
  frameId: string;
  url: string;
  frameKey: string;
  sessionId?: string;
  parentFrameId?: string;
}
const sessions = new Map<number, Map<string, string>>();
onEngineInstall(() => {
  chrome.debugger.onEvent.addListener((source, method, raw) => {
    if (source.tabId === undefined) return;
    const params = raw as { sessionId?: string; targetInfo?: { targetId: string; type: string } };
    if (
      method === "Target.attachedToTarget" &&
      params.sessionId &&
      params.targetInfo?.type === "iframe"
    ) {
      const map = sessions.get(source.tabId) ?? new Map<string, string>();
      map.set(params.targetInfo.targetId, params.sessionId);
      sessions.set(source.tabId, map);
      void chrome.debugger
        .sendCommand({ tabId: source.tabId, sessionId: params.sessionId }, "Target.setAutoAttach", {
          autoAttach: true,
          waitForDebuggerOnStart: false,
          flatten: true,
        })
        .catch(() => undefined);
    }
    if (method === "Target.detachedFromTarget")
      for (const map of sessions.values())
        for (const [id, sessionId] of map) if (sessionId === params.sessionId) map.delete(id);
  });
  chrome.debugger.onDetach.addListener((source) => {
    if (source.tabId !== undefined) sessions.delete(source.tabId);
  });
});
export async function discoverFrames(debuggee: chrome.debugger.Debuggee): Promise<FrameInfo[]> {
  await chrome.debugger.sendCommand(debuggee, "Target.setAutoAttach", {
    autoAttach: true,
    waitForDebuggerOnStart: false,
    flatten: true,
  });
  const result: FrameInfo[] = [];
  const roots: (chrome.debugger.Debuggee & { sessionId?: string })[] = [
    debuggee,
    ...[...(sessions.get(debuggee.tabId ?? -1)?.values() ?? [])].map((sessionId) => ({
      ...debuggee,
      sessionId,
    })),
  ];
  for (const source of roots) {
    try {
      const tree = (await chrome.debugger.sendCommand(source, "Page.getFrameTree")) as {
        frameTree: FrameNode;
      };
      appendFrameTree(result, tree.frameTree, source);
    } catch (error) {
      if (!source.sessionId) throw error;
    }
  }
  return result;
}
export async function frameDebuggee(
  debuggee: chrome.debugger.Debuggee,
  frameId?: string,
  frameKey?: string,
): Promise<chrome.debugger.Debuggee> {
  if (!frameId) return debuggee;
  if (!frameKey)
    throw new BrowserActionError(
      "STALE_REF",
      "Frame document key is missing. Use a handle returned by page.frames(), or pass both frameId and frameKey from the same discovery result.",
    );
  const frame = (await discoverFrames(debuggee)).find((item) => item.frameId === frameId);
  if (!frame || !frameKey || frame.frameKey !== frameKey)
    throw new BrowserActionError(
      "STALE_REF",
      "Frame navigated or disappeared; discover frames again.",
    );
  return { ...debuggee, ...(frame.sessionId ? { sessionId: frame.sessionId } : {}) };
}
export async function frameContext(
  debuggee: chrome.debugger.Debuggee,
  frameId: string,
): Promise<number> {
  const context = (await chrome.debugger.sendCommand(debuggee, "Page.createIsolatedWorld", {
    frameId,
    worldName: "browserkit-frames",
  })) as { executionContextId: number };
  return context.executionContextId;
}
export async function evaluateFrame(
  debuggee: chrome.debugger.Debuggee,
  frameId: string,
  expression: string,
): Promise<unknown> {
  const contextId = await frameContext(debuggee, frameId);
  const result = (await chrome.debugger.sendCommand(debuggee, "Runtime.evaluate", {
    expression,
    contextId,
    returnByValue: true,
    awaitPromise: true,
    timeout: 8000,
  })) as {
    result?: { value?: unknown };
    exceptionDetails?: { text: string; exception?: { description: string } };
  };
  if (result.exceptionDetails)
    throw new BrowserActionError(
      "OPERATION_FAILED",
      result.exceptionDetails.exception?.description ?? result.exceptionDetails.text,
    );
  return result.result?.value;
}

function appendFrameTree(
  result: FrameInfo[],
  root: FrameNode,
  source: chrome.debugger.Debuggee & { sessionId?: string },
  parentFrameId?: string,
): void {
  const pending = [{ node: root, parentFrameId }];
  while (pending.length && result.length < 96) {
    const item = pending.pop();
    const node = item?.node;
    if (!node) continue;
    // Extension and browser-internal frames (password managers, devtools) can block the tab's
    // debugger and leave a phantom frame after they navigate away. They are not page content.
    if (/^(chrome|edge|devtools|chrome-extension|moz-extension):/i.test(node.frame.url)) continue;
    const parent = item?.parentFrameId ?? node.frame.parentId;
    const info = {
      frameId: node.frame.id,
      url: node.frame.url,
      frameKey: node.frame.id + ":" + (node.frame.loaderId ?? ""),
      ...(source.sessionId ? { sessionId: source.sessionId } : {}),
      ...(parent ? { parentFrameId: parent } : {}),
    };
    const prior = result.findIndex((entry) => entry.frameId === info.frameId);
    if (prior < 0) result.push(info);
    else if (source.sessionId) result[prior] = info;
    for (const child of node.childFrames ?? [])
      pending.push({ node: child, parentFrameId: node.frame.id });
  }
}

type Upload = BrowserExecutorRequest & {
  step: Extract<BrowserExecutorRequest["step"], { op: "upload" }>;
};
/**
 * The file input for a selector: the input itself, or (for an upload button or drop zone, whose
 * real input is usually hidden) the input inside it, in its form, or the page's only one.
 */
function fileInputExpression(selector: string): string {
  return `(()=>{
const deep=(sel)=>{const roots=[document],found=[];while(roots.length){const root=roots.pop();found.push(...root.querySelectorAll(sel));for(const el of root.querySelectorAll('*'))if(el.shadowRoot)roots.push(el.shadowRoot);}return found;};
const isFile=(el)=>el instanceof HTMLInputElement&&el.type==='file'&&!el.disabled;
const matches=deep(${JSON.stringify(selector)});
if(!matches.length)throw Error('Nothing matches '+${JSON.stringify(selector)});
const direct=matches.find(isFile);if(direct)return direct;
const el=matches[0];
const inside=[...el.querySelectorAll('input[type=file]')].find(isFile);if(inside)return inside;
const form=el.closest('form');const inForm=form&&[...form.querySelectorAll('input[type=file]')].find(isFile);if(inForm)return inForm;
const all=deep('input[type=file]').filter(isFile);if(all.length===1)return all[0];
throw Error(all.length?'Several file inputs on the page: pass a selector for the right one':'No file input on the page for that element');
})()`;
}

export async function uploadFiles(
  debuggee: chrome.debugger.Debuggee,
  request: Upload,
): Promise<unknown> {
  const step = request.step;
  let backendNodeId = step.backendNodeId;
  if (!backendNodeId) {
    if (!step.selector)
      throw new Error("Choose an observed file input or file chooser backendNodeId");
    const result = (await chrome.debugger.sendCommand(debuggee, "Runtime.evaluate", {
      expression: fileInputExpression(step.selector),
      ...(step.frameId ? { contextId: await frameContext(debuggee, step.frameId) } : {}),
    })) as {
      result?: { objectId?: string };
      exceptionDetails?: { exception?: { description?: string } };
    };
    const objectId = result.result?.objectId;
    if (!objectId || result.exceptionDetails)
      throw new Error(
        "TARGET_NOT_FOUND: " +
          (result.exceptionDetails?.exception?.description?.split("\n")[0] ?? "no file input"),
      );
    try {
      const node = (await chrome.debugger.sendCommand(debuggee, "DOM.describeNode", {
        objectId,
      })) as { node: { backendNodeId: number } };
      backendNodeId = node.node.backendNodeId;
    } finally {
      await chrome.debugger
        .sendCommand(debuggee, "Runtime.releaseObject", { objectId })
        .catch(() => undefined);
    }
  }
  const state = await onNode<{ type: string; multiple: boolean; disabled: boolean }>(
    debuggee,
    backendNodeId,
    function (this: HTMLInputElement) {
      return { type: this.type, multiple: this.multiple, disabled: this.disabled };
    },
  );
  if (state.type !== "file" || state.disabled || (!state.multiple && step.files.length > 1))
    throw new Error("INVALID_TARGET");
  await chrome.debugger.sendCommand(debuggee, "DOM.setFileInputFiles", {
    backendNodeId,
    files: step.files,
  });
  const files = await onNode<unknown>(debuggee, backendNodeId, function (this: HTMLInputElement) {
    return [...(this.files ?? [])].map((file) => ({
      name: file.name,
      size: file.size,
      type: file.type,
    }));
  });
  return { files, selected: true };
}

/**
 * The tab's accessibility nodes with each iframe's document spliced in. Same-process frames come
 * through the root target with a frameId; cross-origin frames are read through their own debugger
 * session. Nodes carry the frame they belong to, and the iframe element that owns each frame is
 * marked, so a snapshot can put a frame's controls under its iframe.
 */
export async function collectFrameAx(
  debuggee: chrome.debugger.Debuggee,
  rootFrameId: string,
  rootNodes: AxNode[],
): Promise<AxNode[]> {
  const nodes = rootNodes.map((node) => ({ ...node, frameId: rootFrameId }));
  const seen = new Set<string>();
  for (const node of nodes) seen.add("root:" + (node.nodeId ?? node.backendDOMNodeId));
  const frames = await discoverFrames(debuggee).catch(() => []);
  const sessions = [
    debuggee,
    ...frames.flatMap((frame) =>
      frame.sessionId ? [{ ...debuggee, sessionId: frame.sessionId }] : [],
    ),
  ];
  for (const frame of frames) {
    if (frame.frameId === rootFrameId) continue;
    const source = frame.sessionId ? { ...debuggee, sessionId: frame.sessionId } : debuggee;
    const tree = await send<{ nodes?: AxNode[] }>(
      source,
      "Accessibility.getFullAXTree",
      frame.sessionId ? {} : { frameId: frame.frameId },
    ).catch(() => undefined);
    for (const node of tree?.nodes ?? []) {
      const key = (frame.sessionId ?? "root") + ":" + (node.nodeId ?? node.backendDOMNodeId);
      if (seen.has(key) && !frame.sessionId) continue;
      seen.add(key);
      nodes.push({
        ...node,
        frameId: frame.frameId,
        ...(frame.sessionId ? { sessionId: frame.sessionId } : {}),
      });
    }
  }
  for (const frame of frames) {
    if (frame.frameId === rootFrameId) continue;
    const owner = await frameOwnerId(sessions, frame.frameId);
    if (owner === undefined) continue;
    const node = nodes.find((entry) => entry.backendDOMNodeId === owner);
    if (node) node.frameOwner = frame.frameId;
  }
  return nodes;
}

async function frameOwnerId(
  sources: chrome.debugger.Debuggee[],
  frameId: string,
): Promise<number | undefined> {
  for (const source of sources) {
    const result = await send<{ backendNodeId?: number }>(source, "DOM.getFrameOwner", {
      frameId,
    }).catch(() => undefined);
    if (result?.backendNodeId !== undefined) return result.backendNodeId;
  }
  return undefined;
}

function send<T>(
  debuggee: chrome.debugger.Debuggee,
  method: string,
  params: Record<string, unknown>,
): Promise<T> {
  return chrome.debugger.sendCommand(debuggee, method, params) as Promise<T>;
}

export interface RootPoint {
  x: number;
  y: number;
  offsetX: number;
  offsetY: number;
}

/**
 * A point inside a frame, translated to the tab's main viewport: walk up owner frames, adding
 * each iframe's box (in its parent frame) until the root. Input.dispatchMouseEvent is sent on the
 * root session with this point; the frame's own session is only for DOM work.
 */
export async function rootFramePoint(
  debuggee: chrome.debugger.Debuggee,
  frameId: string,
  point: { x: number; y: number },
): Promise<RootPoint> {
  const root = await rootFrameId(debuggee);
  if (!root || root === frameId) return { ...point, offsetX: 0, offsetY: 0 };
  const sources: chrome.debugger.Debuggee[] = [
    debuggee,
    ...[...(sessions.get(debuggee.tabId ?? -1)?.values() ?? [])].map((sessionId) => ({
      ...debuggee,
      sessionId,
    })),
  ];
  let x = point.x,
    y = point.y,
    current = frameId;
  for (let depth = 0; depth < 12; depth++) {
    const owner = await frameOwner(sources, current);
    if (!owner) break;
    const quad = owner.model.content ?? owner.model.border;
    if (!quad) break;
    x += quad[0] ?? 0;
    y += quad[1] ?? 0;
    const described = await send<{ node?: { frameId?: string } }>(
      owner.source,
      "DOM.describeNode",
      { backendNodeId: owner.backendNodeId },
    ).catch(() => undefined);
    const parent = described?.node?.frameId;
    if (!parent || parent === current) break;
    current = parent;
    if (current === root) break;
  }
  return { x, y, offsetX: x - point.x, offsetY: y - point.y };
}

async function rootFrameId(debuggee: chrome.debugger.Debuggee): Promise<string | undefined> {
  const tree = await send<{ frameTree?: { frame?: { id?: string } } }>(
    debuggee,
    "Page.getFrameTree",
    {},
  ).catch(() => undefined);
  return tree?.frameTree?.frame?.id;
}

async function frameOwner(
  sources: chrome.debugger.Debuggee[],
  frameId: string,
): Promise<
  | {
      source: chrome.debugger.Debuggee;
      backendNodeId: number;
      model: { content?: number[]; border?: number[] };
    }
  | undefined
> {
  for (const source of sources) {
    await send(source, "DOM.enable", {}).catch(() => undefined);
    const owner = await send<{ backendNodeId?: number }>(source, "DOM.getFrameOwner", {
      frameId,
    }).catch(() => undefined);
    if (owner?.backendNodeId === undefined) continue;
    const model = await send<{ content?: number[]; border?: number[] }>(source, "DOM.getBoxModel", {
      backendNodeId: owner.backendNodeId,
    }).catch(() => undefined);
    if (model) return { source, backendNodeId: owner.backendNodeId, model };
  }
  return undefined;
}
