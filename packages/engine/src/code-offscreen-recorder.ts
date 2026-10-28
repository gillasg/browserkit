// The recorder behind page.recordVideo, in the offscreen document (MediaRecorder and tab capture
// need a document). A tab-capture recording encodes the tab's own stream, its sound included and
// still audible to the user; a screencast recording draws DevTools frames onto a canvas and
// encodes that. The finished video stays here until the service worker reads it in slices.

interface Recording {
  recorder?: MediaRecorder;
  stream?: MediaStream;
  chunks: Blob[];
  blob?: Blob;
  mimeType: string;
  fps: number;
  canvas?: HTMLCanvasElement;
  audio?: AudioContext;
}
const recordings = new Map<number, Recording>();

type Message = Record<string, unknown> & { kind: string; tabId: number };

export function recordingMessage(message: Message): Promise<unknown> | undefined {
  if (message.kind === "recordStart") return start(message);
  if (message.kind === "recordFrame") return frame(message.tabId, String(message.data ?? ""));
  if (message.kind === "recordStop") return stop(message.tabId);
  if (message.kind === "recordRead")
    return read(message.tabId, Number(message.offset), Number(message.size));
  if (message.kind === "recordDrop") return Promise.resolve(drop(message.tabId));
  return undefined;
}

function pickType(format: unknown, audio: boolean): string {
  const mp4 = audio
    ? ["video/mp4;codecs=avc1.42E01E,mp4a.40.2", "video/mp4;codecs=avc1,opus", "video/mp4"]
    : ["video/mp4;codecs=avc1.42E01E", "video/mp4"];
  const webm = audio
    ? ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"]
    : ["video/webm;codecs=vp9", "video/webm"];
  const order = format === "webm" ? [...webm, ...mp4] : [...mp4, ...webm];
  return order.find((type) => MediaRecorder.isTypeSupported(type)) ?? "";
}

async function start(message: Message): Promise<unknown> {
  drop(message.tabId);
  const fps = Number(message.fps) || 30;
  const audio = message.audio === true && message.canvas !== true;
  const recording: Recording = { chunks: [], mimeType: pickType(message.format, audio), fps };
  try {
    if (message.canvas === true) {
      // The size comes from the first frame; the recorder starts then.
      recording.canvas = document.createElement("canvas");
      recordings.set(message.tabId, recording);
      return { ok: true, mimeType: recording.mimeType };
    }
    const source = { chromeMediaSource: "tab", chromeMediaSourceId: String(message.streamId) };
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: audio ? { mandatory: source } : false,
      video: { mandatory: { ...source, maxFrameRate: fps, maxWidth: 1920, maxHeight: 1080 } },
    } as MediaStreamConstraints);
    if (audio) {
      // Capturing a tab's sound mutes it for the user; play it back so they still hear it.
      recording.audio = new AudioContext();
      recording.audio.createMediaStreamSource(stream).connect(recording.audio.destination);
    }
    recordings.set(message.tabId, recording);
    await begin(recording, stream);
    return { ok: true, mimeType: recording.recorder?.mimeType || recording.mimeType };
  } catch (error) {
    drop(message.tabId);
    return { ok: false, error: String(error instanceof Error ? error.message : error) };
  }
}

function begin(recording: Recording, stream: MediaStream): Promise<void> {
  recording.stream = stream;
  const recorder = new MediaRecorder(stream, {
    ...(recording.mimeType ? { mimeType: recording.mimeType } : {}),
    videoBitsPerSecond: 4_000_000,
    audioBitsPerSecond: 128_000,
  });
  recording.recorder = recorder;
  recorder.ondataavailable = (event) => {
    if (event.data.size) recording.chunks.push(event.data);
  };
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("MediaRecorder did not start")), 5000);
    recorder.onstart = () => {
      clearTimeout(timer);
      resolve();
    };
    recorder.start(1000);
  });
}

async function frame(tabId: number, data: string): Promise<unknown> {
  const recording = recordings.get(tabId);
  const canvas = recording?.canvas;
  if (!recording || !canvas || !data) return false;
  const bytes = Uint8Array.from(atob(data), (char) => char.charCodeAt(0));
  const image = await createImageBitmap(new Blob([bytes], { type: "image/jpeg" }));
  if (!recording.recorder) {
    canvas.width = image.width - (image.width % 2);
    canvas.height = image.height - (image.height % 2);
    await begin(recording, canvas.captureStream(recording.fps));
  }
  canvas.getContext("2d")?.drawImage(image, 0, 0, canvas.width, canvas.height);
  image.close();
  return true;
}

async function stop(tabId: number): Promise<unknown> {
  const recording = recordings.get(tabId);
  if (!recording) return { ok: false, error: "no recording" };
  const recorder = recording.recorder;
  if (!recorder) {
    drop(tabId);
    return {
      ok: false,
      error:
        "no frames: Chrome only paints visible windows; keep the tab's window open and unminimized",
    };
  }
  if (recorder.state !== "inactive")
    await new Promise<void>((resolve) => {
      recorder.onstop = () => resolve();
      recorder.stop();
    });
  for (const track of recording.stream?.getTracks() ?? []) track.stop();
  void recording.audio?.close().catch(() => undefined);
  const mimeType = recorder.mimeType || recording.mimeType || "video/webm";
  recording.blob = new Blob(recording.chunks, { type: mimeType });
  recording.chunks = [];
  return { ok: true, bytes: recording.blob.size, mimeType };
}

async function read(tabId: number, offset: number, size: number): Promise<unknown> {
  const blob = recordings.get(tabId)?.blob;
  if (!blob) return { base64: "", done: true };
  const slice = blob.slice(offset, offset + size);
  const base64 = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () =>
      resolve(String(reader.result).slice(String(reader.result).indexOf(",") + 1));
    reader.onerror = () => reject(reader.error ?? new Error("read failed"));
    reader.readAsDataURL(slice);
  });
  return { base64, done: offset + size >= blob.size };
}

function drop(tabId: number): boolean {
  const recording = recordings.get(tabId);
  if (!recording) return false;
  if (recording.recorder && recording.recorder.state !== "inactive") recording.recorder.stop();
  for (const track of recording.stream?.getTracks() ?? []) track.stop();
  void recording.audio?.close().catch(() => undefined);
  recordings.delete(tabId);
  return true;
}
