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

chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (message?.target !== "aeon-code-offscreen" || sender.id !== chrome.runtime.id) return;
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
