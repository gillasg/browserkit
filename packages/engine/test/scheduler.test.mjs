import assert from "node:assert/strict";
import test from "node:test";
import { scheduleStep } from "../dist/native-browser-scheduler.js";

test("reads run in parallel and writes queue per tab", async () => {
  let active = 0;
  let peak = 0;
  const read = () =>
    scheduleStep({ op: "observe" }, 7, async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((done) => setTimeout(done, 10));
      active -= 1;
    });
  await Promise.all([read(), read(), read()]);
  assert.equal(peak, 3);
  active = 0;
  peak = 0;
  const write = () =>
    scheduleStep({ op: "click" }, 7, async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((done) => setTimeout(done, 10));
      active -= 1;
    });
  await Promise.all([write(), write(), write()]);
  assert.equal(peak, 1);
});
