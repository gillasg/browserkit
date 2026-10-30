import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import { cliHost, type CliHost } from "./host.js";
import { statePath, type BridgeState } from "./paths.js";

type Json = Record<string, unknown>;
const cli = fileURLToPath(new URL("./cli.js", import.meta.url));

/** Returns a running bridge, starting one in the background when none answers. */
export async function ensureBridge(): Promise<BridgeState> {
  const current = await readState();
  if (current && (await reachable(current))) return current;
  launchDetached([process.execPath, cli, "serve"]);
  for (let waited = 0; waited < 15000; waited += 200) {
    await new Promise((done) => setTimeout(done, 200));
    const next = await readState();
    if (next && next.pid !== current?.pid && (await reachable(next))) return next;
  }
  throw new Error("The bridge did not start; run `browserkit serve` to see why.");
}

async function readState(): Promise<BridgeState | undefined> {
  try {
    return JSON.parse(await readFile(statePath(), "utf8")) as BridgeState;
  } catch {
    return undefined;
  }
}

function reachable(state: BridgeState): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new WebSocket(`ws://127.0.0.1:${state.port}/client`);
    const done = (ok: boolean) => {
      clearTimeout(timer);
      socket.close();
      resolve(ok);
    };
    const timer = setTimeout(() => done(false), 1500);
    socket.on("open", () => socket.send(JSON.stringify({ kind: "hello", token: state.token })));
    socket.on("message", (raw) => done(JSON.parse(String(raw)).kind === "ready"));
    socket.on("error", () => done(false));
  });
}

/**
 * Starts a process that outlives its parent. On Windows the native host runs inside Chrome's
 * process job, so the bridge is created through WMI instead, which places it outside that job.
 */
function launchDetached(command: string[]): void {
  if (process.platform === "win32") {
    const line = command.map((part) => `"${part}"`).join(" ");
    const script =
      "$s = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ShowWindow=0}; " +
      `Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{CommandLine='${line.replaceAll("'", "''")}'; ProcessStartupInformation=$s} | Out-Null`;
    spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
      stdio: "ignore",
      windowsHide: true,
    }).unref();
    return;
  }
  spawn(command[0] ?? process.execPath, command.slice(1), {
    detached: true,
    stdio: "ignore",
  }).unref();
}

/** One connection to the bridge for CLI and MCP requests. */
export class BridgeClient {
  private sequence = 0;
  private readonly waiting = new Map<
    number,
    { resolve(value: Json): void; onEvent?: ((event: Json) => void) | undefined }
  >();

  private constructor(
    private readonly socket: WebSocket | undefined,
    private readonly host?: CliHost,
  ) {
    if (!socket) return;
    socket.on("message", (raw) => {
      const message = JSON.parse(String(raw)) as Json;
      const waiter = this.waiting.get(Number(message.id));
      if (!waiter) return;
      if (message.event) waiter.onEvent?.(message);
      else {
        this.waiting.delete(Number(message.id));
        waiter.resolve(message);
      }
    });
    socket.on("close", () => {
      for (const waiter of this.waiting.values()) waiter.resolve({ error: "Bridge disconnected" });
      this.waiting.clear();
    });
  }

  static async connect(): Promise<BridgeClient> {
    // An app that runs browser code itself installs a host; its commands then never need a bridge.
    const host = cliHost();
    if (host) return new BridgeClient(undefined, host);
    const state = await ensureBridge();
    const socket = new WebSocket(`ws://127.0.0.1:${state.port}/client`);
    await new Promise<void>((resolve, reject) => {
      socket.once("error", reject);
      socket.once("open", () => socket.send(JSON.stringify({ kind: "hello", token: state.token })));
      socket.once("message", () => resolve());
    });
    return new BridgeClient(socket);
  }

  request(kind: string, body: Json = {}, onEvent?: (event: Json) => void): Promise<Json> {
    if (this.host) return hostRequest(this.host, kind, body);
    const socket = this.socket as WebSocket;
    const id = ++this.sequence;
    return new Promise((resolve) => {
      this.waiting.set(id, { resolve, onEvent });
      socket.send(JSON.stringify({ id, kind, ...body }));
    });
  }

  close(): void {
    this.socket?.close();
  }
}

/** A bridge request answered by the host: browser code runs there; the rest is bridge-only. */
async function hostRequest(host: CliHost, kind: string, body: Json): Promise<Json> {
  if (kind === "status") return { browsers: 1 };
  if (kind !== "run") return { error: `${kind} needs browserkit's own bridge` };
  try {
    const options = {
      ...(typeof body.session === "string" ? { session: body.session } : {}),
      ...(typeof body.timeoutMs === "number" ? { timeoutMs: body.timeoutMs } : {}),
    };
    return { value: await host.runInBrowser(String(body.code ?? ""), options) };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}
