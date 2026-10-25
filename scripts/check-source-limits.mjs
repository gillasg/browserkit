// Source files stay readable: no file over 800 lines (the same rule the boost, crawl and
// site-mapper packages enforce through ESLint). Engine and bridge sources had no lint config at
// all, so this checks them (and everything else) with no toolchain dependency.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const LIMIT = 800;
const roots = ["apps", "packages"];

function sources(directory) {
  const out = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist" || entry.name === "build") continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) out.push(...sources(path));
    else if (/\.(ts|tsx|mjs)$/.test(entry.name)) out.push(path);
  }
  return out;
}

const offenders = [];
for (const root of roots) {
  let entries = [];
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    continue;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const src = join(root, entry.name, "src");
    try {
      if (!statSync(src).isDirectory()) continue;
    } catch {
      continue;
    }
    for (const file of sources(src)) {
      const lines = readFileSync(file, "utf8").split("\n").length;
      if (lines > LIMIT) offenders.push(`${file}: ${lines} lines`);
    }
  }
}
if (offenders.length) {
  console.error(`Source files over ${LIMIT} lines:\n${offenders.join("\n")}`);
  process.exit(1);
}
console.log(`All source files are at most ${LIMIT} lines.`);
