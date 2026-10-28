// What an ability promises its callers, checked when it is saved: every declared input is used by
// some way (or says "By design:"), and a replacement never drops an input, changes an input's type
// or drops an output field callers rely on. Stored test cases catch the other dishonest ability,
// one whose output never changes whatever the input.

import type { Ability } from "./abilities.js";

export interface AbilityTest {
  inputs: Record<string, unknown>;
  /** Values the result must contain. */
  expect?: Record<string, unknown>;
}

export interface AbilityTestReport {
  ok: boolean;
  cases: { inputs: Record<string, unknown>; ok: boolean; error?: string; missing?: string[] }[];
  /** Two or more cases with different inputs returned the same result. */
  constant: boolean;
}

function properties(schema: unknown): Record<string, Record<string, unknown>> {
  const value = schema as { properties?: Record<string, Record<string, unknown>> } | undefined;
  if (value?.properties && typeof value.properties === "object") return value.properties;
  // Old abilities sometimes keep inputs as a flat name → spec map.
  if (schema && typeof schema === "object" && !("type" in schema))
    return schema as Record<string, Record<string, unknown>>;
  return {};
}

/** Input names some way references; undefined when a way's source is not visible here. */
function referencedText(ability: Ability): string | undefined {
  if (ability.ways.some((way) => way.kind === "steps" && !way.steps && !way.workflow))
    return undefined;
  return JSON.stringify([ability.ways, ability.options.recordMapping ?? {}]);
}

function referenced(text: string, name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(
    `\\{\\{\\s*(inputs\\.)?${escaped}\\b|(inputs|args)\\s*(\\.\\s*${escaped}\\b|\\[\\s*\\\\?["']${escaped})|"from":"${escaped}"`,
  ).test(text);
}

/** Code that hands `inputs` on whole or destructures it uses every input. */
const WHOLE = /\b(inputs|args)\b(?!\s*(\.|\[))|\{\{\s*inputs\s*\}\}/;

/** Declared inputs no way uses. An input described with "By design:" is exempt. */
export function unusedInputs(ability: Ability): string[] {
  const text = referencedText(ability);
  if (text === undefined) return [];
  const code = ability.ways
    .map((way) => (way.kind === "script" ? way.code : JSON.stringify(way)))
    .join("\n");
  if (WHOLE.test(code)) return [];
  return Object.entries(properties(ability.inputs))
    .filter(([, spec]) => !String(spec?.description ?? "").includes("By design:"))
    .filter(([name]) => !referenced(text, name))
    .map(([name]) => name);
}

/** Ways a replacement would break existing callers. */
export function contractBreaks(previous: Ability, next: Ability): string[] {
  const breaks: string[] = [];
  const before = properties(previous.inputs);
  const after = properties(next.inputs);
  for (const [name, spec] of Object.entries(before)) {
    if (!after[name]) breaks.push(`input ${name} removed`);
    else if (spec.type && after[name].type && spec.type !== after[name].type)
      breaks.push(`input ${name} changed from ${String(spec.type)} to ${String(after[name].type)}`);
  }
  const outputsBefore = properties(previous.outputs);
  const outputsAfter = properties(next.outputs);
  if (Object.keys(outputsBefore).length)
    for (const name of Object.keys(outputsBefore))
      if (!outputsAfter[name]) breaks.push(`output ${name} removed`);
  if (previous.kind === "read" && next.kind === "write") breaks.push("read became a write");
  return breaks;
}

/** Notes for the saver, not errors: things that make an ability less useful to callers. */
export function contractWarnings(ability: Ability): string[] {
  const warnings: string[] = [];
  if (!Object.keys(properties(ability.outputs)).length)
    warnings.push("no outputs declared: callers cannot rely on any field");
  if (ability.kind === "read" && !ability.tests?.length)
    warnings.push("no test cases: a broken or constant read goes unnoticed");
  if (ability.kind === "write" && !ability.options.readBack)
    warnings.push("no readBack: a write cannot confirm it changed the site");
  return warnings;
}

function contains(value: unknown, wanted: unknown): boolean {
  return JSON.stringify(value ?? "")
    .toLowerCase()
    .includes(String(wanted).toLowerCase());
}

/** Runs the stored cases; a read whose different inputs give one identical answer is constant. */
export async function testAbilityCases(
  ability: Ability,
  run: (inputs: Record<string, unknown>) => Promise<unknown>,
): Promise<AbilityTestReport> {
  const cases: AbilityTestReport["cases"] = [];
  const answers = new Map<string, string>();
  for (const test of ability.tests ?? []) {
    try {
      const value = await run(test.inputs);
      const missing = Object.entries(test.expect ?? {})
        .filter(([, wanted]) => !contains(value, wanted))
        .map(([field]) => field);
      answers.set(JSON.stringify(test.inputs), JSON.stringify(value));
      cases.push({
        inputs: test.inputs,
        ok: !missing.length,
        ...(missing.length ? { missing } : {}),
      });
    } catch (error) {
      cases.push({
        inputs: test.inputs,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  const constant =
    ability.kind === "read" && answers.size >= 2 && new Set(answers.values()).size === 1;
  return { ok: !constant && cases.every((item) => item.ok), cases, constant };
}
