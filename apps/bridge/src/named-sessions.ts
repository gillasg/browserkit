// Named browser sessions: a name an agent can come back to, with the tabs it owns remembered
// across bridge restarts. A session is either one quiet tab or its own window, so two agents can
// work without moving each other's page.

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { dataDirectory } from "./paths.js";

export interface NamedSession {
  name: string;
  mode: "tab" | "window";
  url: string;
  createdAt: string;
  lastUsedAt: string;
}

const file = (): string => join(dataDirectory(), "named-sessions.json");

export async function readNamedSessions(): Promise<Record<string, NamedSession>> {
  try {
    const value = JSON.parse(await readFile(file(), "utf8")) as unknown;
    if (!value || typeof value !== "object") return {};
    return value as Record<string, NamedSession>;
  } catch {
    return {};
  }
}

async function writeNamedSessions(sessions: Record<string, NamedSession>): Promise<void> {
  await mkdir(dataDirectory(), { recursive: true });
  const path = file();
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(sessions, null, 2) + "\n", "utf8");
  await rename(temporary, path);
}

export async function readNamedSession(name: string): Promise<NamedSession | undefined> {
  return (await readNamedSessions())[name];
}

export async function saveNamedSession(session: NamedSession): Promise<NamedSession> {
  const sessions = await readNamedSessions();
  const previous = sessions[session.name];
  const saved: NamedSession = {
    ...session,
    createdAt: previous?.createdAt ?? session.createdAt,
    lastUsedAt: new Date().toISOString(),
  };
  sessions[session.name] = saved;
  await writeNamedSessions(sessions);
  return saved;
}

export async function touchNamedSession(name: string): Promise<void> {
  const session = await readNamedSession(name);
  if (!session) return;
  await saveNamedSession(session);
}

export async function removeNamedSession(name: string): Promise<boolean> {
  const sessions = await readNamedSessions();
  if (!sessions[name]) return false;
  delete sessions[name];
  await writeNamedSessions(sessions);
  return true;
}
