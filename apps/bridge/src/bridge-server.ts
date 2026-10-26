import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createHostHandler } from "@browserkit/tools/host";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import { dataDirectory, statePath, type BridgeState } from "./paths.js";
import { CdpServer } from "@browserkit/cdp";
import { isSiteSkillRequest, siteSkillCall } from "./site-skills.js";
import {
  appendJournalEntry,
  loadSessionTargets,
  readJournalEntries,
  saveSessionTargets,
  truncateForJournal,
  type JournalTarget,
} from "./session-journal.js";
import { runLogPath, writeRunLog } from "./session-runs.js";
import {
  readNamedSession,
  readNamedSessions,
  removeNamedSession,
  saveNamedSession,
} from "./named-sessions.js";
import { isWorkspaceRequest, validateUploadFiles, workspaceCall } from "./workspace.js";

// The bridge sits between the browser (extension executors) and agents (CLI and MCP clients).
// Agents send code cells; the bridge forwards each to a connected browser, serves the cell's
// workspace and site-skill calls, and returns the result.
type Json = Record<string, unknown>;
interface Target {
  clientInstanceId: string;
  browserRunId: string;
  tabId: number;
  tabIncarnation: string;
}
interface Executor {
  socket: WebSocket;
  clientInstanceId: string;
  tabs: Map<number, Json>;
}
interface Cell {
  executor: Executor;
  session: string;
  timeoutMs: number;
  startedAt: number;
  code: string;
  timer: ReturnType<typeof setTimeout> | undefined;
  progress: (message: Json) => void;
  finish: (result: Json) => void;
  /** Workspace files this cell wrote, for the run log. */
  files: string[];
}

const PROTOCOL = { major: 1, minor: 6 };
const EXECUTOR_PATH = "/aeon/v1";

export class Bridge {
  private readonly executors = new Map<string, Executor>();
  private readonly cells = new Map<string, Cell>();
  /** Tabs each session opened, passed back as its targets on later cells. */
  private readonly sessionTargets = new Map<string, Map<string, Target>>();
  /** One FIFO per session: a session's own cells run in the order it sent them. */
  private readonly sessionQueues = new Map<string, Promise<unknown>>();
  private readonly sessionQueued = new Map<string, number>();
  private restoredSessions = false;
  private saveTimer: ReturnType<typeof setTimeout> | undefined;
  private cdp: CdpServer | undefined;
  private cdpInfo: { port: number; token: string } | undefined;
  private readonly cdpWaiters = new Map<
    string,
    { resolve: (value: Json) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
  >();

  constructor(private readonly token: string) {}

  attach(socket: WebSocket, path: string): void {
    socket.once("message", (raw) => {
      const hello = parse(raw);
      if (path === EXECUTOR_PATH) this.acceptExecutor(socket, hello);
      else if (path === "/client") this.acceptClient(socket, hello);
      else socket.close(4404, "Unknown endpoint");
    });
  }

  tabs(): Json[] {
    return [...this.executors.values()].flatMap((executor) => [...executor.tabs.values()]);
  }

  /** Live tabs, busy cells and queued cells for one named session. */
  private sessionStage(session: string): { tabs: number[]; busy: number; queued: number } {
    const live = new Set(
      this.tabs().map((tab) => Number(tab.tabId ?? (tab.target as Json | undefined)?.tabId)),
    );
    const tabs = [...(this.sessionTargets.get(session)?.values() ?? [])]
      .map((target) => target.tabId)
      .filter((id) => live.has(id));
    const busy = [...this.cells.values()].filter((cell) => cell.session === session).length;
    return { tabs, busy, queued: this.sessionQueued.get(session) ?? 0 };
  }

  private async sessionList(): Promise<Json> {
    const named = await readNamedSessions();
    const sessions = Object.values(named).map((session) => ({
      ...session,
      ...this.sessionStage(sessionId(session.name)),
    }));
    return { sessions };
  }

  private async sessionInfo(name: string): Promise<Json> {
    const session = await readNamedSession(name);
    return {
      name,
      ...(session
        ? {
            mode: session.mode,
            url: session.url,
            createdAt: session.createdAt,
            lastUsedAt: session.lastUsedAt,
          }
        : {}),
      ...this.sessionStage(sessionId(name)),
    };
  }

  /** Creates or reuses a session's tab (or window). Reopen always makes a new one. */
  private async sessionOpen(request: Json, reopen: boolean): Promise<Json> {
    const name = String(request.session ?? request.name ?? "");
    if (!name) return { error: "SESSION_NAME: give a session name" };
    const known = await readNamedSession(name);
    const mode = String(request.mode ?? known?.mode ?? "tab") === "window" ? "window" : "tab";
    const url = String(request.url ?? known?.url ?? "");
    if (!reopen) {
      const stage = this.sessionStage(sessionId(name));
      if (stage.tabs.length) {
        await saveNamedSession({
          name,
          mode,
          url: known?.url ?? url,
          createdAt: known?.createdAt ?? new Date().toISOString(),
          lastUsedAt: new Date().toISOString(),
        });
        return { ...(await this.sessionInfo(name)), reused: true };
      }
    }
    if (!/^https?:\/\//i.test(url))
      return { error: "SESSION_URL: give an http(s) url to open the session on" };
    await saveNamedSession({
      name,
      mode,
      url,
      createdAt: known?.createdAt ?? new Date().toISOString(),
      lastUsedAt: new Date().toISOString(),
    });
    const id = sessionId(name);
    const result = await this.run(
      { session: id, timeoutMs: 60_000, code: sessionOpenCode(url, mode) },
      () => undefined,
    );
    if (result.error) return { error: result.error, session: name };
    const opened = (result.value ?? {}) as { tabId?: number; target?: Target };
    if (opened.target) this.remember(id, opened.target);
    else {
      const target = this.tabs().find(
        (tab) =>
          Number(tab.tabId ?? (tab.target as Json | undefined)?.tabId) === Number(opened.tabId),
      );
      if (target) this.remember(id, target as unknown as Target);
    }
    return { ...(await this.sessionInfo(name)), ...(result.value as Json | undefined) };
  }

  /** Closes everything a session opened; the name stays for a later reopen. */
  private async sessionCleanup(name: string): Promise<Json> {
    const result = await this.run(
      { session: name, timeoutMs: 60_000, code: sessionCloseCode() },
      () => undefined,
    );
    if (typeof result.error === "string") return { name, error: result.error };
    return { name, ...((result.value ?? {}) as Json) };
  }

  /** Queues a cell behind this session's previous one, then runs it. */
  async run(request: Json, onEvent: (event: Json) => void = () => undefined): Promise<Json> {
    const session = sessionId(String(request.session ?? "default"));
    this.sessionQueued.set(session, (this.sessionQueued.get(session) ?? 0) + 1);
    const previous = this.sessionQueues.get(session) ?? Promise.resolve();
    const job = previous.then(
      () => this.executeRun(request, onEvent),
      () => this.executeRun(request, onEvent),
    );
    this.sessionQueues.set(
      session,
      job.then(
        () => undefined,
        () => undefined,
      ),
    );
    try {
      return await job;
    } finally {
      const left = (this.sessionQueued.get(session) ?? 1) - 1;
      if (left <= 0) this.sessionQueued.delete(session);
      else this.sessionQueued.set(session, left);
    }
  }

  private async executeRun(
    request: Json,
    onEvent: (event: Json) => void = () => undefined,
  ): Promise<Json> {
    const executor = await this.pickExecutor();
    if (!executor)
      return {
        error: "BROWSER_OFFLINE: open Chrome with browserkit installed (see `browserkit setup`).",
      };
    const session = sessionId(String(request.session ?? "default"));
    const timeoutMs = Math.min(Math.max(Number(request.timeoutMs ?? 60000), 1000), 600000);
    const cellId = randomUUID();
    await this.restoreSessions();
    const known = executor.tabs.size > 0 ? executor.tabs : undefined;
    const targets = [...(this.sessionTargets.get(session)?.values() ?? [])].filter(
      (target) =>
        target.clientInstanceId === executor.clientInstanceId &&
        (!known || known.has(target.tabId)),
    );
    return new Promise((resolve) => {
      this.cells.set(cellId, {
        executor,
        session,
        timeoutMs,
        startedAt: Date.now(),
        code: String(request.code ?? "").slice(0, 2000),
        timer: undefined,
        progress: (message) =>
          onEvent({
            event: "progress",
            steps: message.steps,
            ...(typeof message.waitingForUser === "boolean"
              ? { waitingForUser: message.waitingForUser }
              : {}),
          }),
        finish: resolve,
        files: [],
      });
      this.pause(cellId, false);
      send(executor.socket, {
        kind: "browser.code.run",
        cellId,
        chatId: session,
        toolCallId: String(request.id ?? cellId).slice(0, 256),
        code: String(request.code ?? ""),
        targets,
        timeoutMs,
        ...(request.flight === false ? { flight: false } : {}),
      });
    });
  }

  private acceptExecutor(socket: WebSocket, hello: Json | undefined): void {
    if (hello?.kind !== "auth.hello" || hello.role !== "extension-executor") {
      socket.close(4001, "Malformed hello");
      return;
    }
    if (hello.connectionGrant !== this.token) {
      send(socket, {
        kind: "auth.rejected",
        protocolVersion: PROTOCOL,
        code: "AUTHENTICATION_FAILED",
      });
      socket.close(4003, "Authentication failed");
      return;
    }
    const executor: Executor = {
      socket,
      clientInstanceId: String(hello.clientInstanceId),
      tabs: new Map(),
    };
    this.executors.get(executor.clientInstanceId)?.socket.close(4000, "Replaced");
    this.executors.set(executor.clientInstanceId, executor);
    send(socket, {
      kind: "auth.ready",
      protocolVersion: PROTOCOL,
      role: "extension-executor",
      connectionId: randomUUID(),
    });
    socket.on("message", (raw) => this.onExecutorMessage(executor, parse(raw)));
    socket.on("close", () => this.dropExecutor(executor));
  }

  private dropExecutor(executor: Executor): void {
    if (this.executors.get(executor.clientInstanceId) === executor)
      this.executors.delete(executor.clientInstanceId);
    for (const [cellId, cell] of this.cells)
      if (cell.executor === executor)
        this.end(cellId, { error: "BROWSER_OFFLINE: the browser disconnected" });
  }

  private onExecutorMessage(executor: Executor, message: Json | undefined): void {
    if (!message) return;
    if (message.kind === "browser.inventory.full" || message.kind === "browser.inventory.delta") {
      this.applyInventory(executor, message);
    } else if (message.kind === "browser.executor.heartbeat") {
      send(executor.socket, {
        kind: "browser.executor.heartbeat.ack",
        clientInstanceId: message.clientInstanceId,
        browserRunId: message.browserRunId,
      });
    } else if (message.kind === "browser.code.call") {
      void this.serveCall(executor, message);
    } else if (message.kind === "browser.code.progress") {
      const cell = this.cells.get(String(message.cellId));
      if (typeof message.waitingForUser === "boolean")
        this.pause(String(message.cellId), message.waitingForUser);
      cell?.progress(message);
    } else if (message.kind === "browser.code.result") {
      this.complete(message);
    } else if (message.kind === "cdp.result" || message.kind === "cdp.tab") {
      this.completeCdp(message);
    } else if (message.kind === "cdp.event" || message.kind === "cdp.detached") {
      this.cdp?.handleEngine(message);
    }
  }

  private applyInventory(executor: Executor, message: Json): void {
    if (message.kind === "browser.inventory.full")
      executor.tabs = new Map((message.tabs as Json[]).map((tab) => [tabIdOf(tab), tab]));
    else {
      const delta = message.delta as Json;
      if (delta.kind === "tab.upsert")
        executor.tabs.set(tabIdOf(delta.tab as Json), delta.tab as Json);
      else if (delta.kind === "tab.remove")
        executor.tabs.delete(Number((delta.target as Json | undefined)?.tabId));
    }
    send(executor.socket, {
      kind: "browser.inventory.applied",
      generation: message.generation,
      lastSequence: message.kind === "browser.inventory.full" ? 0 : message.sequence,
    });
  }

  private complete(message: Json): void {
    const cellId = String(message.cellId);
    const cell = this.cells.get(cellId);
    if (!cell) return;
    for (const target of (message.opened as Target[] | undefined) ?? [])
      this.remember(cell.session, target);
    this.end(cellId, message);
  }

  private async serveCall(executor: Executor, message: Json): Promise<void> {
    const reply = (body: Json) =>
      send(executor.socket, {
        kind: "browser.code.reply",
        cellId: message.cellId,
        callId: message.callId,
        ...body,
      });
    try {
      const cell = this.cells.get(String(message.cellId));
      if (!cell) throw new Error("Browser cell is no longer active");
      const value = await serveRequest(message.request, cell.session, cell.files);
      reply({ value });
    } catch (error) {
      reply({ error: (error instanceof Error ? error.message : String(error)).slice(0, 20000) });
    }
  }

  private acceptClient(socket: WebSocket, hello: Json | undefined): void {
    if (hello?.kind !== "hello" || hello.token !== this.token) {
      socket.close(4003, "Authentication failed");
      return;
    }
    send(socket, { kind: "ready" });
    socket.on("message", (raw) => {
      const request = parse(raw);
      if (!request) return;
      const respond = (body: Json) => send(socket, { id: request.id, ...body });
      if (request.kind === "status") respond({ browsers: this.executors.size, protocol: PROTOCOL });
      else if (request.kind === "tabs") respond({ tabs: this.tabs() });
      else if (request.kind === "journal") {
        const session = sessionId(String(request.session ?? "default"));
        const limit = Number(request.limit ?? 50);
        void readJournalEntries(session, limit).then((entries) => respond({ entries }));
      } else if (request.kind === "run")
        void this.run(request, (event) => send(socket, { id: request.id, ...event })).then(respond);
      else if (request.kind === "session.list") void this.sessionList().then(respond);
      else if (request.kind === "session.info")
        void this.sessionInfo(sessionId(String(request.session ?? "default"))).then(respond);
      else if (request.kind === "session.create" || request.kind === "session.ensure")
        void this.sessionOpen(request, false).then(respond);
      else if (request.kind === "session.reopen")
        void this.sessionOpen(request, true).then(respond);
      else if (request.kind === "session.cleanup")
        void this.sessionCleanup(String(request.session ?? "default")).then(respond);
      else if (request.kind === "session.delete") {
        const name = String(request.session ?? "default");
        void this.sessionCleanup(name)
          .then(async (result) => ({ ...result, deleted: await removeNamedSession(name) }))
          .then(respond);
      } else if (request.kind === "cdp.start")
        void this.startCdp(Number(request.port ?? 9333)).then(respond);
      else if (request.kind === "cdp.status") void this.cdpStatus().then(respond);
      else if (request.kind === "cdp.stop") void this.stopCdp().then(respond);
      else respond({ error: "Unknown request" });
    });
  }

  /** A cell's deadline stops while the user handles a hand-off and restarts in full after. */
  private pause(cellId: string, waiting: boolean): void {
    const cell = this.cells.get(cellId);
    if (!cell) return;
    if (cell.timer) clearTimeout(cell.timer);
    cell.timer = waiting
      ? undefined
      : setTimeout(() => {
          send(cell.executor.socket, { kind: "browser.code.cancel", cellId, reset: false });
          this.end(cellId, {
            error:
              "Browser code exceeded its deadline; that cell stopped, and its variables and tabs are still there.",
          });
        }, cell.timeoutMs + 5000);
  }

  private end(cellId: string, result: Json): void {
    const cell = this.cells.get(cellId);
    if (!cell) return;
    this.cells.delete(cellId);
    if (cell.timer) clearTimeout(cell.timer);
    // A compact run log per run in the session folder: tabs, hosts, files and jobs.
    const runLog = runLogPath(cell.session);
    void writeRunLog(runLog, {
      session: cell.session,
      startedAt: cell.startedAt,
      durationMs: Date.now() - cell.startedAt,
      isError: typeof result.error === "string",
      files: cell.files,
      result,
    }).catch(() => undefined);
    try {
      const isError = typeof result.error === "string";
      const preview = truncateForJournal(
        JSON.stringify(result.value ?? result.error ?? result),
        400,
      );
      void appendJournalEntry({
        ts: new Date().toISOString(),
        sessionId: cell.session,
        code: truncateForJournal(cell.code, 2000),
        isError,
        durationMs: Date.now() - cell.startedAt,
        resultPreview: preview,
        opened: Array.isArray(result.opened) ? result.opened.length : 0,
        runLog,
      }).catch(() => undefined);
    } catch {
      // A journal entry is never allowed to fail the cell it describes.
    }
    cell.finish({ ...result, runLog });
  }

  private async restoreSessions(): Promise<void> {
    if (this.restoredSessions) return;
    this.restoredSessions = true;
    const stored = await loadSessionTargets();
    for (const [session, targets] of Object.entries(stored)) {
      const map = this.sessionTargets.get(session) ?? new Map<string, Target>();
      for (const target of targets)
        map.set(`${target.clientInstanceId}:${target.tabId}:${target.tabIncarnation}`, target);
      this.sessionTargets.set(session, map);
    }
  }

  private persistSessions(): void {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      const records: Record<string, JournalTarget[]> = {};
      for (const [session, targets] of this.sessionTargets)
        records[session] = [...targets.values()];
      void saveSessionTargets(records).catch(() => undefined);
    }, 300);
  }

  private remember(session: string, target: Target): void {
    const targets = this.sessionTargets.get(session) ?? new Map<string, Target>();
    targets.set(`${target.clientInstanceId}:${target.tabId}:${target.tabIncarnation}`, target);
    this.sessionTargets.set(session, targets);
    this.persistSessions();
  }

  /** Starts (or reports) the local DevTools endpoint. Off until asked for. */
  async startCdp(port: number): Promise<Json> {
    if (this.cdp && this.cdpInfo) return { running: true, ...this.cdpInfo, url: this.cdp.url };
    const token = randomBytes(24).toString("base64url");
    const server = new CdpServer(token, {
      openTab: (session, url) => this.cdpOpenTab(session, url),
      closeTab: (session, tabId) => this.cdpCloseTab(session, tabId),
      command: (session, tabId, method, params, engineSessionId) =>
        this.cdpCommand(session, tabId, method, params, engineSessionId),
    });
    const bound = await server.start(Math.max(0, Math.min(port, 65535)));
    this.cdp = server;
    this.cdpInfo = { port: bound, token };
    const info = {
      running: true,
      port: bound,
      token,
      url: server.url,
      connectUrl: `${server.url}?token=${token}`,
      wsUrl: server.wsUrl,
    };
    await writeFile(join(dataDirectory(), "cdp.json"), JSON.stringify(info, null, 2)).catch(
      () => undefined,
    );
    return info;
  }

  async cdpStatus(): Promise<Json> {
    if (this.cdp && this.cdpInfo) return { running: true, ...this.cdpInfo, url: this.cdp.url };
    try {
      const info = JSON.parse(await readFile(join(dataDirectory(), "cdp.json"), "utf8")) as {
        port?: number;
        token?: string;
      };
      if (!info.port || !info.token) return { running: false };
      const reply = await fetch(
        `http://127.0.0.1:${info.port}/json/version?token=${encodeURIComponent(info.token)}`,
        { signal: AbortSignal.timeout(800) },
      );
      if (!reply.ok) return { running: false };
      return {
        running: true,
        port: info.port,
        token: info.token,
        url: `http://127.0.0.1:${info.port}`,
        connectUrl: `http://127.0.0.1:${info.port}?token=${info.token}`,
      };
    } catch {
      return { running: false };
    }
  }

  async stopCdp(): Promise<Json> {
    await this.cdp?.stop().catch(() => undefined);
    this.cdp = undefined;
    this.cdpInfo = undefined;
    for (const waiter of this.cdpWaiters.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error("CDP endpoint stopped"));
    }
    this.cdpWaiters.clear();
    await unlink(join(dataDirectory(), "cdp.json")).catch(() => undefined);
    return { running: false };
  }

  private async cdpOpenTab(
    session: string,
    url: string,
  ): Promise<{ tabId: number; targetId: string; url: string; title: string }> {
    const reply = await this.cdpSend({ kind: "cdp.newTab", chatId: session, url });
    const tab = reply.tab as Json | undefined;
    const target = (tab?.target ?? {}) as Json;
    if (reply.error || !tab || !reply.targetId)
      throw new Error(String(reply.error ?? "Could not open a tab"));
    return {
      tabId: Number(target.tabId ?? tab.tabId),
      targetId: String(reply.targetId),
      url: String(tab.url ?? url),
      title: String(tab.title ?? ""),
    };
  }

  private async cdpCloseTab(session: string, tabId: number): Promise<void> {
    const reply = await this.cdpSend({ kind: "cdp.closeTab", chatId: session, tabId });
    if (reply.error) throw new Error(String(reply.error));
  }

  private cdpCommand(
    session: string,
    tabId: number,
    method: string,
    params: Record<string, unknown>,
    engineSessionId?: string,
  ): Promise<unknown> {
    return this.cdpSend({
      kind: "cdp.command",
      chatId: session,
      tabId,
      method,
      params,
      ...(engineSessionId ? { sessionId: engineSessionId } : {}),
    }).then((reply) => {
      if (reply.error) throw new Error(String(reply.error));
      return reply.result ?? {};
    });
  }

  private cdpSend(body: Json): Promise<Json> {
    const executor = [...this.executors.values()].find(
      (item) => item.socket.readyState === WebSocket.OPEN,
    );
    if (!executor) return Promise.reject(new Error("BROWSER_OFFLINE: no browser connected"));
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.cdpWaiters.delete(id);
        reject(new Error("CDP command timed out"));
      }, 30_000);
      this.cdpWaiters.set(id, { resolve, reject, timer });
      send(executor.socket, { ...body, id });
    });
  }

  /** Replies from the engine for a CDP command or tab request. */
  private completeCdp(message: Json): void {
    const waiter = this.cdpWaiters.get(String(message.id ?? ""));
    if (!waiter) return;
    this.cdpWaiters.delete(String(message.id));
    clearTimeout(waiter.timer);
    waiter.resolve(message);
  }

  /** A freshly started bridge gives the extension a few seconds to (re)connect. */
  private async pickExecutor(): Promise<Executor | undefined> {
    for (let waited = 0; waited <= 8000; waited += 250) {
      const open = [...this.executors.values()].find(
        (item) => item.socket.readyState === WebSocket.OPEN,
      );
      if (open) return open;
      await new Promise((done) => setTimeout(done, 250));
    }
    return undefined;
  }
}

/** Workspace files, site skills and upload checks: what a cell asks of the machine. */
function serveRequest(request: unknown, session: string, files?: string[]): Promise<unknown> {
  const workspace = join(dataDirectory(), "workspaces", session);
  noteWorkspaceWrite(files, request);
  const answer = hostHandler(request, { source: "bridge", scope: session, workspace });
  return answer ?? Promise.reject(new Error("UNSUPPORTED: unknown browser runtime request"));
}

/** A workspace file this cell wrote, for the run log. */
function noteWorkspaceWrite(files: string[] | undefined, request: unknown): void {
  if (!files || !isWorkspaceRequest(request)) return;
  const kind = (request as { workspace?: unknown }).workspace;
  const name = (request as { name?: unknown }).name;
  if (typeof name === "string" && kind !== "load" && kind !== "loadHelper" && kind !== "image")
    files.push(name);
}

const hostHandler = createHostHandler({
  dataDirectory: dataDirectory(),
  extra: (request, context) => {
    if (isSiteSkillRequest(request))
      return siteSkillCall(join(dataDirectory(), "site-skills"), request);
    if (!context.workspace) return undefined;
    if (isWorkspaceRequest(request)) return workspaceCall(context.workspace, request);
    const upload = request as { validateUpload?: unknown } | null;
    if (Array.isArray(upload?.validateUpload))
      return validateUploadFiles(upload.validateUpload as string[], context.workspace);
    return undefined;
  },
});

function tabIdOf(tab: Json): number {
  return Number((tab.target as Json | undefined)?.tabId);
}

/** Session names map to stable UUIDs: the extension keys REPL realms and tab ownership by them. */
export function sessionId(name: string): string {
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(name))
    return name;
  const hex = createHash("sha256")
    .update("session:" + name)
    .digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function parse(raw: RawData): Json | undefined {
  try {
    const value = JSON.parse(String(raw)) as unknown;
    return typeof value === "object" && value !== null ? (value as Json) : undefined;
  } catch {
    return undefined;
  }
}

function send(socket: WebSocket, message: unknown): void {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}

/** The cell that opens a named session's tab (quiet background) or its own window, and keeps it. */
export function sessionOpenCode(url: string, mode: "tab" | "window"): string {
  const options = mode === "window" ? "{window:{width:1440,height:900}}" : "{quiet:true}";
  return `(async () => {
  const tab = await browser.openTab(${JSON.stringify(url)}, ${options});
  return { tabId: tab.tabId ?? tab.id, url: tab.url, title: tab.title, target: tab.target };
})()`;
}

/** The cell that closes every tab a session opened. */
export function sessionCloseCode(): string {
  return `(async () => {
  const tabs = await browser.tabs();
  let closed = 0;
  for (const tab of tabs) {
    try { await browser.closeTab(tab.tabId); closed += 1; } catch {}
  }
  return { closed };
})()`;
}

/** Starts the bridge on a free local port and publishes its port and token. */
export async function startBridge(
  port = 0,
): Promise<{ bridge: Bridge; state: BridgeState; close(): void }> {
  const token = randomBytes(32).toString("base64url");
  const bridge = new Bridge(token);
  const server = new WebSocketServer({ host: "127.0.0.1", port, maxPayload: 32 * 1024 * 1024 });
  server.on("connection", (socket, request) =>
    bridge.attach(socket, (request.url ?? "").split("?")[0] ?? ""),
  );
  await new Promise<void>((done) => server.once("listening", () => done()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Bridge could not listen");
  const state: BridgeState = { port: address.port, token, pid: process.pid };
  await mkdir(dataDirectory(), { recursive: true });
  const temporary = statePath() + "." + process.pid + ".tmp";
  await writeFile(temporary, JSON.stringify(state), { mode: 0o600 });
  await rename(temporary, statePath());
  return { bridge, state, close: () => server.close() };
}
