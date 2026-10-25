import { readFile } from "node:fs/promises";
import { BridgeClient } from "../client.js";
import { flag, has, type Args } from "../args.js";
import { out } from "../output.js";
import type { Command } from "../usage.js";
import {
  PROVIDER_IDS,
  PROVIDERS,
  askDirect,
  cookieHeader,
  isProviderId,
  providerFor,
  transportSummary,
  uiScript,
  validateModel,
  type ProviderAnswer,
} from "@browserkit/tools/providers";

// Asking a chat provider: the direct request first (the user's cookies, no page), then the page
// itself. Cookies never leave this process except in the provider request; nothing prints them.

const SESSION = "browserkit-provider";

async function inBrowser(code: string, timeoutMs = 180_000): Promise<unknown> {
  const bridge = await BridgeClient.connect();
  try {
    const reply = await bridge.request("run", { code, session: SESSION, timeoutMs });
    if (reply.error) throw new Error(String(reply.error));
    return reply.value;
  } finally {
    bridge.close();
  }
}

async function providerCookies(host: string, domains: string[]): Promise<string> {
  const code = `(async () => {
  const domains = ${JSON.stringify(domains)};
  const all = [];
  for (const domain of domains) {
    const listed = await browser.cookies.list({ domain, values: true }).catch(() => ({ cookies: [] }));
    for (const cookie of listed.cookies || []) if (cookie.value !== undefined) all.push({ name: cookie.name, value: cookie.value });
  }
  return all;
})()`;
  return cookieHeader((await inBrowser(code, 60_000)) as { name: string; value: string }[]);
}

async function promptFrom(args: Args): Promise<string> {
  const given = flag(args, "prompt");
  if (given) return given;
  const words = args.positional.slice(1);
  if (!words.length)
    throw new Error('Usage: browserkit ask <provider> "<prompt>" [--model name] [--ui]');
  const joined = words.join(" ");
  if (joined.startsWith("@")) return readFile(joined.slice(1), "utf8");
  return joined;
}

async function uiAnswer(
  provider: ReturnType<typeof providerFor>,
  prompt: string,
  timeoutMs: number,
): Promise<string> {
  const code = `page = await browser.openTab(${JSON.stringify(provider.chatUrl)}, { newTab: true });
await page.waitForTimeout(1200);
${uiScript(provider.id, prompt, { timeoutMs })}`;
  const text = await inBrowser(code, Math.min(timeoutMs + 30_000, 330_000));
  return typeof text === "string" ? text : JSON.stringify(text);
}

export async function askProvider(
  providerId: string,
  prompt: string,
  options: { model?: string; timeoutMs?: number; transport?: "auto" | "direct" | "ui" } = {},
): Promise<ProviderAnswer> {
  const provider = providerFor(providerId);
  const model = validateModel(provider.id, options.model).model;
  const timeoutMs = Math.min(Math.max(options.timeoutMs ?? 120_000, 5000), 300_000);
  if (options.transport !== "ui") {
    const cookies = await providerCookies(provider.host, provider.cookieDomains);
    if (!cookies)
      return {
        ok: false,
        provider: provider.id,
        transport: "direct",
        text: "",
        model,
        reason: "signed-out",
        elapsedMs: 0,
      };
    const direct = await askDirect(provider.id, { prompt, model, cookies, timeoutMs });
    if (direct.ok || options.transport === "direct") return direct;
    if (options.transport === "auto") {
      const text = await uiAnswer(provider, prompt, timeoutMs);
      return {
        ok: true,
        provider: provider.id,
        transport: "ui",
        text,
        model,
        elapsedMs: direct.elapsedMs,
        ...(direct.reason ? { detail: direct.reason } : {}),
      };
    }
  }
  const started = Date.now();
  const text = await uiAnswer(provider, prompt, timeoutMs);
  return {
    ok: true,
    provider: provider.id,
    transport: "ui",
    text,
    model,
    elapsedMs: Date.now() - started,
  };
}

async function ask(args: Args): Promise<number> {
  const providerId = args.positional[0];
  if (!providerId) throw new Error(`Usage: browserkit ask <${PROVIDER_IDS.join("|")}> "<prompt>"`);
  if (!isProviderId(providerId))
    throw new Error(`PROVIDER_UNKNOWN: ${providerId} (${PROVIDER_IDS.join(", ")})`);
  const prompt = await promptFrom(args);
  const transport = has(args, "ui") ? "ui" : has(args, "direct") ? "direct" : "auto";
  const model = flag(args, "model");
  const timeout = flag(args, "timeout");
  const answer = await askProvider(providerId, prompt, {
    ...(model ? { model } : {}),
    ...(timeout ? { timeoutMs: Number(timeout) } : {}),
    transport,
  });
  if (has(args, "json")) {
    out(JSON.stringify(answer, null, 2));
    return answer.ok ? 0 : 1;
  }
  if (!answer.ok) {
    out(
      `${PROVIDERS[providerId].name} (${answer.transport}) failed: ${answer.reason ?? "unknown"}`,
    );
    if (answer.detail) out(answer.detail);
    out("Try --ui to use the provider's page, or sign in to the provider in Chrome.");
    return 1;
  }
  out(answer.text);
  out(
    `\n${PROVIDERS[providerId].name} · ${answer.transport} · ${answer.model} · ${answer.elapsedMs} ms`,
  );
  return 0;
}

async function providers(args: Args): Promise<number> {
  const rows = PROVIDER_IDS.map((id) => {
    const summary = transportSummary(id);
    const model = validateModel(id, flag(args, "model") ?? undefined);
    return { ...summary, direct: true, modelWarning: model.warning };
  });
  if (has(args, "json")) {
    out(JSON.stringify({ providers: rows }, null, 2));
    return 0;
  }
  for (const row of rows)
    out(`${row.provider}\t${row.host}\tdirect, page\t${row.models.join(", ")}`);
  return 0;
}

export const askCommand: Command = {
  name: "ask",
  group: "Browser",
  summary: "ask ChatGPT, Gemini, Perplexity, Grok or Kimi with the user's session",
  help: `Usage: browserkit ask <provider> "<prompt>" [--model name] [--ui|--direct] [--timeout ms] [--json]
       browserkit providers [--json]

Providers: chatgpt, gemini, perplexity, grok, kimi. The direct transport sends the request the
provider's own page sends, using the session already in Chrome; when that fails (the provider
changed its API, or a token is missing) the page is opened, the prompt is typed, and the answer
element is read. --direct never falls back; --ui always uses the page. Cookies and tokens stay in
this process: output carries the answer only.`,
  run: ask,
};

export const providersCommand: Command = {
  name: "providers",
  group: "Browser",
  summary: "list chat providers, their models and transports",
  help: `Usage: browserkit providers [--json]

Each provider has a direct transport (its own request with Chrome's cookies) and a page fallback.
A model that is not in the known list is still accepted, with a warning, because providers rename
models without notice.`,
  run: providers,
};
