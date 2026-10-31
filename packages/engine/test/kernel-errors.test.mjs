import assert from "node:assert/strict";
import test from "node:test";
import { KERNEL_ERRORS, describeKernelError } from "../dist/kernel-errors.js";
import { errorCode } from "../dist/native-browser-common.js";

test("every failure is a kernel code, never a bare one", () => {
  const cases = {
    "No tab with id: 123.": "TAB_DEAD",
    "Debugger is not attached to the tab with id: 5.": "DEBUGGER_DETACHED",
    "Detached while handling command.": "DEBUGGER_DETACHED",
    "Cannot access a chrome:// URL; debugger refused": "UNSUPPORTED",
    "Something nobody planned for": "CHROME_ERROR",
    STALE_REF: "STALE_REF",
    USER_TAB: "USER_TAB",
  };
  for (const [message, code] of Object.entries(cases))
    assert.equal(errorCode(new Error(message)), code, message);
  assert.ok(!("OPERATION_FAILED" in KERNEL_ERRORS));
});

test("every kernel error tells the model how to recover", () => {
  for (const [code, hint] of Object.entries(KERNEL_ERRORS)) {
    assert.ok(hint.length > 20, code);
    assert.match(describeKernelError(code, "detail"), new RegExp(`^${code}: detail\\nHint: `));
  }
});

test("a message that leads with its code keeps that code, whatever follows", () => {
  const message =
    'TARGET_BLOCKED: covered by dialog "Enter your origin" tab 4 while the agent tried click';
  assert.equal(errorCode(new Error(message)), "TARGET_BLOCKED");
  assert.equal(errorCode(new Error("SITE_BLOCKED: the user blocked x.com")), "SITE_BLOCKED");
});
