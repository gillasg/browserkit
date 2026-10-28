// Builds the npm package `browserkit` in dist-npm/: the CLI (bridge, MCP server, every command)
// bundled into one file with its workspace packages inlined, plus the skills. The extension is
// not in it: `browserkit setup` downloads it from the latest release. Run after `pnpm build`;
// publish with `npm publish dist-npm` (CI does it on a release when publishing is turned on).
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "dist-npm");
const require = createRequire(join(root, "apps", "extension", "package.json"));
const { build } = require("esbuild");

const bridge = JSON.parse(await readFile(join(root, "apps", "bridge", "package.json"), "utf8"));
await rm(out, { recursive: true, force: true });
await mkdir(join(out, "dist"), { recursive: true });
await build({
  entryPoints: [join(root, "apps", "bridge", "dist", "cli.js")],
  outfile: join(out, "dist", "cli.js"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  // ws's optional native speedups; it runs without them.
  external: ["bufferutil", "utf-8-validate"],
  banner: {
    js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
  },
  logLevel: "warning",
});
await cp(join(root, "skills"), join(out, "skills"), { recursive: true });
await cp(join(root, "LICENSE"), join(out, "LICENSE")).catch(() => undefined);
await cp(join(root, "README.md"), join(out, "README.md"));
await writeFile(
  join(out, "package.json"),
  JSON.stringify(
    {
      name: "browserkit",
      version: process.env.NPM_VERSION || bridge.version,
      description: bridge.description,
      type: "module",
      bin: { browserkit: "dist/cli.js" },
      files: ["dist", "skills"],
      engines: { node: ">=22" },
      repository: { type: "git", url: "git+https://github.com/gillasg/browserkit.git" },
      license: "MIT",
    },
    null,
    2,
  ) + "\n",
);
process.stdout.write(`Packed browserkit ${bridge.version} into ${out}\n`);
