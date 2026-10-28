// Build on request: "make me an ability for X". An agent does the task once in a background tab
// while every request is recorded (a write runs in dry run, so nothing reaches the site), the API
// is rebuilt from the recording, and one model turn writes the ability from the recorded
// operations and the steps that worked. Saving runs the caller-contract checks and a read runs its
// own test cases; a failure goes back to the model, twice at most. When the site cannot do the
// task, the answer names why instead of saving something that half works.

import { saveAbility, testAbility, type Ability } from "./abilities.js";
import type { AbilityTestReport } from "./ability-contract.js";
import { modelSummary, performFlow, requireModel, type ModelLike } from "./agent.js";
import { failureKind } from "./explore.js";
import { siteName } from "./registry.js";
import type { Bridge } from "./runtime/bridge.js";
import { rebuild } from "./workflow.js";

export type BlockedReason =
  "site_lacks_capability" | "signed_out" | "bot_wall" | "needs_user" | "site_broken";

export interface BuildOptions {
  model?: ModelLike;
  bridge?: () => Promise<Bridge>;
  /** read (default) or write. A write is performed in dry run while it is learned. */
  kind?: "read" | "write";
  /** The ability's name; the model picks one when absent. */
  name?: string;
  /** Example inputs, such as {"q": "tea"}. */
  example?: Record<string, unknown>;
  maxSteps?: number;
  foreground?: boolean;
}

export interface BuildResult {
  site: string;
  saved?: string;
  kind?: "read" | "write";
  warnings?: string[];
  tests?: AbilityTestReport;
  blocked?: { reason: BlockedReason; why: string };
  summary?: string;
}

const ATTEMPTS = 3;

const WRITER_PROMPT = `You write one saved ability (a JSON object) for a website, from the API operations recorded while an agent did the task and from the browser steps that worked. Answer with JSON only, no prose, either:
{"name", "description", "kind": "read"|"write", "inputs": JSON Schema, "outputs": JSON Schema of the result, "ways": [...], "tests": [{"inputs", "expect"}], "options": {"checks": [...], "readBack": {...}}}
or, when the site cannot do the task: {"blocked": "site_lacks_capability"|"signed_out"|"bot_wall"|"needs_user"|"site_broken", "why": "..."}.
Ways run in order; put the API first and a page script second as a fallback:
- {"kind":"api","operation":"<operation id>","params":{"q":"{{inputs.q}}"}} or {"kind":"api","operations":[{"operation","params"}...],"commit":<index of the step that applies a write>}; a later step can use "{{last.field}}".
- {"kind":"script","runtime":"page","code":"async (page, bu, inputs) => { ...; return value; }"} built from the steps that worked, with inputs in place of the literal values.
Rules: every input must appear in some way (or its description starts "By design:"). Name inputs like the site's own identifiers and option values. A read gets at least two tests with different inputs; "expect" holds values the result must contain. Add options.checks [{"input","field","op": "eq"|"lt"|"lte"|"gt"|"gte"|"contains"}] for every filter input, so an ignored filter fails loudly. A write gets options.readBack {"ability": "<a read ability name>", "inputs", "expect"} when such a read exists. Never invent operation ids.`;

function taskBrief(task: string, kind: "read" | "write"): string {
  return kind === "write"
    ? `Do this task through the site's normal UI: ${task}\nThis tab is in dry run: requests that would change something are blocked and only recorded, so complete the whole task including its final submit button, with harmless values where the task gives none. Never enter payment card details or passwords. Close pop-ups and cookie banners.`
    : `Do this task through the site's normal UI: ${task}\nLook around only; do not buy, book, post, send, delete or change settings. Close pop-ups and cookie banners. Try it twice with different values if the task takes a search term, filter or option.`;
}

function parseJson(text: string): Record<string, unknown> {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("the answer held no JSON object");
  return JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
}

function replyText(reply: { content: unknown[] }): string {
  return reply.content
    .map((part) =>
      (part as { type?: string; text?: string }).type === "text"
        ? ((part as { text?: string }).text ?? "")
        : "",
    )
    .join("");
}

function blockedFrom(value: Record<string, unknown>): BuildResult["blocked"] | undefined {
  if (typeof value.blocked !== "string") return undefined;
  return { reason: value.blocked as BlockedReason, why: String(value.why ?? "") };
}

function abilityFrom(value: Record<string, unknown>, site: string, options: BuildOptions): Ability {
  const now = new Date().toISOString();
  return {
    ...(value as Partial<Ability>),
    name: options.name ?? String(value.name ?? ""),
    site,
    kind: options.kind ?? (value.kind === "write" ? "write" : "read"),
    inputs: (value.inputs as Ability["inputs"]) ?? {},
    ways: (value.ways as Ability["ways"]) ?? [],
    options: (value.options as Ability["options"]) ?? {},
    stats: { runs: 0, failures: 0 },
    createdBy: "agent",
    createdAt: now,
    updatedAt: now,
  } as Ability;
}

/** One write-save-test round; returns the result, or the error the model should fix. */
async function attempt(
  value: Record<string, unknown>,
  site: string,
  options: BuildOptions,
): Promise<{ done: BuildResult } | { retry: string }> {
  const blocked = blockedFrom(value);
  if (blocked) return { done: { site, blocked } };
  try {
    const saved = await saveAbility(abilityFrom(value, site, options), { breaking: true });
    const ability = saved.ability;
    if (ability.kind === "write")
      return { done: { site, saved: ability.name, kind: "write", warnings: saved.warnings } };
    const tests = await testAbility(site, ability.name);
    if (!tests.ok && tests.cases.length)
      return { retry: `Saved ${ability.name}, but its tests failed: ${JSON.stringify(tests)}` };
    return { done: { site, saved: ability.name, kind: "read", warnings: saved.warnings, tests } };
  } catch (error) {
    return { retry: error instanceof Error ? error.message : String(error) };
  }
}

async function writeAbility(
  model: ModelLike,
  site: string,
  context: string,
  options: BuildOptions,
): Promise<BuildResult> {
  const messages: Record<string, unknown>[] = [];
  messages.push({ role: "user", content: context, timestamp: Date.now() });
  let last = "";
  for (let round = 0; round < ATTEMPTS; round++) {
    const reply = await model.complete({
      systemPrompt: WRITER_PROMPT,
      messages: messages as never,
      tools: [],
    });
    messages.push(reply as Record<string, unknown>);
    let outcome: { done: BuildResult } | { retry: string };
    try {
      outcome = await attempt(parseJson(replyText(reply)), site, options);
    } catch (error) {
      outcome = { retry: error instanceof Error ? error.message : String(error) };
    }
    if ("done" in outcome) return outcome.done;
    last = outcome.retry;
    messages.push({
      role: "user",
      content: `Fix this and answer with the whole JSON again: ${last}`,
      timestamp: Date.now(),
    });
  }
  return {
    site,
    blocked: { reason: "site_broken", why: `no working ability after ${ATTEMPTS} tries: ${last}` },
  };
}

function blockedKind(message: string): BlockedReason {
  const kind = failureKind(message);
  if (kind === "challenged") return "bot_wall";
  if (kind === "signed-out") return "signed_out";
  return "site_broken";
}

function flowOptions(site: string, name: string, model: ModelLike, options: BuildOptions) {
  const startUrl = /^https?:\/\//i.test(site) ? site : undefined;
  return {
    model,
    maxSteps: options.maxSteps ?? 30,
    session: `site-to-api-build-${name}`,
    foreground: options.foreground === true,
    quiet: true,
    ...(startUrl ? { startUrl } : {}),
    ...(options.kind === "write" ? { dryRun: true } : {}),
    ...(options.bridge ? { bridge: options.bridge } : {}),
  };
}

/** Builds one ability for a task on a site; see the file comment. */
export async function buildAbility(
  site: string,
  task: string,
  options: BuildOptions = {},
): Promise<BuildResult> {
  const name = siteName(site);
  const model = requireModel(options.model);
  const kind = options.kind ?? "read";
  let flow;
  try {
    flow = await performFlow(name, taskBrief(task, kind), flowOptions(site, name, model, options));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { site: name, blocked: { reason: blockedKind(message), why: message } };
  }
  const built = await rebuild(name);
  const context = [
    `Site: ${name}`,
    `Task: ${task}`,
    `Kind: ${kind}${options.name ? `\nName: ${options.name}` : ""}`,
    options.example ? `Example inputs: ${JSON.stringify(options.example)}` : "",
    `What the agent reported: ${flow.summary}`,
    `Recorded operations:\n${modelSummary(built.model) || "(none: use a page script way)"}`,
    `Browser steps that worked, in order:\n${flow.steps.join("\n---\n").slice(0, 20_000)}`,
  ]
    .filter(Boolean)
    .join("\n\n");
  return { ...(await writeAbility(model, name, context, options)), summary: flow.summary };
}
