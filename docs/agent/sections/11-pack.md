## Moving a site to another machine

```sh
browserkit pack export shop.example --out shop.zip
browserkit pack import shop.zip
browserkit pack enable shop.example
```

A pack holds the mapped site (model, OpenAPI, typed client and recorded flows), the browser
skills and boosts written for it, and any saved site tools. Export strips sessions, cookies and
credential-bearing request headers and bodies. Import writes the site but saves skills, boosts
and tools **disabled** and prints their code; review it, then enable them. Without the browser
running, boosts are left out (export) or not saved (import); the site and skills still move.

Saved tools are callable helpers beside the model: `browserkit site tools list <site>` shows
them, `run <site> <name> --params '<json>'` runs a Node tool, and `enable|disable` manages their
code. Use `site.tools.<name>(args)` and `site.pageTools.<name>(args)` in browser code for the
current host.

Named secret profiles keep the sign-in headers and cookies of a site encrypted for the current
user: `browserkit secrets save <name> --site <host>`, `list`, `run <name> --script <file|->`
(with values in `BK_*` variables and output redacted), and `delete`.
