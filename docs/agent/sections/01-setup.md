## Before you start

1. **Run `browserkit --help` once** (or read the `browser_code` tool's own description). It lists
   every command and tool; this file is the overview.
2. **Don't put JSON on the command line.** Shells mangle its quotes (PowerShell strips them
   entirely). For simple inputs use `key=value` pairs: `browserkit call shop.example search q=lamp`
   (values that are valid JSON, like numbers or `'["a","b"]'`, are parsed as JSON). For code or
   anything nested, write the input to a file and pass `@file.json` (`repl @cell.js` for code, the
   safest form on Windows), or pipe it in with `-`.
3. **Pick one session name and reuse it** (`--session work`). Calls in the same session share
   variables, tabs and saved files; without one the MCP server uses `mcp` and the CLI uses `cli`.
