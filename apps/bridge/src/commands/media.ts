import { BridgeClient } from "../client.js";
import { flag, has, type Args } from "../args.js";
import { out } from "../output.js";
import type { Command } from "../usage.js";
import {
  analyseYoutubeWith,
  generateImageWith,
  type CodeRunner,
} from "@browserkit/tools/providers-run";

// Gemini media: an image to generate or edit, and a YouTube video to analyse. Both are the same
// page: the prompt is typed into Gemini, and the answer is either an image saved into the
// workspace or text. The browser API path is page.upload + page.saveMedia, documented in the help.

const SESSION = "browserkit-media";

async function inBrowser(code: string, timeoutMs = 240_000): Promise<unknown> {
  const bridge = await BridgeClient.connect();
  try {
    const reply = await bridge.request("run", { code, session: SESSION, timeoutMs });
    if (reply.error) throw new Error(String(reply.error));
    return reply.value;
  } finally {
    bridge.close();
  }
}

const run: CodeRunner = (code, options) => inBrowser(code, options?.timeoutMs ?? 240_000);

async function image(args: Args): Promise<number> {
  const prompt = args.positional.slice(1).join(" ");
  if (!prompt)
    throw new Error('Usage: browserkit media image "<prompt>" [--image file] [--out name.png]');
  const images = flag(args, "image")
    ? String(flag(args, "image"))
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean)
    : [];
  const timeout = flag(args, "timeout");
  const result = await generateImageWith(run, prompt, {
    images,
    ...(flag(args, "out") ? { out: String(flag(args, "out")) } : {}),
    ...(timeout ? { timeoutMs: Number(timeout) } : {}),
  });
  if (has(args, "json")) out(JSON.stringify(result));
  else out(`Saved ${result.saved}.`);
  return 0;
}

async function youtube(args: Args): Promise<number> {
  const url = args.positional[1];
  if (!url) throw new Error('Usage: browserkit media youtube <url> [--ask "question"] [--json]');
  const question = String(
    flag(args, "ask") ?? "Summarise the video with timestamps for the key points.",
  );
  const timeout = flag(args, "timeout");
  const result = await analyseYoutubeWith(run, url, question, {
    ...(timeout ? { timeoutMs: Number(timeout) } : {}),
  });
  if (has(args, "json")) out(JSON.stringify({ url, question, ...result }));
  else out(result.text);
  return 0;
}

async function media(args: Args): Promise<number> {
  const action = args.positional[0] ?? "image";
  if (action === "image") return image(args);
  if (action === "youtube") return youtube(args);
  throw new Error("Usage: browserkit media image|youtube ...");
}

export const mediaCommand: Command = {
  name: "media",
  group: "Browser",
  summary: "generate or edit an image, or analyse a YouTube video, with Gemini",
  help: `Usage: browserkit media image "<prompt>" [--image workspace.png|url] [--out name.png] [--json]
       browserkit media youtube <url> [--ask "question"] [--json]

Image: Gemini generates the picture, or edits the image you pass (a workspace file from
page.saveMedia, or an http(s) URL). The result is saved in the workspace. The primitive path is
page.openTab("https://gemini.google.com/app"), page.upload("input[type=file]", [file]), then
page.saveMedia("img", {name}).

YouTube: Gemini watches the video and answers the question. The primitive path is the same page
with the video URL in the prompt. AI Studio is not used.`,
  run: media,
};
