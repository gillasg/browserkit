import assert from "node:assert/strict";
import test from "node:test";
import { classifyReadiness } from "../dist/readiness.js";

const base = {
  readyState: "complete",
  url: "https://shop.example/",
  title: "Shop",
  httpStatus: 200,
  textLength: 2400,
  textSample: "Browse products, deals and new arrivals.",
  heading: "Shop",
  links: 60,
  rows: 12,
  forms: 2,
  main: true,
};

test("a normal page is ready, with evidence", () => {
  const result = classifyReadiness(base);
  assert.equal(result.state, "ready");
  assert.ok(result.evidence.some((line) => line.includes("12 list rows")));
  assert.ok(result.evidence.some((line) => line.includes("document complete")));
  assert.equal(result.textLength, 2400);
});

test("a spinner or an unfinished document is loading", () => {
  assert.equal(classifyReadiness({ ...base, readyState: "interactive" }).state, "loading");
  assert.equal(classifyReadiness({ ...base, spinner: true }).state, "loading");
  assert.equal(classifyReadiness({ ...base, ariaBusy: true }).state, "loading");
});

test("a password field means a sign-in wall", () => {
  const result = classifyReadiness({
    ...base,
    textLength: 900,
    textSample: "Sign in to continue",
    heading: "Sign in",
    hasPassword: true,
  });
  assert.equal(result.state, "login");
  assert.ok(result.evidence.some((line) => line.includes("password")));
});

test("sign-in wording with a small page is also a wall", () => {
  const result = classifyReadiness({
    ...base,
    textLength: 600,
    textSample: "Welcome back. Log in to your account.",
    heading: "Log in",
    forms: 1,
    links: 8,
    rows: 0,
  });
  assert.equal(result.state, "login");
});

test("a link labelled sign in on a full page is not a wall", () => {
  assert.equal(classifyReadiness(base).state, "ready");
});

test("challenge wording beats everything else", () => {
  const result = classifyReadiness({
    ...base,
    heading: "Just a moment...",
    title: "Just a moment...",
    textSample: "Checking your browser before accessing the site.",
    rows: 0,
  });
  assert.equal(result.state, "challenge");
  assert.ok(result.evidence[0]?.includes("challenge wording"));
});

test("404 and not-found wording are not-found", () => {
  assert.equal(classifyReadiness({ ...base, httpStatus: 404 }).state, "not-found");
  assert.equal(
    classifyReadiness({ ...base, title: "Page not found", heading: "Page not found" }).state,
    "not-found",
  );
});

test("5xx and error wording are errors", () => {
  assert.equal(classifyReadiness({ ...base, httpStatus: 503 }).state, "error");
  assert.equal(
    classifyReadiness({ ...base, heading: "Something went wrong", textLength: 400 }).state,
    "error",
  );
});

test("an empty shell is empty, with why", () => {
  const wording = classifyReadiness({
    ...base,
    textLength: 300,
    textSample: "No results found for that search.",
    rows: 0,
    main: true,
  });
  assert.equal(wording.state, "empty");
  assert.ok(wording.evidence.some((line) => line.includes("empty wording")));

  const shell = classifyReadiness({
    ...base,
    textLength: 40,
    textSample: "",
    rows: 0,
    main: false,
  });
  assert.equal(shell.state, "empty");
  assert.ok(shell.evidence.some((line) => line.includes("characters of text")));
});
