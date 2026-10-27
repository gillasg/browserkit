## Moving a site to another machine

```sh
browserkit pack export shop.example --out shop.zip
browserkit pack import shop.zip
browserkit pack enable shop.example
```

A pack holds the mapped site, its skills, boosts and site tools. Export strips sessions, cookies and
credentials; import saves skills, boosts and tools **disabled** until reviewed and enabled.
`site.tools.<name>(args)` and `site.pageTools.<name>(args)` call enabled tools in browser code.
