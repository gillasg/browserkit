import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { WebSocket, WebSocketServer } from "ws";

// A local DevTools Protocol endpoint over agent tabs. Clients see only tabs they opened. Only
// browser-level Target.* bookkeeping is answered here; every page command is passed unchanged to
// the debugger session the engine already has for that tab, and every debugger event comes back
// on the matching session, so clients see Chrome's own frame tree, lifecycle and contexts. Targets
// carry Chrome's real target ids: Playwright keys a page's main frame by its target id.
// Browser-level commands that cannot be honoured are refused with a clear CDP error.

export interface CdpTab {
  tabId: number;
  targetId: string;
  url: string;
  title: string;
  owner?: string;
}

export interface CdpAdapter {
  openTab(session: string, url: string): Promise<CdpTab>;
  closeTab(session: string, tabId: number): Promise<void>;
  listTabs(): Promise<CdpTab[]>;
  command(
    session: string,
    tabId: number,
    method: string,
    params: Record<string, unknown>,
    engineSessionId?: string,
  ): Promise<unknown>;
}

interface TargetInfo {
  targetId: string;
  type: "page";
  title: string;
  url: string;
  attached: boolean;
  canAccessOpener: false;
  browserContextId: string;
}

interface SessionRoute {
  tabId: number;
  engineSessionId?: string;
}

interface Client {
  session: string;
  socket: WebSocket;
  targets: Map<number, CdpTab>;
  owned: Set<number>;
  roots: Map<number, string>;
  sessions: Map<string, SessionRoute>;
  announced: Set<number>;
  discovered: boolean;
  autoAttach: boolean;
}

const CONTEXT = "browserkit";

export class CdpServer {
  private readonly clients = new Set<Client>();
  private readonly server = createServer((request, response) =>
    this.http(request, response).catch((error: unknown) => fail(response, 500, String(error))),
  );
  private readonly sockets = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 * 1024 });
  private port = 0;

  constructor(
    private readonly token: string,
    private readonly adapter: CdpAdapter,
  ) {
    this.server.on("upgrade", (request, socket, head) =>
      this.upgrade(request, socket as never, head),
    );
  }

  async start(port: number): Promise<number> {
    await new Promise<void>((done, reject) => {
      this.server.once("error", reject);
      this.server.listen(port, "127.0.0.1", () => {
        this.server.off("error", reject);
        done();
      });
    });
    this.port = (this.server.address() as { port: number }).port;
    return this.port;
  }

  async stop(): Promise<void> {
    for (const client of this.clients) {
      await this.closeClientTabs(client);
      client.socket.close(1001, "Endpoint stopped");
    }
    this.clients.clear();
    await new Promise<void>((done) => this.server.close(() => done()));
  }

  get url(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  get wsUrl(): string {
    return `ws://127.0.0.1:${this.port}/devtools/browser/${randomUUID()}?token=${this.token}`;
  }

  /** Debugger events for a tab a CDP client owns, relayed on the matching client session. */
  handleEngine(message: Record<string, unknown>): void {
    const tabId = Number(message.tabId);
    if (!Number.isSafeInteger(tabId) || message.kind === "cdp.result") return;
    for (const client of this.clients) {
      if (!client.targets.has(tabId)) continue;
      if (message.kind === "cdp.detached") {
        this.forget(client, tabId);
        continue;
      }
      const source = message.sessionId === undefined ? undefined : String(message.sessionId);
      const session = source
        ? this.childSession(client, tabId, source)
        : this.rootSession(client, tabId);
      const method = String(message.method);
      const params = this.childParams(client, tabId, method, message.params, session);
      this.event(client.socket, method, params, session);
    }
  }

  /** Child-session events name the engine's session id; the client knows its own alias. */
  private childParams(
    client: Client,
    tabId: number,
    method: string,
    raw: unknown,
    parent: string,
  ): Record<string, unknown> {
    const params = { ...((raw ?? {}) as Record<string, unknown>) };
    if (method !== "Target.attachedToTarget" && method !== "Target.detachedFromTarget")
      return params;
    if (params.sessionId === undefined) return params;
    const child = this.childSession(client, tabId, String(params.sessionId));
    params.sessionId = child;
    if (method === "Target.attachedToTarget") params.parentSessionId = parent;
    else client.sessions.delete(child);
    return params;
  }

  private async http(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", `http://127.0.0.1:${this.port}`);
    if (!this.authorised(url, request)) return fail(response, 401, "A token is required");
    if (url.pathname === "/json/version" || url.pathname === "/json/version/") {
      return json(response, {
        Browser: "Chrome/browserkit",
        "Protocol-Version": "1.3",
        "User-Agent": "browserkit",
        "V8-Version": "0",
        "WebKit-Version": "0",
        webSocketDebuggerUrl: `ws://127.0.0.1:${this.port}/devtools/browser/${randomUUID()}?token=${this.token}`,
      });
    }
    if (url.pathname === "/json/list" || url.pathname === "/json") {
      return json(response, await this.allTargets());
    }
    if (url.pathname === "/json/new") {
      if (request.method !== "PUT" && request.method !== "GET")
        return fail(response, 405, "Use PUT /json/new?url");
      const urlToOpen = url.searchParams.get("url") ?? "about:blank";
      const session = `cdp-http-${randomUUID()}`;
      const tab = await this.adapter.openTab(session, urlToOpen);
      json(response, targetInfo(tab));
      return;
    }
    const activate = /^\/json\/activate\/(.+)$/.exec(url.pathname);
    if (activate) return json(response, { ok: true });
    const close = /^\/json\/close\/(.+)$/.exec(url.pathname);
    if (close) {
      const tab = await this.findByTarget(String(close[1]));
      if (!tab) return fail(response, 404, "No such target");
      await this.adapter.closeTab(tab.session, tab.tab.tabId);
      for (const client of this.clients) this.forget(client, tab.tab.tabId);
      return json(response, { ok: true });
    }
    fail(response, 404, "Not found");
  }

  private authorised(url: URL, request: IncomingMessage): boolean {
    if (url.searchParams.get("token") === this.token) return true;
    const header = String(request.headers.authorization ?? "");
    return header === `Bearer ${this.token}`;
  }

  private upgrade(request: IncomingMessage, socket: never, head: Buffer): void {
    const url = new URL(request.url ?? "/", `http://127.0.0.1:${this.port}`);
    if (!url.pathname.startsWith("/devtools/browser/") || !this.authorised(url, request)) {
      (socket as unknown as { destroy(): void }).destroy();
      return;
    }
    this.sockets.handleUpgrade(request, socket as never, head, (ws) => this.accept(ws));
  }

  private accept(socket: WebSocket): void {
    const client: Client = {
      session: `cdp-${randomUUID()}`,
      socket,
      targets: new Map(),
      owned: new Set(),
      roots: new Map(),
      sessions: new Map(),
      announced: new Set(),
      discovered: false,
      autoAttach: false,
    };
    this.clients.add(client);
    socket.on("message", (raw) => void this.message(client, raw.toString()));
    socket.on("close", () => {
      this.clients.delete(client);
      void this.closeClientTabs(client);
    });
    socket.on("error", () => undefined);
  }

  private async message(client: Client, raw: string): Promise<void> {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return;
    }
    const id = message.id;
    const method = String(message.method ?? "");
    const params = (message.params ?? {}) as Record<string, unknown>;
    const sessionId = message.sessionId === undefined ? undefined : String(message.sessionId);
    try {
      const result = sessionId
        ? await this.sessionCommand(client, sessionId, method, params)
        : await this.browserCommand(client, method, params);
      if (id !== undefined) {
        const reply = { id, result: result ?? {}, ...(sessionId ? { sessionId } : {}) };
        client.socket.send(JSON.stringify(reply));
      }
    } catch (error) {
      if (id !== undefined)
        client.socket.send(
          JSON.stringify({
            id,
            ...(sessionId ? { sessionId } : {}),
            error: {
              code: -32000,
              message: String(error instanceof Error ? error.message : error),
            },
          }),
        );
    }
  }

  private async browserCommand(
    client: Client,
    method: string,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    if (method === "Browser.getVersion")
      return {
        protocolVersion: "1.3",
        product: "Chrome/browserkit",
        revision: "0",
        userAgent: "browserkit",
        jsVersion: "V8",
      };
    if (method === "Browser.getWindowForTarget")
      return {
        windowId: 1,
        bounds: { left: 0, top: 0, width: 1280, height: 900, windowState: "normal" },
      };
    if (method === "Browser.setWindowBounds") return {};
    if (method === "Browser.close")
      throw new Error("Browser.close is not supported; close the agent tab instead");
    if (method === "Target.setDiscoverTargets") {
      client.discovered = params.discover !== false;
      if (client.discovered) {
        for (const tab of await this.refreshTargets(client)) this.targetCreated(client, tab);
      }
      return {};
    }
    if (method === "Target.setAutoAttach") {
      client.autoAttach = params.autoAttach !== false;
      if (client.autoAttach)
        for (const tab of await this.refreshTargets(client)) this.announce(client, tab);
      return {};
    }
    if (method === "Target.getTargets")
      return { targetInfos: (await this.refreshTargets(client)).map(targetInfo) };
    if (method === "Target.getBrowserContexts") return { browserContextIds: [CONTEXT] };
    if (method === "Target.createBrowserContext")
      throw new Error("Browser contexts are not supported; use Target.createTarget");
    if (method === "Target.disposeBrowserContext")
      throw new Error("Browser contexts are not supported");
    if (method === "Target.createTarget") {
      const url = String(params.url ?? "about:blank");
      const tab = await this.adapter.openTab(client.session, url);
      client.targets.set(tab.tabId, tab);
      client.owned.add(tab.tabId);
      this.targetCreated(client, tab);
      if (client.autoAttach) this.announce(client, tab);
      return { targetId: tab.targetId };
    }
    if (method === "Target.closeTarget") {
      const found = this.clientTarget(client, String(params.targetId ?? ""));
      if (!found) throw new Error(`Target not found: ${String(params.targetId ?? "")}`);
      if (!client.owned.has(found.tabId))
        throw new Error("TAB_NOT_YOURS: this client did not open that tab");
      await this.adapter.closeTab(client.session, found.tabId);
      this.forget(client, found.tabId);
      return { success: true };
    }
    if (method === "Target.attachToTarget") {
      const found = this.clientTarget(client, String(params.targetId ?? ""));
      if (!found) throw new Error(`Target not found: ${String(params.targetId ?? "")}`);
      const session = this.rootSession(client, found.tabId);
      this.announce(client, found);
      return { sessionId: session };
    }
    if (method === "Target.attachToBrowserTarget") {
      const session = `B${randomUUID()}`;
      client.sessions.set(session, { tabId: -1 });
      return { sessionId: session };
    }
    if (method === "Target.getTargetInfo") {
      const tab = params.targetId ? this.clientTarget(client, String(params.targetId)) : undefined;
      return tab ? { targetInfo: targetInfo(tab) } : {};
    }
    if (method === "Target.activateTarget") return {};
    if (method === "Target.sendMessageToTarget") {
      const session = String(params.sessionId ?? "");
      const target = client.sessions.get(session);
      if (!target) throw new Error(`Session not found: ${session}`);
      return this.adapter.command(
        client.session,
        target.tabId,
        String(params.message ? JSON.parse(String(params.message)).method : ""),
        params.message ? (JSON.parse(String(params.message)).params ?? {}) : {},
        target.engineSessionId,
      );
    }
    if (
      method === "Storage.clearCookies" ||
      method === "Network.clearBrowserCookies" ||
      method === "Network.clearBrowserCache"
    )
      throw new Error(`${method} is not allowed over this endpoint`);
    return {};
  }

  private async sessionCommand(
    client: Client,
    sessionId: string,
    method: string,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    const route = client.sessions.get(sessionId);
    if (!route) throw new Error(`Session not found: ${sessionId}`);
    if (route.tabId < 0) return this.browserCommand(client, method, params);
    if (method === "Target.attachToTarget") {
      const found = this.clientTarget(client, String(params.targetId ?? ""));
      if (!found) throw new Error(`Target not found: ${String(params.targetId ?? "")}`);
      return { sessionId: this.rootSession(client, found.tabId) };
    }
    if (method === "Target.setAutoAttach") {
      return this.adapter.command(
        client.session,
        route.tabId,
        method,
        params,
        route.engineSessionId,
      );
    }
    if (method === "Target.setDiscoverTargets") return {};
    if (method === "Target.getTargetInfo") {
      const tab = client.targets.get(route.tabId);
      return tab ? { targetInfo: targetInfo(tab) } : {};
    }
    return this.adapter.command(client.session, route.tabId, method, params, route.engineSessionId);
  }

  private rootSession(client: Client, tabId: number): string {
    const known = client.roots.get(tabId);
    if (known) return known;
    const session = `S${randomUUID()}`;
    client.roots.set(tabId, session);
    client.sessions.set(session, { tabId });
    return session;
  }

  private childSession(client: Client, tabId: number, engineSessionId: string): string {
    for (const [id, route] of client.sessions)
      if (route.tabId === tabId && route.engineSessionId === engineSessionId) return id;
    const id = `C${randomUUID()}`;
    client.sessions.set(id, { tabId, engineSessionId });
    return id;
  }

  private announce(client: Client, tab: CdpTab): void {
    if (client.announced.has(tab.tabId)) return;
    client.announced.add(tab.tabId);
    const session = this.rootSession(client, tab.tabId);
    this.event(
      client.socket,
      "Target.attachedToTarget",
      {
        sessionId: session,
        targetInfo: { ...targetInfo(tab), attached: true },
        waitingForDebugger: false,
      },
      undefined,
    );
  }

  /** A tab went away: detach its sessions and tell the client the target is gone. */
  private forget(client: Client, tabId: number): void {
    const tab = client.targets.get(tabId);
    if (!tab) return;
    const root = client.roots.get(tabId);
    for (const [id, route] of client.sessions)
      if (route.tabId === tabId) client.sessions.delete(id);
    client.targets.delete(tabId);
    client.roots.delete(tabId);
    client.announced.delete(tabId);
    if (root)
      this.event(client.socket, "Target.detachedFromTarget", {
        sessionId: root,
        targetId: tab.targetId,
      });
    if (client.discovered)
      this.event(client.socket, "Target.targetDestroyed", { targetId: tab.targetId });
  }

  private targetCreated(client: Client, tab: CdpTab): void {
    if (!client.discovered) return;
    this.event(client.socket, "Target.targetCreated", { targetInfo: targetInfo(tab) });
  }

  private event(
    socket: WebSocket,
    method: string,
    params: Record<string, unknown>,
    sessionId?: string,
  ): void {
    socket.send(JSON.stringify({ method, params, ...(sessionId ? { sessionId } : {}) }));
  }

  private clientTarget(client: Client, id: string): CdpTab | undefined {
    for (const tab of client.targets.values()) if (tab.targetId === id) return tab;
    return undefined;
  }

  private async refreshTargets(client: Client): Promise<CdpTab[]> {
    const tabs = await this.adapter.listTabs().catch(() => [] as CdpTab[]);
    const seen = new Set<number>();
    for (const tab of tabs) {
      client.targets.set(tab.tabId, tab);
      seen.add(tab.tabId);
    }
    for (const tabId of [...client.targets.keys()])
      if (!seen.has(tabId) && !client.owned.has(tabId)) client.targets.delete(tabId);
    return [...client.targets.values()];
  }

  private async allTargets(): Promise<unknown[]> {
    const tabs = await this.adapter.listTabs().catch(() => [] as CdpTab[]);
    return tabs.map(targetInfo);
  }

  private async findByTarget(id: string): Promise<{ session: string; tab: CdpTab } | undefined> {
    for (const client of this.clients)
      for (const tab of client.targets.values())
        if (tab.targetId === id) return { session: client.session, tab };
    return undefined;
  }

  private async closeClientTabs(client: Client): Promise<void> {
    for (const tabId of [...client.owned]) {
      const tab = client.targets.get(tabId);
      if (tab) await this.adapter.closeTab(client.session, tab.tabId).catch(() => undefined);
    }
    client.targets.clear();
    client.owned.clear();
    client.roots.clear();
    client.sessions.clear();
  }
}

function targetInfo(tab: CdpTab): TargetInfo {
  return {
    targetId: tab.targetId,
    type: "page",
    title: tab.title || "",
    url: tab.url || "about:blank",
    attached: false,
    canAccessOpener: false,
    browserContextId: CONTEXT,
  };
}

function json(response: ServerResponse, body: unknown): void {
  response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

function fail(response: ServerResponse, status: number, message: string): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify({ error: message }));
}
