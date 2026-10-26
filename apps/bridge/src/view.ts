import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { WebSocketServer, WebSocket } from "ws";

// A tiny local viewer for one agent tab. It does not own a screencast: the engine forwards the
// one flight/recordTab stream, and input travels back as agent input.
export class ViewServer {
  private readonly clients = new Set<WebSocket>();
  private readonly server = createServer((request, response) => this.http(request, response));
  private readonly sockets = new WebSocketServer({ noServer: true, maxPayload: 1_000_000 });
  private port = 0;
  private readonly token = randomBytes(24).toString("base64url");

  constructor(
    readonly tabId: number,
    private readonly onInput: (message: Record<string, unknown>) => void,
    private readonly onFrameRequest: () => void,
  ) {
    this.server.on("upgrade", (request, socket, head) => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (url.pathname !== "/view/ws" || url.searchParams.get("token") !== this.token) {
        socket.destroy();
        return;
      }
      this.sockets.handleUpgrade(request, socket as never, head, (ws) => {
        this.clients.add(ws);
        this.onFrameRequest();
        ws.on("message", (raw) => {
          try {
            const message = JSON.parse(String(raw)) as Record<string, unknown>;
            this.onInput({ ...message, tabId: this.tabId });
          } catch {
            /* Ignore malformed viewer input. */
          }
        });
        ws.on("close", () => this.clients.delete(ws));
      });
    });
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

  get url(): string {
    return `http://127.0.0.1:${this.port}/view?token=${this.token}`;
  }

  frame(data: string): void {
    const payload = JSON.stringify({ kind: "frame", data: `data:image/jpeg;base64,${data}` });
    for (const client of this.clients)
      if (client.readyState === WebSocket.OPEN) client.send(payload);
  }

  async stop(): Promise<void> {
    for (const client of this.clients) client.close(1001, "Viewer stopped");
    this.clients.clear();
    await new Promise<void>((done) => this.server.close(() => done()));
  }

  private http(request: IncomingMessage, response: ServerResponse): void {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== "/view" || url.searchParams.get("token") !== this.token) {
      response.writeHead(url.pathname === "/view" ? 401 : 404, { "content-type": "text/plain" });
      response.end("Unauthorized");
      return;
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(
      `<!doctype html><meta charset="utf-8"><title>Agent view</title><style>html,body{margin:0;height:100%;background:#111;display:grid;place-items:center;overflow:hidden}img{max-width:100vw;max-height:100vh;object-fit:contain;cursor:crosshair}</style><img id="v" alt="agent tab"><script>const img=document.getElementById("v"),ws=new WebSocket(location.origin.replace("http","ws")+"/view/ws?token=${this.token}");ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.kind==="frame")img.src=m.data};img.onclick=e=>{const b=img.getBoundingClientRect();ws.send(JSON.stringify({action:"click",x:e.clientX-b.left, y:e.clientY-b.top}))};addEventListener("keydown",e=>ws.send(JSON.stringify({action:"key",key:e.key})));</script>`,
    );
  }
}
