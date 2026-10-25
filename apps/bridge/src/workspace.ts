import {
  appendFile,
  mkdir,
  readFile,
  readdir,
  writeFile,
  rename,
  realpath,
  stat,
  unlink,
} from "node:fs/promises";
import { resolve, relative, dirname, isAbsolute, extname, join } from "node:path";
import { randomUUID } from "node:crypto";
interface Request {
  workspace: string;
  name: string;
  value?: unknown;
  base64?: boolean;
}
export function isWorkspaceRequest(value: unknown): value is Request {
  return typeof value === "object" && value !== null && "workspace" in value;
}
export async function workspaceCall(root: string, request: Request): Promise<unknown> {
  if (request.workspace === "list") {
    const base = await realpath(root).catch(() => root);
    const folder = request.name ? await workspacePath(root, request.name) : base;
    const entries = await readdir(folder, { withFileTypes: true });
    return {
      name: request.name || ".",
      entries: entries
        .slice(0, 500)
        .map((entry) => ({ name: entry.name, dir: entry.isDirectory() }))
        .sort(
          (left, right) =>
            Number(right.dir) - Number(left.dir) || left.name.localeCompare(right.name),
        ),
    };
  }
  const path = await workspacePath(root, request.name);
  if (request.workspace === "read")
    return { name: request.name, text: await boundedRead(path, true) };
  if (request.workspace === "load") return JSON.parse(await boundedRead(path, true));
  if (request.workspace === "loadHelper") return boundedRead(path, true);
  if (request.workspace === "image") {
    const types: Record<string, string> = {
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".webp": "image/webp",
      ".gif": "image/gif",
    };
    const mimeType = types[extname(path).toLowerCase()];
    if (!mimeType) throw new Error("Unsupported image type");
    const bytes = await boundedRead(path);
    return { kind: "screenshot", screenshotId: randomUUID(), dataBase64: bytes, mimeType, path };
  }
  const data = request.workspace === "checkpoint" ? JSON.stringify(request.value) : request.value;
  if (typeof data !== "string" && !Array.isArray(data))
    throw new Error("Workspace output must be text or bytes");
  const bytes = Array.isArray(data)
    ? Buffer.from(data)
    : Buffer.from(data, request.base64 ? "base64" : "utf8");
  if (bytes.length > 16_000_000) throw new Error("Artifact exceeded 16 MB; split it into files");
  await mkdir(dirname(path), { recursive: true });
  // Revalidate after creating parents; do not write through a workspace symlink.
  await workspacePath(root, request.name);
  await writeWorkspaceFile(path, request.workspace, bytes);
  return { path, bytes: bytes.length, checkpoint: request.workspace === "checkpoint" };
}
async function writeWorkspaceFile(path: string, action: string, bytes: Buffer): Promise<void> {
  // Large artifacts arrive in pieces: the first creates the file, the rest append to it.
  if (action === "append") {
    if ((await stat(path)).size + bytes.length > 64_000_000)
      throw new Error("Artifact exceeded 64 MB; split it into files");
    await appendFile(path, bytes);
  } else if (action !== "checkpoint") {
    await writeFile(path, bytes, { flag: "wx" });
  } else {
    const temp = join(dirname(path), ".checkpoint-" + randomUUID());
    try {
      await writeFile(temp, bytes, { flag: "wx" });
      await rename(temp, path);
    } finally {
      await unlink(temp).catch(() => undefined);
    }
  }
}
async function boundedRead(path: string, text = false): Promise<string> {
  if ((await stat(path)).size > (text ? 16_000_000 : 4_000_000))
    throw new Error("File exceeds read limit");
  return (await readFile(path)).toString(text ? "utf8" : "base64");
}
async function workspacePath(root: string, name: string): Promise<string> {
  if (!name || isAbsolute(name)) throw new Error("Use a relative workspace filename");
  await mkdir(root, { recursive: true });
  const base = await realpath(root),
    path = resolve(base, name),
    rel = relative(base, path);
  if (!rel || rel.startsWith("..") || isAbsolute(rel))
    throw new Error("File is outside the workspace");
  let existing = path;
  while (true) {
    try {
      existing = await realpath(existing);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      existing = dirname(existing);
    }
  }
  const actual = relative(base, existing);
  if (actual.startsWith("..") || isAbsolute(actual))
    throw new Error("Workspace symlink escapes its root");
  return path;
}
export async function validateUploadFiles(files: string[], root: string): Promise<string[]> {
  return Promise.all(
    files.map(async (file) => {
      const path = await realpath(resolve(root, file));
      if (!(await stat(path)).isFile()) throw new Error("Upload source is not a regular file");
      return path;
    }),
  );
}
