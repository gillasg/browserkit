// Runs one lane of tests. The fast lane (default) is every test that does not launch a browser;
// `--browser` runs only those that do. A test is a browser test when its name says e2e or it
// launches Chrome, so a new test lands in the right lane without a list to keep.
// Usage: node scripts/run-tests.mjs [--browser] <glob>...
import { globSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const browser = process.argv.includes("--browser");
const globs = process.argv.slice(2).filter((arg) => !arg.startsWith("--"));
const launchesBrowser = (file) =>
  /\.e2e\./.test(file) ||
  /browser-fixture-helper|CHROME_PATH|chrome-for-testing/.test(readFileSync(file, "utf8"));
const files = globs
  .flatMap((pattern) => globSync(pattern))
  .filter((file) => file.endsWith(".test.mjs") && launchesBrowser(file) === browser);

if (files.length === 0) {
  process.stdout.write(`no ${browser ? "browser" : "fast"} tests matched\n`);
  process.exit(0);
}
const timeout = browser ? 900_000 : 90_000;
const run = spawnSync(process.execPath, ["--test", `--test-timeout=${timeout}`, ...files], {
  stdio: "inherit",
});
process.exit(run.status ?? 1);
