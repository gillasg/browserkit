## Mapped sites

Users say "actions" for abilities (the `actions` command).

```sh
browserkit sites                          # which sites are mapped
browserkit ops shop.example               # what it can do, with inputs and capabilities
browserkit call shop.example search '{"query":"lamp"}' --param page=2
browserkit watch shop.example listings '{}' --key id     # only new/changed items since the last watch
browserkit federate shop.example:search other.example:search --params '{"query":"lamp"}'
browserkit heal shop.example              # drift, breakage, sign-out, bot walls
browserkit actions build shop.example "find a product's price and stock"   # a tested ability
browserkit actions run shop.example order --inputs '{"item":"tea"}' --key order-tea-1
browserkit actions test shop.example search  # its stored cases; fails on constant output
```

- **Start with `site.capabilities()`** in browser code (or `browserkit capabilities <site>`): the
  site's abilities, mapped operations, notes and WebMCP tools in one answer. Run one with
  `site.run(name, inputs, {via, key, limit, cursor})` or `site.<name>(inputs)`.
- **Abilities keep their promises:** lists page with `limit`/`next_cursor`; a write with a `key`
  never applies twice; a failed write says `possible_commit` and how to `retry`; an ignored filter
  fails as `INPUT_NOT_APPLIED`. Details: `help('abilities')`.
- **Site APIs** (or `siteMapper` in browser code) only work on sites that are mapped. Check `sites`
  first. To map a site: `map`, `describe`, `learn`, or use it in `browser_code` so its requests are
  learned as you go.
- `call` reads. A write the page made successfully can be repeated with `siteMapper.write`; the
  same change on many items is `siteMapper.batch` in one call (paced, stops at the first error).
  Paying, ordering, sending, posting, deleting and account changes always stay in the page.
- `watch` is one check, not a monitor: it calls the operation and returns only the items new or
  changed since the last watch of the same call; nothing runs in between. For ongoing monitoring,
  schedule the command yourself.
