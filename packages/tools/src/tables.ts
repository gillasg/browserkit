import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

// Tables: rows plus columns described in plain words ("latest funding round", "replied to my
// DM?"), kept on this machine so every chat, routine and watcher sees the same one. Agent code
// fills columns; a routine that refills a column turns it into a watcher. Rows are matched by
// the key column, so adding a row twice updates it.

export interface TableFile {
  name: string;
  key: string;
  columns: Record<string, string>;
  rows: Record<string, unknown>[];
  updatedAt: string;
}

type Row = Record<string, unknown>;
export type TableRequest = { table: string } & Record<string, unknown>;

const MAX_ROWS = 20_000;

export function isTableRequest(value: unknown): value is TableRequest {
  return typeof (value as { table?: unknown } | null)?.table === "string";
}

const tablesDirectory = (home: string) => join(home, "tables");

function slug(name: string): string {
  const value = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!value) throw new Error("INVALID_ARGUMENT: a table needs a name");
  return value.slice(0, 80);
}

async function load(home: string, name: string): Promise<TableFile | undefined> {
  try {
    return JSON.parse(
      await readFile(join(tablesDirectory(home), slug(name) + ".json"), "utf8"),
    ) as TableFile;
  } catch {
    return undefined;
  }
}

async function save(home: string, table: TableFile): Promise<void> {
  await mkdir(tablesDirectory(home), { recursive: true });
  table.updatedAt = new Date().toISOString();
  await writeFile(
    join(tablesDirectory(home), slug(table.name) + ".json"),
    JSON.stringify(table, null, 1),
  );
}

function summary(table: TableFile) {
  return {
    name: table.name,
    key: table.key,
    columns: table.columns,
    rows: table.rows.length,
    updatedAt: table.updatedAt,
  };
}

function columnsFrom(value: unknown): Record<string, string> {
  if (Array.isArray(value)) return Object.fromEntries(value.map((name) => [String(name), ""]));
  if (!value || typeof value !== "object") return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([name, what]) => [
      name,
      String(what ?? ""),
    ]),
  );
}

async function open(home: string, request: TableRequest) {
  const name = String(request.name ?? "");
  const columns = columnsFrom(request.columns);
  const existing = await load(home, name);
  const table: TableFile = existing ?? {
    name,
    key: String(request.key ?? Object.keys(columns)[0] ?? "name"),
    columns: {},
    rows: [],
    updatedAt: "",
  };
  for (const [column, what] of Object.entries(columns))
    if (!(column in table.columns) || what) table.columns[column] = what;
  if (!(table.key in table.columns)) table.columns[table.key] = "";
  await save(home, table);
  return summary(table);
}

function matches(row: Row, where: unknown): boolean {
  if (!where || typeof where !== "object") return true;
  return Object.entries(where as Row).every(([column, value]) => row[column] === value);
}

async function rows(home: string, request: TableRequest) {
  const table = await required(home, request);
  const offset = Math.max(0, Number(request.offset) || 0);
  const limit = Math.min(Math.max(1, Number(request.limit) || 1000), MAX_ROWS);
  return table.rows.filter((row) => matches(row, request.where)).slice(offset, offset + limit);
}

async function required(home: string, request: TableRequest): Promise<TableFile> {
  const table = await load(home, String(request.name ?? ""));
  if (!table)
    throw new Error(`NOT_FOUND: no table ${JSON.stringify(request.name)}; tables.open() makes it`);
  return table;
}

/** Changed columns of one row, with the time each was last set. */
function merge(row: Row, values: Row, now: string): string[] {
  const changed: string[] = [];
  const stamps = { ...((row._updated as Record<string, string> | undefined) ?? {}) };
  for (const [column, value] of Object.entries(values)) {
    if (column === "_updated" || value === undefined) continue;
    if (JSON.stringify(row[column]) !== JSON.stringify(value)) changed.push(column);
    row[column] = value;
    stamps[column] = now;
  }
  row._updated = stamps;
  return changed;
}

async function upsert(home: string, request: TableRequest) {
  const table = await required(home, request);
  const now = new Date().toISOString();
  const incoming = (Array.isArray(request.rows) ? request.rows : []) as Row[];
  const byKey = new Map(table.rows.map((row) => [String(row[table.key] ?? ""), row]));
  let added = 0;
  const changed: { key: string; columns: string[] }[] = [];
  for (const values of incoming) {
    const key = String(values[table.key] ?? "");
    if (!key) continue;
    const row = byKey.get(key);
    if (row) {
      const columns = merge(row, values, now);
      if (columns.length) changed.push({ key, columns });
    } else if (table.rows.length < MAX_ROWS) {
      const fresh: Row = {};
      merge(fresh, values, now);
      table.rows.push(fresh);
      byKey.set(key, fresh);
      added += 1;
    }
  }
  for (const column of Object.keys(Object.assign({}, ...incoming) as Row))
    if (!(column in table.columns)) table.columns[column] = "";
  await save(home, table);
  return { added, changed, rows: table.rows.length };
}

async function remove(home: string, request: TableRequest) {
  const table = await required(home, request);
  const keys = new Set((Array.isArray(request.keys) ? request.keys : []).map(String));
  const before = table.rows.length;
  table.rows = table.rows.filter((row) => !keys.has(String(row[table.key] ?? "")));
  await save(home, table);
  return { removed: before - table.rows.length };
}

export async function listTables(home: string) {
  const names = await readdir(tablesDirectory(home)).catch(() => [] as string[]);
  const tables = await Promise.all(
    names.filter((file) => file.endsWith(".json")).map((file) => load(home, file.slice(0, -5))),
  );
  return tables.filter((table): table is TableFile => Boolean(table)).map(summary);
}

export async function readTable(home: string, name: string): Promise<TableFile | undefined> {
  return load(home, name);
}

export async function handleTableRequest(request: TableRequest, home: string): Promise<unknown> {
  if (request.table === "list") return listTables(home);
  if (request.table === "open") return open(home, request);
  if (request.table === "rows") return rows(home, request);
  if (request.table === "upsert") return upsert(home, request);
  if (request.table === "remove") return remove(home, request);
  if (request.table === "drop") {
    await rm(join(tablesDirectory(home), slug(String(request.name ?? "")) + ".json"), {
      force: true,
    });
    return { dropped: true };
  }
  throw new Error("UNSUPPORTED: tables." + request.table);
}
