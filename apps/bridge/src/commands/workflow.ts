import { resolve } from "node:path";
import {
  deleteWorkflow,
  exportWorkflow,
  importWorkflowFile,
  listRuns,
  listWorkflows,
  readWorkflow,
  saveWorkflow,
  writeRun,
} from "@browserkit/tools/workflow-store";
import {
  runWorkflow,
  validateWorkflow,
  type WorkflowDefinition,
  type WorkflowRunEvent,
  type WorkflowRunRecord,
} from "@browserkit/tools/workflow";
import { BridgeClient } from "../client.js";
import { cliHost } from "../host.js";
import { flag, has, jsonValue, type Args } from "../args.js";
import { dataDirectory } from "../paths.js";
import { printJson } from "../output.js";
import { workflowActions } from "./workflow-actions.js";
import type { Command } from "../usage.js";

// Workflows: a saved, declarative sequence an agent or a person can run again. Steps use a small
// browser vocabulary (goto, click, fill, read, extract, collect, api, ...) with templated
// arguments, so the same definition works from the bridge, an MCP client or Aeon. Runs are kept
// as JSON beside the definitions, and each run gets an id the UI can follow.

const SESSION = "browserkit-cli";

async function runInBrowser(code: string): Promise<unknown> {
  const host = cliHost();
  if (host) return host.runInBrowser(code, { session: SESSION });
  const bridge = await BridgeClient.connect();
  try {
    const reply = await bridge.request("run", { code, session: SESSION });
    if (reply.error) throw new Error(String(reply.error));
    return reply.value;
  } finally {
    bridge.close();
  }
}

function home(): string {
  return dataDirectory();
}

function inputsFrom(args: Args): Record<string, unknown> {
  const raw = flag(args, "inputs");
  if (!raw) return {};
  const parsed = jsonValue(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error(
      '--inputs takes a JSON object, e.g. --inputs \'{"url":"https://example.com"}\'',
    );
  return parsed as Record<string, unknown>;
}

async function list(args: Args): Promise<number> {
  const workflows = await listWorkflows(home());
  if (has(args, "json")) {
    printJson(workflows);
    return 0;
  }
  if (!workflows.length) {
    process.stdout.write("No workflows yet. Save one with: browserkit workflow save <file.json>\n");
    return 0;
  }
  for (const item of workflows)
    process.stdout.write(
      `${item.name.padEnd(28)} ${String(item.steps).padStart(2)} steps` +
        `${item.inputs.length ? `  inputs: ${item.inputs.join(", ")}` : ""}` +
        `${item.description ? `  ${item.description}` : ""}\n`,
    );
  return 0;
}

async function show(args: Args): Promise<number> {
  const name = args.positional[1];
  if (!name) throw new Error("Usage: browserkit workflow show <name>");
  const definition = await readWorkflow(home(), name);
  if (!definition) throw new Error(`No workflow ${JSON.stringify(name)}`);
  if (has(args, "json")) {
    printJson(definition);
    return 0;
  }
  process.stdout.write(
    `${definition.name}${definition.description ? ` — ${definition.description}` : ""}\n`,
  );
  const inputs = Object.entries(definition.inputs ?? {});
  if (inputs.length)
    process.stdout.write(
      `inputs: ${inputs.map(([key, spec]) => `${key}${spec.required ? "*" : ""}`).join(", ")}\n`,
    );
  for (const [index, step] of definition.steps.entries())
    process.stdout.write(
      `  ${String(index + 1).padStart(2)}. ${step.do}${step.id ? ` -> ${step.id}` : ""}` +
        `${step.repeat ? " (repeats)" : ""}${step.note ? `  ${step.note}` : ""}\n`,
    );
  return 0;
}

async function save(args: Args): Promise<number> {
  const file = args.positional[1];
  if (!file) throw new Error("Usage: browserkit workflow save <file.json>");
  const definition = await importWorkflowFile(resolve(file));
  const written = await saveWorkflow(home(), definition);
  if (has(args, "json")) printJson({ ...written, name: definition.name });
  else
    process.stdout.write(`Saved workflow ${definition.name} (${definition.steps.length} steps).\n`);
  return 0;
}

async function remove(args: Args): Promise<number> {
  const name = args.positional[1];
  if (!name) throw new Error("Usage: browserkit workflow delete <name>");
  const removed = await deleteWorkflow(home(), name);
  if (!removed) throw new Error(`No workflow ${JSON.stringify(name)}`);
  process.stdout.write(`Deleted workflow ${name} and its runs.\n`);
  return 0;
}

async function importOne(args: Args): Promise<number> {
  return save(args);
}

async function exportOne(args: Args): Promise<number> {
  const name = args.positional[1];
  if (!name) throw new Error("Usage: browserkit workflow export <name> --out <file.json>");
  const out = flag(args, "out") ?? `${name}.json`;
  const written = await exportWorkflow(home(), name, resolve(out));
  if (has(args, "json")) printJson(written);
  else process.stdout.write(`Exported ${written.name} to ${written.out}.\n`);
  return 0;
}

async function runs(args: Args): Promise<number> {
  const name = args.positional[1];
  if (!name) throw new Error("Usage: browserkit workflow runs <name> [--json]");
  const list = await listRuns(home(), name);
  if (has(args, "json")) {
    printJson(list);
    return 0;
  }
  if (!list.length) {
    process.stdout.write(`No runs for ${name} yet.\n`);
    return 0;
  }
  for (const run of list)
    process.stdout.write(
      `${run.id}  ${run.status.padEnd(9)} ${String(run.ms).padStart(6)}ms  ${run.startedAt}` +
        `${run.dryRun ? "  (dry run)" : ""}${run.error ? `  ${run.error}` : ""}\n`,
    );
  return 0;
}

async function runOne(args: Args): Promise<number> {
  const name = args.positional[1];
  if (!name) throw new Error("Usage: browserkit workflow run <name> [--inputs <json>] [--dry-run]");
  const definition = await readWorkflow(home(), name);
  if (!definition) throw new Error(`No workflow ${JSON.stringify(name)}`);
  const record = await execute(
    definition,
    inputsFrom(args),
    has(args, "dry-run"),
    !has(args, "quiet"),
  );
  const written = await writeRun(home(), record);
  if (has(args, "json")) {
    printJson({ ...record, runFile: written.path });
    return record.status === "completed" ? 0 : 1;
  }
  process.stdout.write(
    `${record.status === "completed" ? "Completed" : "Failed"} ${record.workflow} in ${record.ms}ms (${record.id})\n`,
  );
  if (record.error) process.stdout.write(`  ${record.error}\n`);
  process.stdout.write(`  run saved: ${written.path}\n`);
  return record.status === "completed" ? 0 : 1;
}

async function execute(
  definition: WorkflowDefinition,
  inputs: Record<string, unknown>,
  dryRun: boolean,
  verbose: boolean,
): Promise<WorkflowRunRecord> {
  const actions = workflowActions(runInBrowser);
  return runWorkflow(definition, {
    inputs,
    actions,
    dryRun,
    ...(verbose
      ? {
          onEvent: (event: WorkflowRunEvent) => {
            if (event.type === "step.started")
              process.stderr.write(`  [${event.step + 1}] ${event.id}: ${event.action}\n`);
          },
        }
      : {}),
  });
}

async function check(args: Args): Promise<number> {
  const file = args.positional[1];
  if (!file) throw new Error("Usage: browserkit workflow check <file.json>");
  const definition = validateWorkflow(JSON.parse(await readText(file)));
  const known = workflowActions(runInBrowser);
  const unknown = definition.steps.map((step) => step.do).filter((name) => !(name in known));
  if (unknown.length) throw new Error(`Unknown actions: ${[...new Set(unknown)].join(", ")}`);
  process.stdout.write(`OK: ${definition.name}, ${definition.steps.length} steps.\n`);
  return 0;
}

async function readText(path: string): Promise<string> {
  const { readFile } = await import("node:fs/promises");
  return readFile(path, "utf8");
}

async function workflow(args: Args): Promise<number> {
  const action = args.positional[0] ?? "list";
  if (action === "list") return list(args);
  if (action === "show") return show(args);
  if (action === "save") return save(args);
  if (action === "delete" || action === "rm") return remove(args);
  if (action === "import") return importOne(args);
  if (action === "export") return exportOne(args);
  if (action === "runs") return runs(args);
  if (action === "run") return runOne(args);
  if (action === "check") return check(args);
  throw new Error(
    "Usage: browserkit workflow list | show <name> | save <file> | run <name> | runs <name> | check <file> | export <name> | import <file> | delete <name>",
  );
}

export const workflowCommand: Command = {
  name: "workflow",
  group: "Automate",
  summary: "save, inspect and run a declarative browser workflow",
  help: `Usage: browserkit workflow list [--json]
       browserkit workflow show <name> [--json]
       browserkit workflow check <file.json>
       browserkit workflow save <file.json>
       browserkit workflow run <name> [--inputs <json>] [--dry-run] [--quiet] [--json]
       browserkit workflow runs <name> [--json]
       browserkit workflow export <name> --out <file.json>
       browserkit workflow import <file.json>
       browserkit workflow delete <name>

A workflow is a saved sequence of steps with declared inputs, templated arguments
({{inputs.x}}, {{steps.<id>.field}}), repeats (times, each, until, while), retries and
per-step error handling. Actions: goto, wait, read, extract, collect, click, fill, press,
api, assert, save, sleep. Locator steps take {role, name}, {text}, {label}, {placeholder}
or {css}. --dry-run runs reads but only describes actions that change the page. Each run is
saved under the browserkit data folder and can be listed with "workflow runs".`,
  run: workflow,
};
