// browserkit service worker: connects this browser to the local bridge as a browser
// executor, so any agent talking to the bridge (CLI or MCP) can run browser_code here.
import {
  AuthHelloSchema,
  BrowserExecutorHeartbeatReplySchema,
  BrowserInventoryReplySchema,
  NativeBootstrapRequestSchema,
  NativeBootstrapResponseSchema,
  ENGINE_PROTOCOL_VERSION,
} from "@browserkit/protocol";
import {
  authenticate,
  configureEngine,
  getBrowserIdentity,
  handleBrowserCodeMessage,
  handleBrowserExecutorMessage,
  hostErrorCode,
  installBoosts,
  installBrowserPopupGuard,
  installEngineListeners,
  installNativeStartup,
  releaseBrowserExecutor,
  resetRealm,
  scheduleExecutorReconnect,
  startExecutorHeartbeat,
  synchronizeBrowserInventory,
  type BrowserIdentity,
} from "@browserkit/engine";
import { listenToCompanions } from "./companion.js";

const NATIVE_HOST = "com.browserkit.bridge";

listenToCompanions();

interface Connection extends BrowserIdentity {
  socket: WebSocket;
  heartbeatTimer?: number;
}

let connection: Connection | undefined;
let connecting: Promise<Connection> | undefined;

configureEngine({
  controllingTitle: (session) => "An agent is controlling this tab · " + session.slice(0, 8),
  idleTitle: "browserkit",
  notificationIcon: "icon-128.png",
  // Every browserkit caller is outside a chat UI (CLI, MCP, bridge sessions): bulk work.
  defaultSpace: () => "window",
});
installEngineListeners();
void chrome.storage.session.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
// Saved boosts (browser.boosts) apply in every tab.
installBoosts();
installNativeStartup(ensureConnection, () => scheduleExecutorReconnect(ensureConnection));
// Status for the toolbar popup and the welcome page.
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (sender.id !== chrome.runtime.id || message?.kind !== "bue.status") return;
  void ensureConnection().then(
    () => reply({ connected: true }),
    (error: unknown) => reply({ connected: false, error: String(error) }),
  );
  return true;
});
// The first install opens a page that says what this is and the one command that sets it up.
chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason !== "install") return;
  void chrome.tabs.create({ url: chrome.runtime.getURL("welcome.html") }).catch(() => undefined);
});

function ensureConnection(): Promise<Connection> {
  if (connection?.socket.readyState === WebSocket.OPEN) return Promise.resolve(connection);
  connecting ??= connect().finally(() => {
    connecting = undefined;
  });
  return connecting;
}

async function connect(): Promise<Connection> {
  const identity = await getBrowserIdentity();
  const bootstrap = await sendNativeBootstrap(identity);
  const socket = new WebSocket(bootstrap.endpoint);
  const reply = await authenticate(
    socket,
    AuthHelloSchema.parse({
      kind: "auth.hello",
      protocolVersion: ENGINE_PROTOCOL_VERSION,
      role: "extension-executor",
      ...identity,
      connectionGrant: bootstrap.connectionGrant,
    }),
  );
  if (!reply || reply.kind !== "auth.ready" || reply.role !== "extension-executor")
    throw new Error(reply?.kind === "auth.rejected" ? reply.code : "CONNECTION_TIMEOUT");
  const current: Connection = { ...identity, socket };
  socket.addEventListener("message", (event) => onMessage(current, event.data));
  socket.addEventListener("close", () => drop(current), { once: true });
  connection = current;
  current.heartbeatTimer = startExecutorHeartbeat(socket, identity);
  void synchronizeBrowserInventory(socket, identity)
    .then(() => installBrowserPopupGuard(socket))
    .catch(() => socket.close(4001, "Inventory sync failed"));
  return current;
}

async function sendNativeBootstrap(identity: BrowserIdentity) {
  const request = NativeBootstrapRequestSchema.parse({
    kind: "native.bootstrap",
    protocolVersion: ENGINE_PROTOCOL_VERSION,
    ...identity,
  });
  const result = await new Promise<{ response?: unknown; error?: string }>((resolve) => {
    const timer = globalThis.setTimeout(() => resolve({ error: "BOOTSTRAP_TIMEOUT" }), 10_000);
    chrome.runtime.sendNativeMessage(NATIVE_HOST, request, (response) => {
      globalThis.clearTimeout(timer);
      resolve({
        response,
        ...(chrome.runtime.lastError ? { error: chrome.runtime.lastError.message } : {}),
      });
    });
  });
  if (result.error) throw new Error(hostErrorCode(result.error));
  const parsed = NativeBootstrapResponseSchema.safeParse(result.response);
  if (!parsed.success) throw new Error("BOOTSTRAP_UNAVAILABLE");
  if (!parsed.data.ok) throw new Error(parsed.data.code);
  return parsed.data;
}

function onMessage(current: Connection, data: unknown): void {
  let candidate: unknown;
  try {
    candidate = JSON.parse(String(data)) as unknown;
  } catch {
    current.socket.close(4002, "Invalid bridge message");
    return;
  }
  if (BrowserExecutorHeartbeatReplySchema.safeParse(candidate).success) return;
  if (BrowserInventoryReplySchema.safeParse(candidate).success) return;
  if (handleBrowserCodeMessage(current, current.socket, candidate)) return;
  const release = candidate as { kind?: unknown; chatId?: unknown; reset?: unknown } | null;
  if (release?.kind === "browser.release" && release.reset === true)
    void resetRealm(String(release.chatId));
  handleBrowserExecutorMessage(current, current.socket, candidate);
}

function drop(current: Connection): void {
  if (current.heartbeatTimer !== undefined) globalThis.clearInterval(current.heartbeatTimer);
  if (connection !== current) return;
  releaseBrowserExecutor();
  connection = undefined;
  scheduleExecutorReconnect(ensureConnection);
}
