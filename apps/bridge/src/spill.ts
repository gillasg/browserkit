import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { dataDirectory } from "./paths.js";
import { sessionId } from "./bridge-server.js";

// A cell's value can be a large JSON document. Printing all of it floods an agent's context (and
// a shell window); the value is written to the session workspace and a head plus the path is
// printed instead. The file is a normal workspace artifact.

const SPILL_LIMIT = 100_000;
const HEAD = 20_000;

export async function spillText(text: string, session: string): Promise<string> {
  if (text.length <= SPILL_LIMIT) return text;
  const name = `results/${new Date().toISOString().replace(/[:.]/g, "-")}.txt`;
  const path = join(dataDirectory(), "workspaces", sessionId(session), name);
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, text, "utf8");
  return `${text.slice(0, HEAD)}\n[... ${text.length - HEAD} more characters saved to ${name}]`;
}
