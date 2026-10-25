import { spawn } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { BridgeClient } from "../client.js";
import { sessionId } from "../bridge-server.js";
import { dataDirectory } from "../paths.js";
import { flag, has, type Args } from "../args.js";
import { out } from "../output.js";
import type { Command } from "../usage.js";

// Recording: Chrome paints a tab into frames (frames.json plus JPEGs), and the machine turns those
// frames into a GIF or a video with ffmpeg. A performance trace comes straight from Chrome's
// tracing domain. When no encoder is installed the frames are still kept and the error says how
// to install one, instead of silently producing nothing.

const SESSION = "browserkit-record";
const WORKSPACE = join(dataDirectory(), "workspaces", sessionId(SESSION));

async function inBrowser(code: string): Promise<unknown> {
  const bridge = await BridgeClient.connect();
  try {
    const reply = await bridge.request("run", { code, session: SESSION, timeoutMs: 120_000 });
    if (reply.error) throw new Error(String(reply.error));
    return reply.value;
  } finally {
    bridge.close();
  }
}

interface RecordSummary {
  folder: string;
  frames: number;
  fps: number;
  warning?: string;
}

async function recordFrames(url: string, seconds: number, fps: number): Promise<RecordSummary> {
  const name = `record-${Date.now()}`;
  const code = `(async () => {
  const tab = await browser.openTab(${JSON.stringify(url)}, { window: { width: 1280, height: 800 } });
  await tab.settle({ quietMs: 400, timeoutMs: 15000 }).catch(() => undefined);
  const summary = await tab.recordTab({ fps: ${fps}, seconds: ${seconds}, name: ${JSON.stringify(name)} });
  console.log('RESULT ' + JSON.stringify(summary));
  return summary;
})()`;
  const value = (await inBrowser(code)) as RecordSummary;
  if (!value || !value.folder)
    throw new Error("RECORD_FAILED: Chrome returned no recording summary");
  return value;
}

/** ffmpeg from PATH or FFMPEG_PATH; undefined when it cannot be run. */
async function ffmpegPath(): Promise<string | undefined> {
  const candidate = process.env.FFMPEG_PATH ?? "ffmpeg";
  return new Promise((done) => {
    const child = spawn(candidate, ["-version"], { stdio: "ignore", shell: false });
    child.on("error", () => done(undefined));
    child.on("close", (code) => done(code === 0 ? candidate : undefined));
  });
}

function runEncoder(executable: string, args: string[]): Promise<void> {
  return new Promise((done, fail) => {
    const child = spawn(executable, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => (stderr += String(chunk)));
    child.on("error", (error) => fail(error));
    child.on("close", (code) =>
      code === 0
        ? done()
        : fail(new Error(`FFMPEG_FAILED: ${stderr.trim().slice(-600) || `exit ${code}`}`)),
    );
  });
}

async function encode(
  folder: string,
  kind: "gif" | "video",
  fps: number,
  outPath: string,
): Promise<{ out: string; bytes: number }> {
  const executable = await ffmpegPath();
  if (!executable)
    throw new Error(
      `ENCODER_MISSING: ${kind === "gif" ? "GIF" : "video"} encoding needs ffmpeg. ` +
        `Install it (Windows: winget install Gyan.FFmpeg; macOS: brew install ffmpeg; Linux: apt install ffmpeg) ` +
        `or set FFMPEG_PATH. The ${kind === "gif" ? "frames" : "frames"} are kept at ${folder}`,
    );
  const input = join(folder, "frame-%06d.jpg");
  const even = "scale=trunc(iw/2)*2:trunc(ih/2)*2";
  const args =
    kind === "gif"
      ? [
          "-y",
          "-framerate",
          String(fps),
          "-start_number",
          "1",
          "-i",
          input,
          "-vf",
          `${even}:flags=lanczos`,
          "-loop",
          "0",
          outPath,
        ]
      : [
          "-y",
          "-framerate",
          String(fps),
          "-start_number",
          "1",
          "-i",
          input,
          "-vf",
          even,
          "-c:v",
          "libx264",
          "-pix_fmt",
          "yuv420p",
          outPath,
        ];
  await runEncoder(executable, args);
  return { out: outPath, bytes: (await stat(outPath)).size };
}

async function gifOrVideo(args: Args, kind: "gif" | "video"): Promise<number> {
  const url = args.positional[1];
  if (!url)
    throw new Error(`Usage: browserkit record ${kind} <url> [--seconds 5] [--fps 10] [--out file]`);
  const seconds = Math.min(Math.max(Number(flag(args, "seconds") ?? 5), 1), 50);
  const fps = Math.min(Math.max(Number(flag(args, "fps") ?? (kind === "gif" ? 10 : 25)), 1), 60);
  const encoder = await ffmpegPath();
  if (!encoder)
    throw new Error(
      `ENCODER_MISSING: ${kind === "gif" ? "GIF" : "video"} encoding needs ffmpeg. ` +
        "Install it (Windows: winget install Gyan.FFmpeg; macOS: brew install ffmpeg; Linux: apt install ffmpeg) " +
        "or set FFMPEG_PATH. The recording was not started.",
    );
  const summary = await recordFrames(url, seconds, fps);
  const folder = join(WORKSPACE, summary.folder);
  if (summary.frames === 0)
    throw new Error(
      `RECORD_EMPTY: Chrome painted no frames. ${summary.warning ?? "Keep the recording window visible and unminimized."}`,
    );
  const outPath = resolve(
    flag(args, "out") ?? (kind === "gif" ? "recording.gif" : "recording.mp4"),
  );
  let encoded: { out: string; bytes: number };
  try {
    encoded = await encode(folder, kind, Math.round(summary.fps || fps), outPath);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (has(args, "soft-fail") && /ENCODER_MISSING/.test(message)) {
      out(`Frames saved at ${folder} (${summary.frames} frames); ${message}`);
      return 0;
    }
    throw error;
  }
  if (has(args, "json")) out(JSON.stringify({ ...summary, ...encoded }));
  else
    out(
      `Recorded ${summary.frames} frames at ${summary.fps} fps; wrote ${encoded.out} (${Math.round(encoded.bytes / 1024)} KB).`,
    );
  return 0;
}

async function trace(args: Args): Promise<number> {
  const url = args.positional[1];
  if (!url)
    throw new Error(
      "Usage: browserkit record trace <url> [--seconds 3] [--out trace.json] [--json]",
    );
  const seconds = Math.min(Math.max(Number(flag(args, "seconds") ?? 3), 1), 30);
  const name = String(flag(args, "out") ?? `traces/trace-${Date.now()}.json`);
  const code = `(async () => {
  const tab = await browser.openTab(${JSON.stringify(url)}, { quiet: true });
  await tab.settle({ quietMs: 400, timeoutMs: 15000 }).catch(() => undefined);
  const trace = await tab.trace({ seconds: ${seconds}, out: ${JSON.stringify(name)} });
  console.log('RESULT ' + JSON.stringify(trace));
  return trace;
})()`;
  const result = (await inBrowser(code)) as { saved: string; events: number };
  const path = join(WORKSPACE, result.saved);
  const size = (await stat(path)).size;
  const parsed = JSON.parse(await readFile(path, "utf8")) as { traceEvents?: unknown[] };
  if (has(args, "json")) out(JSON.stringify({ ...result, path, bytes: size }));
  else
    out(
      `Wrote ${result.saved} (${parsed.traceEvents?.length ?? 0} trace events, ${Math.round(size / 1024)} KB).`,
    );
  return 0;
}

async function record(args: Args): Promise<number> {
  const action = args.positional[0] ?? "gif";
  if (action === "gif") return gifOrVideo(args, "gif");
  if (action === "video") return gifOrVideo(args, "video");
  if (action === "trace") return trace(args);
  throw new Error(
    "Usage: browserkit record gif|video|trace <url> [--seconds n] [--fps n] [--out file]",
  );
}

export const recordCommand: Command = {
  name: "record",
  group: "Browser",
  summary: "record a GIF or video, or save a Chrome performance trace",
  help: `Usage: browserkit record gif <url> [--seconds 5] [--fps 10] [--out recording.gif] [--json]
       browserkit record video <url> [--seconds 5] [--fps 25] [--out recording.mp4] [--json]
       browserkit record trace <url> [--seconds 3] [--out traces/trace.json] [--json]

Chrome paints the tab into JPEG frames (frames.json plus the images) in the session workspace;
ffmpeg turns them into a GIF or an H.264 video. Without ffmpeg the frames are kept and the command
fails with install instructions (or pass --soft-fail to keep the frames and exit 0). A trace comes
from Chrome's tracing domain and is saved as a trace event JSON artifact.`,
  run: record,
};
