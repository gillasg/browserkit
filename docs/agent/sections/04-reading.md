## Reading pages

Start with `page.read({max})`: data, the main repeated list and Markdown in one answer, with
`partial: true` and notes when it saw less. It expands "Show more"/"Show replies" controls, waits
up to 5 s for the content to settle, and scrolls every panel that scrolls on its own (a transcript,
chat log, comment drawer): one that draws lines only on scroll comes back whole in `scrollers`. It
fits a 30 s budget (`timeMs`), so a huge page returns what it has. One call reads a whole article
(`max` up to 200000); never slice a page across several cells. `page.scrollers()` reads only the
panels, once you have opened one (a "Show transcript" button, say). Then, when a smaller piece is enough: `page.data()` first
(embedded JSON: every value, no HTML parsing), then `page.table(css)`, `page.list(rowCss?)` for every
row of a list (it scrolls lists that only draw what is on screen; check `complete`/`partial`),
`page.links(css)`, `page.markdown()` (it now includes repeated article/feed items), then locators.
The site's own API next; your own DOM or network code last. Never parse `__NEXT_DATA__` or
`innerText` by hand. Large scripts or responses: fetch once and keep the text in a top-level
variable, which persists between cells; never refetch them each cell.
