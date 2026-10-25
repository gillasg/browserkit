import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  conditionHolds,
  resolveInputs,
  runWorkflow,
  templateArgs,
  validateWorkflow,
} from "../dist/workflow.js";
import {
  deleteWorkflow,
  exportWorkflow,
  importWorkflowFile,
  listRuns,
  listWorkflows,
  readRun,
  readWorkflow,
  saveWorkflow,
  writeRun,
} from "../dist/workflow-store.js";

test("inputs apply defaults, coerce types and reject the unknown", () => {
  const definition = {
    name: "demo",
    inputs: {
      url: { type: "string", required: true },
      limit: { type: "number", default: 5 },
      deep: { type: "boolean" },
      filter: { type: "json" },
    },
    steps: [{ do: "goto" }],
  };
  const resolved = resolveInputs(definition, {
    url: "https://example.com",
    deep: "true",
    filter: '{"a":1}',
  });
  assert.equal(resolved.limit, 5);
  assert.equal(resolved.deep, true);
  assert.deepEqual(resolved.filter, { a: 1 });
  assert.throws(() => resolveInputs(definition, {}), /Missing required input "url"/);
  assert.throws(() => resolveInputs(definition, { url: "x", nope: 1 }), /Unknown input "nope"/);
});

test("templates keep a whole value's type and resolve nested fields", () => {
  const args = templateArgs(
    {
      text: "{{steps.page.title}}",
      label: "page {{index}}",
      nested: { list: ["{{inputs.url}}", 3] },
    },
    {
      inputs: { url: "https://example.com" },
      steps: { page: { title: 42 } },
      index: 2,
    },
  );
  assert.equal(args.text, 42);
  assert.equal(args.label, "page 2");
  assert.deepEqual(args.nested, { list: ["https://example.com", 3] });
});

test("conditions compare values and read truthiness", () => {
  const base = { inputs: {}, steps: { list: { count: 3, items: [] } } };
  assert.equal(conditionHolds("{{steps.list.count}}", base), true);
  assert.equal(conditionHolds("{{steps.list.items}}", base), false);
  assert.equal(conditionHolds({ path: "steps.list.count", gt: 2 }, base), true);
  assert.equal(conditionHolds({ path: "steps.list.count", equals: 4 }, base), false);
  assert.equal(conditionHolds({ path: "steps.missing", exists: false }, base), true);
});

test("a workflow runs steps in order, skips on when, and returns the last result", async () => {
  const calls = [];
  const record = await runWorkflow(
    {
      name: "sequence",
      inputs: { url: {} },
      steps: [
        { id: "open", do: "goto", with: { url: "{{inputs.url}}" } },
        { id: "skipped", do: "goto", when: { path: "steps.open.fail", exists: true } },
        { id: "text", do: "read", with: { from: "{{steps.open.url}}" } },
      ],
    },
    {
      inputs: { url: "https://example.com" },
      actions: {
        goto: async (args) => {
          calls.push(args);
          return { url: args.url };
        },
        read: async (args) => ({ text: `read ${args.from}` }),
      },
    },
  );
  assert.equal(record.status, "completed");
  assert.equal(calls.length, 1);
  assert.equal(record.steps[1].status, "skipped");
  assert.deepEqual(record.output, { text: "read https://example.com" });
});

test("repeat times, each and until behave", async () => {
  const seen = [];
  const record = await runWorkflow(
    {
      name: "loops",
      inputs: { pages: { type: "json", default: ["a", "b"] } },
      steps: [
        { id: "three", do: "echo", repeat: 3 },
        {
          id: "each",
          do: "echo",
          repeat: { each: "{{inputs.pages}}" },
          with: { page: "{{item}}" },
        },
        {
          id: "until",
          do: "echo",
          repeat: { until: "{{steps.until.done}}", max: 5 },
        },
      ],
    },
    {
      actions: {
        echo: async (args, context) => {
          seen.push({ args, index: context.index, item: context.item });
          return context.step.id === "until" ? { done: (context.index ?? 0) >= 1 } : { ok: true };
        },
      },
    },
  );
  assert.equal(record.status, "completed");
  assert.equal(record.steps[0].result.length, 3);
  assert.equal(record.steps[1].result.length, 2);
  assert.equal(seen.filter((item) => item.item === "b").length, 1);
  assert.equal(record.steps[2].result.length, 2, "until stops once done");
});

test("retries, onError continue, and a failed run", async () => {
  let attempts = 0;
  const recovered = await runWorkflow(
    {
      name: "retry",
      steps: [
        {
          id: "flaky",
          do: "work",
          retries: 2,
          retryDelayMs: 1,
        },
        { id: "after", do: "ok" },
      ],
    },
    {
      actions: {
        work: async () => {
          attempts += 1;
          if (attempts < 3) throw new Error("not yet");
          return "done";
        },
        ok: async () => "fine",
      },
    },
  );
  assert.equal(recovered.status, "completed");
  assert.equal(attempts, 3);
  assert.equal(recovered.steps[0].attempts, 3);

  const continued = await runWorkflow(
    { name: "tolerant", steps: [{ id: "bad", do: "fail", onError: "continue" }, { do: "ok" }] },
    {
      actions: {
        fail: async () => {
          throw new Error("nope");
        },
        ok: async () => "fine",
      },
    },
  );
  assert.equal(continued.status, "completed");
  assert.equal(continued.steps[0].status, "failed");

  const stopped = await runWorkflow(
    { name: "strict", steps: [{ id: "bad", do: "fail" }, { do: "ok" }] },
    {
      actions: {
        fail: async () => {
          throw new Error("nope");
        },
        ok: async () => "fine",
      },
    },
  );
  assert.equal(stopped.status, "failed");
  assert.match(stopped.error, /nope/);
});

test("dry run tells every changing action and still runs reads", async () => {
  const seen = [];
  const record = await runWorkflow(
    {
      name: "plan",
      steps: [
        { id: "read", do: "read" },
        { id: "click", do: "click" },
      ],
    },
    {
      dryRun: true,
      actions: {
        read: async (_, context) => {
          seen.push([context.step.id, context.dryRun]);
          return { text: "ok" };
        },
        click: async (_, context) => {
          seen.push([context.step.id, context.dryRun]);
          return { clicked: false };
        },
      },
    },
  );
  assert.equal(record.dryRun, true);
  assert.deepEqual(seen, [
    ["read", true],
    ["click", true],
  ]);
});

test("validation catches a missing action name and bad retries", () => {
  assert.throws(() => validateWorkflow({ name: "x", steps: [] }), /at least one step/);
  assert.throws(() => validateWorkflow({ name: "x", steps: [{}] }), /needs "do"/);
  assert.throws(
    () => validateWorkflow({ name: "x", steps: [{ do: "a", retries: -1 }] }),
    /bad retries/,
  );
});

test("the store saves, lists, reads, exports, imports and deletes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "browserkit-workflows-"));
  try {
    const definition = validateWorkflow({
      name: "Example flow",
      description: "one step",
      inputs: { url: { required: true } },
      steps: [{ id: "open", do: "goto" }],
    });
    const saved = await saveWorkflow(dir, definition);
    assert.equal(saved.slug, "example-flow");
    const listed = await listWorkflows(dir);
    assert.equal(listed.length, 1);
    assert.equal(listed[0].name, "Example flow");
    assert.deepEqual(await readWorkflow(dir, "example flow"), definition);

    const out = join(dir, "export.json");
    await exportWorkflow(dir, "Example flow", out);
    assert.deepEqual(await importWorkflowFile(out), definition);

    const record = {
      id: "run-1",
      workflow: "Example flow",
      status: "completed",
      dryRun: false,
      startedAt: new Date(0).toISOString(),
      finishedAt: new Date(0).toISOString(),
      ms: 0,
      inputs: {},
      steps: [],
    };
    const written = await writeRun(dir, record);
    assert.match(written.path, /run-1\.json$/);
    assert.equal((await listRuns(dir, "Example flow")).length, 1);
    assert.equal((await readRun(dir, "Example flow", "run-1")).id, "run-1");

    assert.equal(await deleteWorkflow(dir, "Example flow"), true);
    assert.equal((await listWorkflows(dir)).length, 0);
    assert.equal((await listRuns(dir, "Example flow")).length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
