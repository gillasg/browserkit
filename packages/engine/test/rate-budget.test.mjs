import assert from "node:assert/strict";
import test from "node:test";
import { HostBudget } from "../dist/native-browser-rate.js";

test("a host budget spaces requests above its window instead of firing them", () => {
  let now = 0;
  const budget = new HostBudget(3, 1000, () => now);
  assert.equal(budget.take("a.example"), 0);
  assert.equal(budget.take("a.example"), 0);
  assert.equal(budget.take("a.example"), 0);
  const waited = budget.take("a.example");
  assert.ok(waited > 0, "the fourth request in the window waits");
  assert.equal(budget.take("b.example"), 0, "another host has its own budget");
  now += waited;
  assert.equal(budget.take("a.example"), 0, "the wait frees a slot");
});

test("a quiet host is not held by old requests", () => {
  let now = 0;
  const budget = new HostBudget(1, 1000, () => now);
  assert.equal(budget.take("slow.example"), 0);
  now = 5000;
  assert.equal(budget.take("slow.example"), 0);
  assert.equal(budget.recent("slow.example"), 1);
});
