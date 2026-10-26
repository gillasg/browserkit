import { execFile } from "node:child_process";

// Runs a password manager's command-line tool. On Windows these tools are often .cmd shims,
// which only start through the shell, so every argument is checked against a plain character
// set first: nothing the shell could read as syntax ever reaches it.
const SAFE_ARG = /^[\w.:/@=+-]+$/;
const TIMEOUT_MS = 20_000;

export class ToolMissing extends Error {}

export function runTool(
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv = {},
): Promise<string> {
  const unsafe = args.find((arg) => !SAFE_ARG.test(arg));
  if (unsafe !== undefined) return Promise.reject(new Error("UNSAFE_ARGUMENT"));
  return new Promise((resolve, reject) => {
    execFile(
      command,
      [...args],
      {
        timeout: TIMEOUT_MS,
        maxBuffer: 32 * 1024 * 1024,
        windowsHide: true,
        shell: process.platform === "win32",
        env: { ...process.env, ...env },
      },
      (error, stdout, stderr) => {
        if (!error) return resolve(stdout);
        const code = (error as NodeJS.ErrnoException).code;
        const text = String(stderr || error.message);
        if (code === "ENOENT" || /not recognized|not found/i.test(text))
          return reject(new ToolMissing(command));
        reject(new Error(text.trim().split("\n")[0]?.slice(0, 300) || "failed"));
      },
    );
  });
}

/** For a native CLI that takes values with spaces: arguments go straight to execFile, no shell. */
export function runToolDirect(command: string, args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      [...args],
      { timeout: TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024, windowsHide: true },
      (error, stdout, stderr) => {
        if (!error) return resolve(stdout);
        const code = (error as NodeJS.ErrnoException).code;
        const text = String(stderr || error.message);
        if (code === "ENOENT" || /not recognized|not found/i.test(text))
          return reject(new ToolMissing(command));
        reject(new Error(text.trim().split("\n")[0]?.slice(0, 300) || "failed"));
      },
    );
  });
}

export function parseJson(text: string): unknown {
  const start = text.search(/[[{]/);
  return JSON.parse(start > 0 ? text.slice(start) : text) as unknown;
}
