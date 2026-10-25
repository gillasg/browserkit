import { BridgeClient } from "../client.js";
import { flag, has, type Args } from "../args.js";
import { out } from "../output.js";
import type { Command } from "../usage.js";
import { imagePrompt, imageScript, youtubePrompt } from "@browserkit/tools/providers";

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
  const outName = String(flag(args, "out") ?? "gemini-image.png");
  const timeoutMs = Math.min(Math.max(Number(flag(args, "timeout") ?? 180_000), 10_000), 300_000);
  const text = imagePrompt(prompt, { edit: images.length > 0, images });
  const code = `page = await browser.openTab("https://gemini.google.com/app", { newTab: true });
await page.waitForTimeout(1200);
${imageScript(text, { out: outName, images, timeoutMs })}`;
  const result = (await inBrowser(code, timeoutMs + 30_000)) as { saved?: string };
  if (!result?.saved) throw new Error("MEDIA_EMPTY: Gemini returned no image");
  if (has(args, "json")) out(JSON.stringify({ saved: result.saved, prompt: text }));
  else out(`Saved ${result.saved}.`);
  return 0;
}

async function youtube(args: Args): Promise<number> {
  const url = args.positional[1];
  if (!url) throw new Error('Usage: browserkit media youtube <url> [--ask "question"] [--json]');
  const question = String(
    flag(args, "ask") ?? "Summarise the video with timestamps for the key points.",
  );
  const prompt = youtubePrompt(url, question);
  const timeoutMs = Math.min(Math.max(Number(flag(args, "timeout") ?? 180_000), 10_000), 300_000);
  const code = `page = await browser.openTab("https://gemini.google.com/app", { newTab: true });
await page.waitForTimeout(1200);
const prompt = ${JSON.stringify(prompt)};
const composer = page.locator(".ql-editor[contenteditable='true']").first();
await composer.click();
await composer.fill(prompt);
await page.locator("button[aria-label*='Send']").first().click();
let last = "", stable = 0;
const deadline = Date.now() + ${timeoutMs};
while (Date.now() < deadline) {
  await page.waitForTimeout(1000);
  const text = (await page.locator("model-response message-content, .model-response-text").allTextContents()).join("\\n").trim();
  if (text && text === last) { if (++stable >= 3) break; } else { last = text; stable = 0; }
}
if (!last) throw new Error("PROVIDER_TIMEOUT: Gemini returned no analysis; the page may have changed");
last`;
  const text = await inBrowser(code, timeoutMs + 30_000);
  if (has(args, "json")) out(JSON.stringify({ url, question, text }));
  else out(String(text));
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
