import { join } from "node:path";
import {
  exportSitePack,
  setSiteToolsEnabled,
  installSitePack,
  readSitePack,
  skillsForSite,
  type PackBoost,
} from "@browserkit/site-mapper";
import { BridgeClient } from "../client.js";
import { cliHost } from "../host.js";
import { flag, has, type Args } from "../args.js";
import { dataDirectory } from "../paths.js";
import { printJson } from "../output.js";
import { enableSiteSkills, importSiteSkills, readSiteSkills } from "../site-skills.js";
import { readToolsCode } from "./site-tools.js";
import type { Command } from "../usage.js";

// Site packs: one zip a site can move in. Export includes the mapped site (model, spec, client,
// flows) and the site's browser skills and boosts, with sessions, cookies and credential-bearing
// values stripped. Import writes the site, then saves skills and boosts DISABLED and prints their
// code, because it runs in the user's browser; enabling is explicit (pack enable).

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

async function siteSkills(site: string) {
  const all = await readSiteSkills(join(dataDirectory(), "site-skills"));
  return skillsForSite(all, site);
}

async function siteBoosts(site: string): Promise<PackBoost[]> {
  const url = JSON.stringify(`https://${site}`);
  return (await runInBrowser(
    `(async () => { const listed = await browser.boosts.list(${url}); const full = []; for (const item of listed) { const boost = await browser.boosts.get(item.id); if (boost) full.push(boost); } return full; })()`,
  )) as PackBoost[];
}

async function exportPack(args: Args): Promise<number> {
  const site = args.positional[1];
  if (!site) throw new Error("Usage: browserkit pack export <site> --out <file.zip>");
  const out = (flag(args, "out") ?? `${site}.zip`) as string;
  let boosts: PackBoost[] = [];
  let boostWarning: string | undefined;
  if (!has(args, "no-boosts")) {
    try {
      boosts = await siteBoosts(site);
    } catch (error) {
      boostWarning = `Boosts left out: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
  const packed = await exportSitePack({
    site,
    out,
    skills: await siteSkills(site),
    boosts,
  });
  if (has(args, "json")) {
    printJson({ ...packed, ...(boostWarning ? { warning: boostWarning } : {}) });
    return 0;
  }
  process.stdout.write(
    `Exported ${packed.site} to ${packed.out}: ${packed.files.length} site files, ${packed.skills.length} skills, ${packed.boosts.length} boosts.\n` +
      "Sessions, cookies and credential-bearing headers and bodies are stripped.\n",
  );
  if (boostWarning) process.stderr.write(boostWarning + "\n");
  return 0;
}

async function importPack(args: Args): Promise<number> {
  const file = args.positional[1];
  if (!file) throw new Error("Usage: browserkit pack import <file.zip>");
  const pack = await readSitePack(file);
  const installed = await installSitePack(pack);
  const skills = await importSiteSkills(join(dataDirectory(), "site-skills"), pack.skills);
  const toolCode = await readToolsCode(installed.site);
  const boosts: { id?: string; name: string }[] = [];
  let boostWarning: string | undefined;
  if (pack.boosts.length) {
    try {
      const saved = (await runInBrowser(
        `(async () => { const saved = []; for (const boost of ${JSON.stringify(pack.boosts)}) { const result = await browser.boosts.save({ ...boost, enabled: false }); const id = result?.id ?? boost.id; if (id) await browser.boosts.enable(id, false); saved.push({ id, name: boost.name }); } return saved; })()`,
      )) as { id?: string; name: string }[];
      boosts.push(...saved);
    } catch (error) {
      boostWarning = `Boosts not saved (open the browser and import again, or save the files in the pack): ${error instanceof Error ? error.message : String(error)}`;
    }
  }
  if (has(args, "json")) {
    printJson({
      site: installed.site,
      files: installed.written,
      skills: skills.map((skill) => ({ name: skill.name, enabled: false, code: skill.code })),
      tools: toolCode.map((tool) => ({ ...tool, enabled: false })),
      boosts,
      ...(boostWarning ? { warning: boostWarning } : {}),
    });
    return 0;
  }
  process.stdout.write(
    `Imported ${installed.site}: ${installed.written.length} site files. Skills and boosts are DISABLED.\n`,
  );
  for (const skill of skills) {
    process.stdout.write(
      `\n--- skill ${skill.name} (${skill.domains.join(", ")}) ---\n${skill.code}\n`,
    );
  }
  for (const tool of toolCode)
    process.stdout.write(`\n--- ${tool.kind} ${tool.name} (DISABLED) ---\n${tool.code}\n`);
  for (const boost of pack.boosts) {
    const code = typeof boost.js === "string" ? boost.js : "";
    process.stdout.write(`\n--- boost ${boost.name}${code ? " (js)" : ""} ---\n`);
    if (code) process.stdout.write(code + "\n");
  }
  process.stdout.write(
    `\nReview the code above, then enable with: browserkit pack enable ${installed.site}\n`,
  );
  if (boostWarning) process.stderr.write(boostWarning + "\n");
  return 0;
}

async function enablePack(args: Args): Promise<number> {
  const site = args.positional[1];
  if (!site) throw new Error("Usage: browserkit pack enable <site>");
  const skills = await enableSiteSkills(join(dataDirectory(), "site-skills"), site);
  const tools = await setSiteToolsEnabled(site, "all", undefined, true);
  let boosts: { id?: string; name?: string }[] = [];
  let boostWarning: string | undefined;
  try {
    boosts = (await runInBrowser(
      `(async () => { const listed = await browser.boosts.list(${JSON.stringify(`https://${site}`)}); for (const boost of listed) await browser.boosts.enable(boost.id, true); return listed; })()`,
    )) as { id?: string; name?: string }[];
  } catch (error) {
    boostWarning = `Boosts not enabled: ${error instanceof Error ? error.message : String(error)}`;
  }
  if (has(args, "json"))
    printJson({ site, skills, tools, boosts, ...(boostWarning ? { warning: boostWarning } : {}) });
  else {
    process.stdout.write(
      `Enabled ${skills.length} skills, ${tools} tools and ${boosts.length} boosts for ${site}.\n`,
    );
    for (const name of skills) process.stdout.write(`  skill ${name}\n`);
    for (const boost of boosts) process.stdout.write(`  boost ${String(boost.name ?? boost.id)}\n`);
    if (boostWarning) process.stderr.write(boostWarning + "\n");
  }
  return 0;
}

async function pack(args: Args): Promise<number> {
  const action = args.positional[0] ?? "export";
  if (action === "export") return exportPack(args);
  if (action === "import") return importPack(args);
  if (action === "enable") return enablePack(args);
  throw new Error(
    "Usage: browserkit pack export <site> --out file.zip | import <file.zip> | enable <site>",
  );
}

export const packCommand: Command = {
  name: "pack",
  group: "Use sites",
  summary: "export or import a site with its flows, skills and boosts",
  help: `Usage: browserkit pack export <site> --out <file.zip> [--no-boosts] [--json]
       browserkit pack import <file.zip> [--json]
       browserkit pack enable <site> [--json]

A pack holds a mapped site's model, OpenAPI, client and recorded flows, plus the browser skills and
boosts written for it. Export strips sessions, cookies and credential-bearing request headers and
bodies. Import writes the site, then saves skills and boosts DISABLED and prints their code; enable
them with "pack enable" after reviewing it. Boosts need the browser running.`,
  run: pack,
};
