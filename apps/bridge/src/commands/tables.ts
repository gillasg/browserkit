import { browserkitHome } from "@browserkit/tools/host";
import { listTables, readTable } from "@browserkit/tools/tables";
import { has, type Args } from "../args.js";
import { out, printJson, printRows } from "../output.js";
import type { Command } from "../usage.js";

// The tables agents keep with tables.open() in browser code: list them, or show one.

async function tables(args: Args): Promise<number> {
  const home = browserkitHome();
  const name = args.positional[0];
  if (!name) {
    const list = await listTables(home);
    if (has(args, "json")) printJson(list);
    else if (!list.length) out("No tables yet.");
    else printRows(list.map((table) => [table.name, `${table.rows} rows`, table.updatedAt]));
    return 0;
  }
  const table = await readTable(home, name);
  if (!table) throw new Error(`No table ${name}.`);
  if (has(args, "json")) printJson(table);
  else {
    const columns = Object.keys(table.columns);
    printRows([columns, ...table.rows.map((row) => columns.map((column) => cell(row[column])))]);
  }
  return 0;
}

function cell(value: unknown): string {
  if (value === undefined || value === null) return "";
  return typeof value === "object" ? JSON.stringify(value) : String(value);
}

export const tablesCommand: Command = {
  name: "tables",
  group: "Use a site",
  summary: "the tables agents keep (rows with plain-word columns)",
  help: `Usage: browserkit tables [name] [--json]

Without a name, lists the tables; with one, prints its rows. Agents make and fill tables with
tables.open(name, {columns}) in browser code; a routine that refills a column keeps it current.`,
  run: tables,
};
