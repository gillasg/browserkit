import {
  SiteScriptDefinitionSchema,
  type SiteScriptDefinition,
  BrowserScriptsSyncSchema,
} from "@browserkit/protocol";
import { withBrowserDebugger } from "./native-browser-session.js";
import { onEngineInstall } from "./native-engine-install.js";

export const SCRIPT_KEY = "aeon-site-scripts";
export function readScripts(value: unknown): SiteScriptDefinition[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const parsed = SiteScriptDefinitionSchema.safeParse(item);
    return parsed.success ? [parsed.data] : [];
  });
}

const bootstrap = `
const previous = globalThis.__aeonSiteScript;
if (previous && previous.revision === revision && !previous.failed) return {alreadyApplied:true};
previous?.dispose();
const cleanups = [], controller = new AbortController();
const state = {revision, failed:false, completed:false, url:location.href, startedAt:Date.now(), value:null, error:null, dispose: () => {
  controller.abort();
  for (const cleanup of cleanups.splice(0).reverse()) {try {cleanup();} catch {}}
  delete globalThis.__aeonSiteScript;
}};
globalThis.__aeonSiteScript = state;
const report = (error) => {
  state.failed = true; state.error = String(error?.message || error).slice(0,1000);
  globalThis.chrome?.runtime?.sendMessage?.({kind:'aeon.script.report', scriptId, revision,
    error:String(error?.message || error).slice(0,1000)})?.catch(() => {});
};
const guarded = (fn) => {try {Promise.resolve(fn()).catch(report);} catch(error) {report(error);}};
const style = (text) => {
  const element = document.createElement('style');
  element.textContent = text; (document.head || document.documentElement).append(element);
  cleanups.push(() => element.remove()); return element;
};
const aeon = Object.freeze({signal:controller.signal, style,
  cleanup: (fn) => {if(typeof fn !== 'function') throw Error('cleanup needs a function'); cleanups.push(fn);},
  hide: (selector) => style(selector + '{display:none!important}'),
  onChange: (fn) => {
    let timer;
    const observer = new MutationObserver(() => {
      if(timer || controller.signal.aborted) return;
      timer = setTimeout(() => {timer = undefined; guarded(fn);}, 120);
    });
    observer.observe(document.documentElement,{subtree:true,childList:true,characterData:true,attributes:true,attributeFilter:["title","aria-label","href","class"]});
    cleanups.push(() => {observer.disconnect(); clearTimeout(timer);}); guarded(fn);
  },
  onRoute: (fn) => {
    let url = location.href;
    const timer = setInterval(() => {if(location.href !== url){url = location.href; guarded(fn);}}, 500);
    cleanups.push(() => clearInterval(timer)); guarded(fn);
  },
});
if(css) style(css);
`;
export function siteScriptSource(script: SiteScriptDefinition): string {
  return `(async () => {
const scriptId = ${JSON.stringify(script.scriptId)}, revision = ${script.revision}, css = ${JSON.stringify(script.css)};
if (!document.documentElement) await new Promise(resolve => document.addEventListener("DOMContentLoaded", resolve, {once:true}));
${bootstrap}
try {
  const value = await (async () => {${script.code}\n})();
  state.completed = true; state.value = typeof value === 'undefined' ? null : value;
  return {applied:!state.failed, revision, value:state.value, error:state.error};
} catch(error) {report(error); return {applied:false, error:String(error?.message || error).slice(0,1000)};}
})()`;
}
export const siteScriptCleanup = "globalThis.__aeonSiteScript?.dispose(); ({removed:true})";

export async function inspectSiteScript(tabId: number, scriptId?: string): Promise<unknown> {
  if (!scriptId) throw new Error("Provide scriptId for status.");
  const stored = await chrome.storage.local.get([SCRIPT_KEY, "aeon-site-script-errors"]);
  const saved = readScripts(stored[SCRIPT_KEY]).find((script) => script.scriptId === scriptId);
  const tab = await chrome.tabs.get(tabId);
  try {
    const registered = await chrome.userScripts.getScripts({ ids: ["aeon-site-" + scriptId] });
    const results = await chrome.userScripts.execute({
      target: { tabId },
      world: "USER_SCRIPT",
      worldId: "aeon-site-" + scriptId,
      js: [
        {
          code: `(() => {const s = globalThis.__aeonSiteScript; return s ? {revision:s.revision,
        completed:s.completed === true, failed:s.failed, error:s.error, startedAt:s.startedAt,
        url:location.href, value:s.value} : {executed:false,url:location.href};})()`,
        },
      ],
    });
    const first = results[0];
    return {
      saved: Boolean(saved),
      enabled: saved?.enabled ?? false,
      registered: registered.length > 0,
      url: tab.url,
      execution: first?.result ?? null,
      error: first?.error ? String(first.error) : undefined,
      lastError:
        (stored["aeon-site-script-errors"] as Record<string, unknown> | undefined)?.[scriptId] ??
        null,
    };
  } catch (error) {
    return { saved: Boolean(saved), url: tab.url, error: String(error) };
  }
}

const worlds = new Map<string, number>();
export async function previewSiteScript(
  tabId: number,
  script: SiteScriptDefinition,
  assertActive: () => Promise<void>,
): Promise<unknown> {
  return withBrowserDebugger(tabId, async (debuggee) => {
    await assertActive();
    const tree = (await chrome.debugger.sendCommand(debuggee, "Page.getFrameTree")) as {
      frameTree: { frame: { id: string; url: string } };
    };
    const url = tree.frameTree.frame.url;
    if (!script.matches.some((pattern) => matches(pattern, url))) throw new Error("INVALID_TARGET");
    const world = (await chrome.debugger.sendCommand(debuggee, "Page.createIsolatedWorld", {
      frameId: tree.frameTree.frame.id,
      worldName: "browserkit-site-" + script.scriptId,
    })) as { executionContextId: number };
    worlds.set(tabId + ":" + script.scriptId, world.executionContextId);
    await assertActive();
    const response = (await boundedPreview(
      chrome.debugger.sendCommand(debuggee, "Runtime.evaluate", {
        expression: siteScriptSource(script),
        contextId: world.executionContextId,
        awaitPromise: true,
        returnByValue: true,
        timeout: 5000,
      }),
    )) as { result?: { value?: unknown }; exceptionDetails?: { text?: string } };
    if (response.exceptionDetails)
      return { applied: false, error: response.exceptionDetails.text ?? "Preview failed" };
    return { installed: false, temporary: true, result: response.result?.value ?? null };
  });
}
export async function removeScriptPreview(tabId: number, scriptId: string): Promise<boolean> {
  const key = tabId + ":" + scriptId,
    contextId = worlds.get(key);
  if (contextId === undefined) return false;
  await withBrowserDebugger(tabId, (debuggee) =>
    chrome.debugger.sendCommand(debuggee, "Runtime.evaluate", {
      expression: siteScriptCleanup,
      contextId,
      returnByValue: true,
    }),
  ).catch(() => undefined);
  worlds.delete(key);
  return true;
}
function matches(pattern: string, url: string): boolean {
  const escaped = pattern
    .split("*")
    .map((part) =>
      Array.from(part, (char) => (/[a-z0-9]/i.test(char) ? char : "\\" + char)).join(""),
    );
  return new RegExp("^" + escaped.join(".*") + "$").test(url);
}
onEngineInstall(() => {
  chrome.tabs.onRemoved.addListener((id) => {
    for (const key of worlds.keys()) if (key.startsWith(id + ":")) worlds.delete(key);
  });
});

async function boundedPreview<T>(operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error("Preview exceeded 5 seconds; reload the page if its state is uncertain."),
            ),
          5000,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

const PENDING_KEY = "aeon-site-script-access";
const PREFIX = "aeon-site-";
let chain: Promise<unknown> = Promise.resolve();

export function handleScriptSync(candidate: unknown): boolean {
  const parsed = BrowserScriptsSyncSchema.safeParse(candidate);
  if (!parsed.success) return false;
  void serialize(async () => {
    const stored = await chrome.storage.local.get(SCRIPT_KEY);
    const previous = readScripts(stored[SCRIPT_KEY]);
    for (const script of previous)
      if (
        !parsed.data.scripts.some(
          (next) =>
            next.scriptId === script.scriptId && next.enabled && next.revision === script.revision,
        )
      )
        await unregister(script.scriptId);
    await chrome.storage.local.set({ [SCRIPT_KEY]: parsed.data.scripts });
    for (const script of parsed.data.scripts)
      if (script.enabled) {
        try {
          await register(script);
          await applyOpenTabs(script);
        } catch (error) {
          await recordError(script.scriptId, String(error));
        }
      }
  }).catch((error) => recordError("sync", String(error)));
  return true;
}
export async function executeSiteScript(
  action: "preview" | "install" | "remove" | "status",
  tabId: number,
  definition?: SiteScriptDefinition,
  scriptId?: string,
  assertActive: () => Promise<void> = async () => undefined,
): Promise<unknown> {
  return serialize(async () => {
    await assertActive();
    if (action === "remove") {
      if (!scriptId) throw new Error("INVALID_TARGET");
      await removeScriptPreview(tabId, scriptId);
      await unregister(scriptId);
      return { removed: true, reloadToResetUntrackedChanges: true };
    }
    if (action === "status") return inspectSiteScript(tabId, scriptId);
    if (!definition) throw new Error("INVALID_TARGET");
    if (action === "preview") return previewSiteScript(tabId, definition, assertActive);
    const setup = await checkAccess(definition);
    if (setup) return setup;
    await removeScriptPreview(tabId, definition.scriptId);
    await validateScriptTab(tabId, definition);
    await assertActive();
    if (action === "install") {
      await register(definition);
      await rememberScript(definition);
    }
    await configure(definition.scriptId);
    await assertActive();
    const results = await boundedScriptExecution(tabId, definition);
    return executionResult(results);
  });
}
function serialize<T>(operation: () => Promise<T>): Promise<T> {
  const next = chain.catch(() => undefined).then(operation);
  chain = next;
  return next;
}
function worldId(id: string): string {
  return PREFIX + id;
}
async function configure(id: string): Promise<void> {
  await chrome.userScripts.configureWorld({
    worldId: worldId(id),
    messaging: true,
    csp: "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline';",
  });
}
async function register(script: SiteScriptDefinition): Promise<void> {
  const setup = await checkAccess(script);
  if (setup) throw new Error(JSON.stringify(setup));
  await configure(script.scriptId);
  const value: chrome.userScripts.RegisteredUserScript = {
    id: PREFIX + script.scriptId,
    matches: script.matches,
    js: [{ code: siteScriptSource(script) }],
    world: "USER_SCRIPT",
    worldId: worldId(script.scriptId),
    runAt: "document_idle",
  };
  const existing = await chrome.userScripts.getScripts({ ids: [value.id] });
  if (existing.length) await chrome.userScripts.update([value]);
  else await chrome.userScripts.register([value]);
}
async function checkAccess(script: SiteScriptDefinition): Promise<unknown | undefined> {
  const origins = script.matches.map((match) => new URL(match).origin + "/*");
  const siteAccess = await chrome.permissions.contains({ origins });
  let userScripts = false;
  try {
    await chrome.userScripts.getScripts();
    userScripts = typeof chrome.userScripts.execute === "function";
  } catch {
    /* setup required */
  }
  if (siteAccess && userScripts) return;
  const stored = await chrome.storage.local.get(PENDING_KEY);
  const pending = Array.isArray(stored[PENDING_KEY]) ? (stored[PENDING_KEY] as string[]) : [];
  await chrome.storage.local.set({
    [PENDING_KEY]: [...new Set([...pending, ...origins])].slice(0, 100),
  });
  return {
    status: "setup_required",
    siteAccess,
    userScripts,
    setupUrl: chrome.runtime.getURL("site-scripts.html"),
    message: siteAccess
      ? "Enable Allow User Scripts in extension details, then retry."
      : "In extension details, set Site access to On all sites and enable Allow User Scripts, then retry.",
  };
}
async function unregister(id: string): Promise<void> {
  try {
    await chrome.userScripts.unregister({ ids: [PREFIX + id] });
  } catch {
    /* disabled or absent */
  }
  const tabs = await chrome.tabs.query({});
  await Promise.allSettled(
    tabs
      .filter((tab) => tab.id !== undefined && /^https?:/.test(tab.url ?? ""))
      .map((tab) =>
        chrome.userScripts.execute({
          target: { tabId: tab.id as number },
          world: "USER_SCRIPT",
          worldId: worldId(id),
          js: [{ code: siteScriptCleanup }],
        }),
      ),
  );
}
function matchesSite(script: SiteScriptDefinition, url: string): boolean {
  return script.matches.some((match) =>
    new RegExp("^" + match.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$").test(
      url,
    ),
  );
}
async function recordError(id: string, error: string): Promise<void> {
  const stored = await chrome.storage.local.get("aeon-site-script-errors");
  const previous = stored["aeon-site-script-errors"] ?? {};
  await chrome.storage.local.set({
    "aeon-site-script-errors": { ...previous, [id]: error.slice(0, 1000) },
  });
}
onEngineInstall(() => {
  chrome.runtime.onUserScriptMessage.addListener((message, sender) => {
    if (
      sender.id !== chrome.runtime.id ||
      message?.kind !== "aeon.script.report" ||
      typeof message.scriptId !== "string" ||
      typeof message.error !== "string"
    )
      return;
    void recordError(message.scriptId, message.error);
  });
  chrome.runtime.onInstalled.addListener(
    () => void restoreScripts().catch((error) => recordError("restore", String(error))),
  );
  chrome.runtime.onStartup.addListener(
    () => void restoreScripts().catch((error) => recordError("restore", String(error))),
  );
  chrome.permissions.onRemoved.addListener(
    () => void restoreScripts().catch((error) => recordError("restore", String(error))),
  );
  chrome.permissions.onAdded.addListener(
    () => void restoreScripts().catch((error) => recordError("restore", String(error))),
  );
  void restoreScripts().catch((error) => recordError("restore", String(error)));
});

async function restoreScripts(): Promise<void> {
  const stored = await chrome.storage.local.get(SCRIPT_KEY);
  handleScriptSync({ kind: "browser.scripts.sync", scripts: readScripts(stored[SCRIPT_KEY]) });
}

async function applyOpenTabs(script: SiteScriptDefinition): Promise<void> {
  if (await checkAccess(script)) return;
  const tabs = await chrome.tabs.query({});
  await Promise.allSettled(
    tabs
      .filter((tab) => tab.id !== undefined && matchesSite(script, tab.url ?? ""))
      .map((tab) => boundedScriptExecution(tab.id as number, script)),
  );
}

async function validateScriptTab(tabId: number, script: SiteScriptDefinition): Promise<void> {
  const tab = await chrome.tabs.get(tabId);
  if (!tab.url || !matchesSite(script, tab.url)) throw new Error("INVALID_TARGET");
}

async function boundedScriptExecution(
  tabId: number,
  script: SiteScriptDefinition,
): Promise<chrome.userScripts.InjectionResult[]> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new Error("Site script did not finish within 5 seconds; its state may be uncertain."),
        ),
      5000,
    );
  });
  try {
    return await Promise.race([
      chrome.userScripts.execute({
        target: { tabId },
        world: "USER_SCRIPT",
        worldId: worldId(script.scriptId),
        js: [{ code: siteScriptSource(script) }],
      }),
      timeout,
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function executionResult(results: chrome.userScripts.InjectionResult[]): unknown {
  const first = results[0];
  if (!first)
    return { installed: true, applied: false, error: "No execution result from the target page." };
  if (first.error)
    return { installed: true, applied: false, error: String(first.error).slice(0, 1000) };
  return { installed: true, result: first.result ?? null };
}

async function rememberScript(script: SiteScriptDefinition): Promise<void> {
  const stored = await chrome.storage.local.get(SCRIPT_KEY);
  const scripts = readScripts(stored[SCRIPT_KEY]).filter(
    (item) => item.scriptId !== script.scriptId,
  );
  await chrome.storage.local.set({ [SCRIPT_KEY]: [...scripts, script] });
}
