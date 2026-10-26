import { FlightRing } from "./flight-buffer.js";

// Hosts one sandboxed realm per chat and relays its browser calls to the service worker.
// A long browser.job (many pages) gets its own realm and stays alive after its cell returns.
interface Realm {
  frame: HTMLIFrameElement;
  ready: Promise<void>;
}
interface JobRealm extends Realm {
  chatId: string;
}
const realms = new Map<string, Realm>();
const jobRealms = new Map<string, JobRealm>();
const cells = new Map<string, { chatId: string; reply: (value: unknown) => void }>();

function realm(chatId: string): Realm {
  const existing = realms.get(chatId);
  if (existing) return existing;
  const frame = document.createElement("iframe");
  frame.src = "code-sandbox.html";
  const ready = new Promise<void>((resolve) =>
    frame.addEventListener("load", () => resolve(), { once: true }),
  );
  document.body.append(frame);
  const created = { frame, ready };
  realms.set(chatId, created);
  return created;
}

function jobRealm(jobId: string, chatId: string): JobRealm {
  const existing = jobRealms.get(jobId);
  if (existing) return existing;
  const frame = document.createElement("iframe");
  frame.src = "code-sandbox.html";
  const ready = new Promise<void>((resolve) =>
    frame.addEventListener("load", () => resolve(), { once: true }),
  );
  document.body.append(frame);
  const created = { frame, ready, chatId };
  jobRealms.set(jobId, created);
  return created;
}

function drop(chatId: string): void {
  realms.get(chatId)?.frame.remove();
  realms.delete(chatId);
  for (const [jobId, job] of jobRealms)
    if (job.chatId === chatId) {
      job.frame.remove();
      jobRealms.delete(jobId);
    }
  for (const [cellId, cell] of cells)
    if (cell.chatId === chatId) {
      cells.delete(cellId);
      cell.reply({ output: "", error: "Browser runtime reset", reset: true });
    }
}

window.addEventListener("message", (event) => {
  const message = event.data as {
    kind?: string;
    cellId?: string;
    callId?: string;
    request?: unknown;
  };
  const source = [...realms.entries()].find(
    ([, item]) => item.frame.contentWindow === event.source,
  );
  const job = [...jobRealms.entries()].find(
    ([, item]) => item.frame.contentWindow === event.source,
  );
  if ((!source && !job) || typeof message?.cellId !== "string") return;
  const chatId = source?.[0] ?? job?.[1].chatId;
  const jobId = job?.[0];
  const frame = source?.[1].frame ?? job?.[1].frame;
  if (!frame) return;
  if (message.kind === "call") {
    void chrome.runtime
      .sendMessage({
        target: "aeon-code-host",
        kind: "call",
        cellId: message.cellId,
        request: message.request,
      })
      .then(
        (response: { value?: unknown; error?: string } | undefined) =>
          response ?? { error: "Browser host unavailable" },
        (error: unknown) => ({ error: String(error) }),
      )
      .then((response) =>
        frame.contentWindow?.postMessage(
          { kind: "reply", callId: message.callId, ...response },
          "*",
        ),
      );
    return;
  }
  if (message.kind === "done" && jobId) {
    jobRealms.get(jobId)?.frame.remove();
    jobRealms.delete(jobId);
    const done = message as Record<string, unknown>;
    void chrome.runtime.sendMessage({
      target: "aeon-code-host",
      kind: "jobDone",
      jobId,
      value: done.value,
      output: done.output,
      ...(done.error ? { error: done.error } : {}),
      chatId,
    });
    return;
  }
  if (message.kind === "done") {
    const cell = cells.get(message.cellId);
    if (!cell || cell.chatId !== chatId) return;
    cells.delete(message.cellId);
    const done = message as Record<string, unknown>;
    cell.reply({ value: done.value, output: done.output, error: done.error });
  }
});

const flights = new FlightRing();

function addFlightFrame(tabId: number, chatId: string, at: number, data: string): void {
  flights.add(tabId, chatId, at, data);
}

function flightStatus(tabId: number): Record<string, unknown> {
  return flights.status(tabId);
}

function clearFlight(tabId: number): void {
  flights.clear(tabId);
}

async function encodeFlight(tabId: number): Promise<Record<string, unknown>> {
  const buffer = flights.get(tabId);
  if (!buffer?.frames.length) return { error: "No frames were recorded for this tab" };
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d", { willReadFrequently: false });
  if (!context) return { error: "Canvas is unavailable" };
  const first = await imageBitmap(buffer.frames[0]?.data ?? "");
  canvas.width = first.width;
  canvas.height = first.height;
  first.close();
  const stream = canvas.captureStream(2);
  const mime = MediaRecorder.isTypeSupported("video/webm;codecs=vp8")
    ? "video/webm;codecs=vp8"
    : "video/webm";
  const recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 800_000 });
  const chunks: BlobPart[] = [];
  recorder.ondataavailable = (event) => {
    if (event.data.size) chunks.push(event.data);
  };
  const stopped = new Promise<void>((done) => {
    recorder.onstop = () => done();
  });
  recorder.start();
  for (const frame of buffer.frames) {
    const bitmap = await imageBitmap(frame.data);
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    await new Promise((done) => setTimeout(done, 500));
  }
  recorder.stop();
  await stopped;
  const blob = new Blob(chunks, { type: mime });
  const bytes = new Uint8Array(await blob.arrayBuffer());
  return {
    data: base64(bytes),
    frames: buffer.frames.length,
    durationMs: (buffer.frames.at(-1)?.at ?? 0) - (buffer.frames[0]?.at ?? 0),
    startedAt: buffer.startedAt,
  };
}

async function imageBitmap(data: string): Promise<ImageBitmap> {
  const reply = await fetch(`data:image/jpeg;base64,${data}`);
  return createImageBitmap(await reply.blob());
}

function base64(bytes: Uint8Array): string {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 32_768)
    binary += String.fromCharCode(...bytes.subarray(index, index + 32_768));
  return btoa(binary);
}

chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (message?.target !== "aeon-code-offscreen" || sender.id !== chrome.runtime.id) return;
  if (message.kind === "flightFrame") {
    addFlightFrame(
      Number(message.tabId),
      String(message.chatId ?? ""),
      Number(message.at ?? Date.now()),
      String(message.data ?? ""),
    );
    reply(true);
    return;
  }
  if (message.kind === "flightSave") {
    void encodeFlight(Number(message.tabId)).then(
      (result) => reply(result),
      (error: unknown) => reply({ error: String(error) }),
    );
    return true;
  }
  if (message.kind === "flightStatus") {
    reply(flightStatus(Number(message.tabId)));
    return;
  }
  if (message.kind === "flightClear") {
    clearFlight(Number(message.tabId));
    reply(true);
    return;
  }
  if (message.kind === "reset") {
    drop(message.chatId);
    reply(true);
    return;
  }
  if (message.kind === "job") {
    const target = jobRealm(message.jobId, message.chatId);
    void target.ready.then(() =>
      target.frame.contentWindow?.postMessage(
        { kind: "cell", cellId: message.jobId, code: message.code },
        "*",
      ),
    );
    reply(true);
    return true;
  }
  if (message.kind === "stopJobs") {
    for (const [jobId, job] of jobRealms)
      if (job.chatId === message.chatId && (!message.jobId || message.jobId === jobId)) {
        job.frame.remove();
        jobRealms.delete(jobId);
      }
    reply(true);
    return;
  }
  if (message.kind !== "cell") return;
  const target = realm(message.chatId);
  cells.set(message.cellId, { chatId: message.chatId, reply });
  void target.ready.then(() =>
    target.frame.contentWindow?.postMessage(
      { kind: "cell", cellId: message.cellId, code: message.code, attached: message.attached },
      "*",
    ),
  );
  return true;
});
