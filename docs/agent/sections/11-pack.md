## Moving a site to another machine

```sh
browserkit pack export shop.example --out shop.zip
browserkit pack import shop.zip
browserkit pack enable shop.example
```

A pack holds the mapped site, its abilities, notes, skills and boosts. Export strips sessions,
cookies and credentials; import enables abilities, skills, tools and boosts.
`site.<name>(args)` runs an ability; `site.tools.<name>(args)` and `site.pageTools.<name>(args)`
remain for old pack tools in browser code.
