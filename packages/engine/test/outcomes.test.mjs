import assert from "node:assert/strict";
import test from "node:test";
import { judgeOutcome, registrableDomain, summarizeOutcomes } from "../dist/outcomes.js";

test("an unclicked gate is gated, not a shell", () => {
  assert.equal(
    judgeOutcome({ gate: "age", gateClicked: false, readiness: "ready" }).outcome,
    "gated",
  );
  assert.equal(judgeOutcome({ gate: "age", gateClicked: true, captured: 2 }).outcome, "ok");
});

test("challenge, HTTP errors and CAPTCHA are blocked", () => {
  assert.equal(judgeOutcome({ challenge: true }).outcome, "blocked");
  assert.equal(judgeOutcome({ httpStatus: 403 }).outcome, "blocked");
  assert.equal(judgeOutcome({ readiness: "challenge" }).outcome, "blocked");
});

test("a redirect off the registrable domain says where it went", () => {
  const judged = judgeOutcome({
    requestedUrl: "https://shop.example/watch",
    finalUrl: "https://www.youtube.com/",
  });
  assert.equal(judged.outcome, "redirected");
  assert.match(judged.reason, /youtube\.com/);
  assert.equal(registrableDomain("https://a.co.uk/x"), "a.co.uk");
  assert.equal(registrableDomain("https://sub.shop.example/x"), "shop.example");
});

test("parked hosts, shells and dead pages are told apart", () => {
  assert.equal(
    judgeOutcome({ requestedUrl: "https://a.com", finalUrl: "https://sedoparking.com/a.com" })
      .outcome,
    "parked",
  );
  assert.equal(judgeOutcome({ readiness: "ready" }).outcome, "shell");
  assert.equal(judgeOutcome({ readiness: "empty" }).outcome, "shell");
  assert.equal(judgeOutcome({ readiness: "not-found" }).outcome, "dead");
  assert.equal(judgeOutcome({}).outcome, "dead");
});

test("the guardrail names a run that found nothing", () => {
  const summary = summarizeOutcomes(["shell", "shell", "shell"]);
  assert.equal(summary.okRate, 0);
  assert.equal(summary.dominant, "shell");
  assert.match(summary.warning ?? "", /0 of 3/);
  assert.match(summary.warning ?? "", /check the method/);
});

test("a healthy run has no warning and counts outcomes", () => {
  const summary = summarizeOutcomes(["ok", "ok", "gated", "dead"]);
  assert.equal(summary.counts.ok, 2);
  assert.equal(summary.okRate, 0.5);
  assert.equal(summary.warning, undefined);
});
