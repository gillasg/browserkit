// Declarative workflows: a named list of steps with typed inputs, templated arguments, loops,
// retries and recorded results. The engine is host-agnostic: a host supplies the action
// vocabulary (browser steps, site API calls, file writes) and the engine handles arguments,
// variables, repetition, conditions, delays and the run record. Nothing in here touches a
// browser or the network, so it can run in the bridge, in Aeon's daemon, or in a test.

export type WorkflowValue =
  string | number | boolean | null | WorkflowValue[] | { [key: string]: WorkflowValue };

export interface WorkflowInputSpec {
  description?: string;
  required?: boolean;
  default?: WorkflowValue;
  type?: "string" | "number" | "boolean" | "json";
}

/** A condition is either a template (truthiness) or a comparison on a path. */
export type WorkflowCondition =
  | string
  | {
      path: string;
      equals?: WorkflowValue;
      notEquals?: WorkflowValue;
      gt?: number;
      lt?: number;
      contains?: string;
      exists?: boolean;
      truthy?: boolean;
    };

export interface WorkflowRepeat {
  /** Run a fixed number of times. */
  times?: number;
  /** Run once per item: a template resolving to an array. */
  each?: string | WorkflowValue[];
  /** Stop when this becomes true (checked after each run). */
  until?: WorkflowCondition;
  /** Keep going while this stays true (checked before each run). */
  while?: WorkflowCondition;
  /** Safety cap for until/while loops. Defaults to 20. */
  max?: number;
  /** Pause between iterations. */
  delayMs?: number;
}

export interface WorkflowStep {
  /** Name this step's result: available later as {{steps.<id>}}. */
  id?: string;
  /** Action name supplied by the host. */
  do: string;
  /** Arguments for the action; strings are templated. */
  with?: { [key: string]: WorkflowValue };
  /** Skip the step unless this holds. */
  when?: WorkflowCondition;
  repeat?: number | WorkflowRepeat;
  /** What to do when the step still fails after retries. Defaults to "stop". */
  onError?: "stop" | "continue";
  retries?: number;
  retryDelayMs?: number;
  /** Pause before running the step. */
  delayMs?: number;
  /** Per-attempt deadline. */
  timeoutMs?: number;
  /** One line for humans and the run record. */
  note?: string;
}

export interface WorkflowDefinition {
  name: string;
  description?: string;
  /** Set when the workflow belongs to a site and is stored in that site's pack. */
  site?: string;
  version?: 1;
  inputs?: { [name: string]: WorkflowInputSpec };
  steps: WorkflowStep[];
  /** A template the run returns as its result. Defaults to the last step's result. */
  output?: string;
}

export interface WorkflowActionContext {
  step: WorkflowStep;
  /** Zero-based position inside a repeat, when the step repeats. */
  index?: number;
  item?: WorkflowValue;
  /** Everything resolved so far: inputs, steps, item, index. */
  scope: WorkflowScope;
  /** True when the caller asked for a plan and actions must not change anything. */
  dryRun: boolean;
  signal?: AbortSignal;
}

export type WorkflowAction = (
  args: { [key: string]: WorkflowValue },
  context: WorkflowActionContext,
) => Promise<unknown>;

export interface WorkflowActions {
  [name: string]: WorkflowAction;
}

export interface WorkflowScope {
  inputs: { [key: string]: WorkflowValue };
  steps: { [key: string]: unknown };
  item?: WorkflowValue;
  index?: number;
}

export interface WorkflowStepRecord {
  step: number;
  id: string;
  action: string;
  status: "completed" | "skipped" | "failed";
  startedAt: string;
  finishedAt: string;
  ms: number;
  attempts: number;
  result?: unknown;
  error?: string;
  note?: string;
}

export interface WorkflowRunRecord {
  id: string;
  workflow: string;
  status: "completed" | "failed";
  dryRun: boolean;
  startedAt: string;
  finishedAt: string;
  ms: number;
  inputs: { [key: string]: WorkflowValue };
  steps: WorkflowStepRecord[];
  output?: unknown;
  error?: string;
}

export interface WorkflowRunOptions {
  inputs?: { [key: string]: unknown };
  actions: WorkflowActions;
  /** Plan only: every action sees dryRun and must describe what it would do. */
  dryRun?: boolean;
  signal?: AbortSignal;
  /** Called as each step starts and finishes, for live progress in a host. */
  onEvent?: (event: WorkflowRunEvent) => void;
  /** Injected for deterministic tests. */
  now?: () => Date;
}

export type WorkflowRunEvent =
  | { type: "step.started"; step: number; id: string; action: string }
  | { type: "step.finished"; step: number; id: string; status: WorkflowStepRecord["status"] }
  | { type: "workflow.finished"; status: WorkflowRunRecord["status"] };

export class WorkflowError extends Error {
  constructor(
    message: string,
    readonly step?: number,
    readonly id?: string,
  ) {
    super(message);
    this.name = "WorkflowError";
  }
}

const TEMPLATE = /\{\{\s*([^{}]+?)\s*\}\}/g;
const MAX_LOOP = 200;

/** Resolves "{{path}}" against the scope. A lone template keeps the value's type. */
export function templateValue(value: WorkflowValue, scope: WorkflowScope): unknown {
  if (typeof value === "string") {
    const whole = value.match(/^\{\{\s*([^{}]+?)\s*\}\}$/);
    if (whole) return lookup(whole[1] ?? "", scope);
    return value.replace(TEMPLATE, (_, path: string) => stringify(lookup(path, scope)));
  }
  if (Array.isArray(value)) return value.map((item) => templateValue(item, scope));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, templateValue(item, scope)]),
    );
  return value;
}

export function templateArgs(
  args: { [key: string]: WorkflowValue } | undefined,
  scope: WorkflowScope,
): { [key: string]: WorkflowValue } {
  if (!args) return {};
  return templateValue(args, scope) as { [key: string]: WorkflowValue };
}

function lookup(path: string, scope: WorkflowScope): unknown {
  const parts = path.trim().split(".");
  const [head, ...rest] = parts;
  let current: unknown =
    head === "item"
      ? scope.item
      : head === "index"
        ? scope.index
        : (scope as unknown as Record<string, unknown>)[head ?? ""];
  for (const part of rest) {
    if (current == null) return undefined;
    const index = Number(part);
    current = Array.isArray(current)
      ? current[Number.isInteger(index) ? index : 0]
      : (current as Record<string, unknown>)[part];
  }
  return current;
}

function stringify(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function conditionHolds(
  condition: WorkflowCondition | undefined,
  scope: WorkflowScope,
): boolean {
  if (condition === undefined) return true;
  if (typeof condition === "string") return truthy(templateValue(condition, scope));
  const value = templateValue(`{{${condition.path}}}`, scope);
  if (condition.exists !== undefined)
    return (value !== undefined && value !== null) === condition.exists;
  if (condition.equals !== undefined) return equal(value, condition.equals);
  if (condition.notEquals !== undefined) return !equal(value, condition.notEquals);
  if (condition.contains !== undefined) return stringify(value).includes(condition.contains);
  if (condition.gt !== undefined) return Number(value) > condition.gt;
  if (condition.lt !== undefined) return Number(value) < condition.lt;
  return truthy(value);
}

function equal(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  try {
    return JSON.stringify(left) === JSON.stringify(right);
  } catch {
    return false;
  }
}

export function truthy(value: unknown): boolean {
  if (value == null || value === false || value === 0 || value === "") return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value as object).length > 0;
  return Boolean(value);
}

/** Applies declared input types and defaults; throws when a required input is missing. */
export function resolveInputs(
  definition: WorkflowDefinition,
  provided: { [key: string]: unknown } = {},
): { [key: string]: WorkflowValue } {
  const declared = definition.inputs ?? {};
  for (const name of Object.keys(provided))
    if (!(name in declared))
      throw new WorkflowError(`Unknown input "${name}". Declared: ${names(declared)}`);
  const resolved: { [key: string]: WorkflowValue } = {};
  for (const [name, spec] of Object.entries(declared)) {
    const given = provided[name];
    if (given === undefined) {
      if (spec.required && spec.default === undefined)
        throw new WorkflowError(`Missing required input "${name}"`);
      if (spec.default !== undefined) resolved[name] = spec.default;
      continue;
    }
    resolved[name] = coerce(name, given, spec.type);
  }
  return resolved;
}

function coerce(name: string, value: unknown, type: WorkflowInputSpec["type"]): WorkflowValue {
  if (type === "json") {
    if (typeof value !== "string") return value as WorkflowValue;
    try {
      return JSON.parse(value) as WorkflowValue;
    } catch {
      throw new WorkflowError(`Input "${name}" must be JSON`);
    }
  }
  if (type === "number") {
    const number = Number(value);
    if (!Number.isFinite(number)) throw new WorkflowError(`Input "${name}" must be a number`);
    return number;
  }
  if (type === "boolean") {
    if (value === true || value === "true" || value === "1") return true;
    if (value === false || value === "false" || value === "0") return false;
    throw new WorkflowError(`Input "${name}" must be true or false`);
  }
  if (typeof value === "object" && value !== null) return value as WorkflowValue;
  return String(value);
}

function names(record: object): string {
  const list = Object.keys(record);
  return list.length ? list.join(", ") : "none";
}

interface RunState {
  record: WorkflowRunRecord;
  scope: WorkflowScope;
  now: () => Date;
}

/** Runs a workflow and returns its record. Never throws: a failed run comes back with status. */
export async function runWorkflow(
  definition: WorkflowDefinition,
  options: WorkflowRunOptions,
): Promise<WorkflowRunRecord> {
  const now = options.now ?? (() => new Date());
  const startedAt = now();
  const state: RunState = {
    now,
    scope: { inputs: resolveInputs(definition, options.inputs ?? {}), steps: {} },
    record: {
      id: runId(startedAt),
      workflow: definition.name,
      status: "completed",
      dryRun: options.dryRun === true,
      startedAt: startedAt.toISOString(),
      finishedAt: startedAt.toISOString(),
      ms: 0,
      inputs: {},
      steps: [],
    },
  };
  state.record.inputs = state.scope.inputs;
  try {
    for (const [index, step] of definition.steps.entries())
      await runStep(state, step, index, options);
    state.record.output =
      definition.output === undefined
        ? lastResult(state.record.steps)
        : templateValue(definition.output, state.scope);
  } catch (error) {
    state.record.status = "failed";
    state.record.error = message(error);
  }
  const finishedAt = now();
  state.record.finishedAt = finishedAt.toISOString();
  state.record.ms = Math.max(0, finishedAt.getTime() - startedAt.getTime());
  options.onEvent?.({ type: "workflow.finished", status: state.record.status });
  return state.record;
}

async function runStep(
  state: RunState,
  step: WorkflowStep,
  index: number,
  options: WorkflowRunOptions,
): Promise<void> {
  const id = step.id ?? `step${index + 1}`;
  const started = state.now();
  if (!conditionHolds(step.when, state.scope)) {
    push(state, {
      step: index,
      id,
      action: step.do,
      status: "skipped",
      startedAt: started.toISOString(),
      finishedAt: started.toISOString(),
      ms: 0,
      attempts: 0,
      ...(step.note ? { note: step.note } : {}),
    });
    return;
  }
  if (step.delayMs) await pause(step.delayMs, options.signal);
  options.onEvent?.({ type: "step.started", step: index, id, action: step.do });
  const began = Date.now();
  let attempts = 0;
  try {
    const result = await runRepeats(state, step, options, () => {
      attempts += 1;
    });
    const finishedAt = state.now();
    state.scope.steps[id] = result;
    push(state, {
      step: index,
      id,
      action: step.do,
      status: "completed",
      startedAt: started.toISOString(),
      finishedAt: finishedAt.toISOString(),
      ms: Date.now() - began,
      attempts: Math.max(1, attempts),
      result: bounded(result),
      ...(step.note ? { note: step.note } : {}),
    });
    options.onEvent?.({ type: "step.finished", step: index, id, status: "completed" });
  } catch (error) {
    const finishedAt = state.now();
    push(state, {
      step: index,
      id,
      action: step.do,
      status: "failed",
      startedAt: started.toISOString(),
      finishedAt: finishedAt.toISOString(),
      ms: Date.now() - began,
      attempts: Math.max(1, attempts),
      error: message(error),
      ...(step.note ? { note: step.note } : {}),
    });
    options.onEvent?.({ type: "step.finished", step: index, id, status: "failed" });
    if (step.onError !== "continue") throw new WorkflowError(message(error), index, id);
  }
}

async function runRepeats(
  state: RunState,
  step: WorkflowStep,
  options: WorkflowRunOptions,
  onAttempt: () => void,
): Promise<unknown> {
  const repeat = step.repeat;
  if (repeat === undefined) return attempt(state, step, options, onAttempt);
  if (typeof repeat === "number") return repeatFixed(state, step, options, onAttempt, repeat);
  if (repeat.each !== undefined) return repeatEach(state, step, options, onAttempt, repeat);
  return repeatUntil(state, step, options, onAttempt, repeat);
}

async function repeatFixed(
  state: RunState,
  step: WorkflowStep,
  options: WorkflowRunOptions,
  onAttempt: () => void,
  times: number,
): Promise<unknown[]> {
  const results: unknown[] = [];
  for (let index = 0; index < Math.min(times, MAX_LOOP); index++) {
    results.push(await attempt(state, step, options, onAttempt, { index }));
  }
  return results;
}

async function repeatEach(
  state: RunState,
  step: WorkflowStep,
  options: WorkflowRunOptions,
  onAttempt: () => void,
  repeat: WorkflowRepeat,
): Promise<unknown[]> {
  const list = templateValue(repeat.each as WorkflowValue, state.scope);
  if (!Array.isArray(list))
    throw new WorkflowError(`Step "${step.id ?? step.do}" repeats over a value that is not a list`);
  const results: unknown[] = [];
  for (const [index, item] of list.slice(0, MAX_LOOP).entries()) {
    results.push(
      await attempt(state, step, options, onAttempt, { index, item: item as WorkflowValue }),
    );
    if (repeat.delayMs && index < list.length - 1) await pause(repeat.delayMs, options.signal);
  }
  return results;
}

async function repeatUntil(
  state: RunState,
  step: WorkflowStep,
  options: WorkflowRunOptions,
  onAttempt: () => void,
  repeat: WorkflowRepeat,
): Promise<unknown[]> {
  const results: unknown[] = [];
  const limit = Math.min(repeat.max ?? 20, MAX_LOOP);
  const id = step.id ?? step.do;
  const conditional = repeat.until !== undefined || repeat.while !== undefined;
  for (let index = 0; index < (conditional ? limit : 1); index++) {
    if (repeat.while && !conditionHolds(repeat.while, state.scope)) break;
    results.push(await attempt(state, step, options, onAttempt, { index }));
    state.scope.steps[id] = results.at(-1);
    if (repeat.until && conditionHolds(repeat.until, state.scope)) break;
    if (repeat.delayMs) await pause(repeat.delayMs, options.signal);
  }
  return results;
}

async function attempt(
  state: RunState,
  step: WorkflowStep,
  options: WorkflowRunOptions,
  onAttempt: () => void,
  extra: { index?: number; item?: WorkflowValue } = {},
): Promise<unknown> {
  const action = options.actions[step.do];
  if (!action)
    throw new WorkflowError(`No action "${step.do}". Available: ${names(options.actions)}`);
  const scope: WorkflowScope = { ...state.scope, ...extra };
  const args = templateArgs(step.with, scope) as { [key: string]: WorkflowValue };
  const tries = Math.max(0, step.retries ?? 0) + 1;
  let lastError: unknown;
  for (let tryIndex = 0; tryIndex < tries; tryIndex++) {
    onAttempt();
    try {
      return await withDeadline(
        action(args, {
          step,
          scope,
          dryRun: options.dryRun === true,
          ...(options.signal ? { signal: options.signal } : {}),
          ...(extra.index !== undefined ? { index: extra.index } : {}),
          ...(extra.item !== undefined ? { item: extra.item } : {}),
        }),
        step.timeoutMs,
      );
    } catch (error) {
      lastError = error;
      if (options.signal?.aborted) throw error;
      if (tryIndex < tries - 1) await pause(step.retryDelayMs ?? 250, options.signal);
    }
  }
  throw lastError;
}

function push(state: RunState, record: WorkflowStepRecord): void {
  state.record.steps.push(record);
}

function lastResult(steps: WorkflowStepRecord[]): unknown {
  for (let index = steps.length - 1; index >= 0; index -= 1) {
    const step = steps[index];
    if (step && step.status === "completed") return step.result;
  }
  return undefined;
}

/** Results keep their shape; anything huge is replaced by a short summary. */
function bounded(value: unknown): unknown {
  const text = safeJson(value);
  if (text.length <= 4000) return value;
  if (Array.isArray(value))
    return { count: value.length, first: value.slice(0, 3), truncated: true };
  return { truncated: true, preview: text.slice(0, 2000) };
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
}

function message(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

async function pause(ms: number, signal?: AbortSignal): Promise<void> {
  if (!(ms > 0)) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new WorkflowError("Workflow cancelled"));
      },
      { once: true },
    );
  });
}

async function withDeadline<T>(promise: Promise<T>, timeoutMs?: number): Promise<T> {
  if (!timeoutMs || timeoutMs <= 0) return promise;
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new WorkflowError(`Action timed out after ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function runId(at: Date): string {
  const stamp = at.toISOString().replace(/[:.]/g, "-");
  const suffix = Math.random().toString(36).slice(2, 6);
  return `run-${stamp}-${suffix}`;
}

/** Checks a definition before it is saved, so a broken workflow fails at import, not at run. */
export function validateWorkflow(value: unknown): WorkflowDefinition {
  if (!value || typeof value !== "object") throw new WorkflowError("A workflow must be an object");
  const definition = value as WorkflowDefinition;
  if (typeof definition.name !== "string" || !definition.name.trim())
    throw new WorkflowError("A workflow needs a name");
  if (!Array.isArray(definition.steps) || definition.steps.length === 0)
    throw new WorkflowError("A workflow needs at least one step");
  for (const [index, step] of definition.steps.entries()) {
    if (!step || typeof step.do !== "string" || !step.do.trim())
      throw new WorkflowError(`Step ${index + 1} needs "do"`);
    if (step.retries !== undefined && (!Number.isInteger(step.retries) || step.retries < 0))
      throw new WorkflowError(`Step ${index + 1} has a bad retries count`);
    if (step.timeoutMs !== undefined && (!Number.isFinite(step.timeoutMs) || step.timeoutMs <= 0))
      throw new WorkflowError(`Step ${index + 1} has a bad timeout`);
  }
  return definition;
}
