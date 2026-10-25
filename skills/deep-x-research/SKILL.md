---
name: deep-x-research
description: Sourced research on X/Twitter through Grok and the user's own X session - asks, budgets queries, verifies every cited post URL, and falls back to X search when Grok is unavailable. Use it for "what is X saying about", people or accounts on X, a thread or reaction, or any question whose answer must cite posts.
---

# Deep X research

Answers a question from X posts, with links a reader can open. Grok does the searching; the
browser checks that each link exists and says what it claims. Grok is a lead, not a source.

Requirements: `browserkit` is set up, Chrome is signed in to grok.com and x.com (x.com only for
the fallback and for checking links). Every command takes `--json`.

## 1. Frame the question (one call)

Write down, for yourself:

- the **entity**: person, product, event, ticker, handle;
- the **window**: a date range, "this week", "since the launch";
- the **claim type**: what happened, what people think, numbers, who said it first;
- the **accounts** that matter, if any (`from:handle`).

If the user gave no window, use the last 30 days and say so.

## 2. Ask Grok (budget: 3 broad queries, 5 follow-ups)

```bash
browserkit ask grok "Search X for posts about <entity> between <dates>. Return up to 10 posts, each with the author handle, the post URL, the date, and one sentence of what it says. Quote numbers exactly. Mark anything you could not verify." --json
```

Rules:

- **Broad first, then drill.** Broad queries: entity + window. Follow-ups only for a specific
  account, a number, or a contradiction found in the first answer.
- **Never repeat a query with punctuation changed.** If a query returns nothing, change the
  entity or the window, not the wording.
- **One provider at a time.** If Grok fails, read the reason: `signed-out` means sign in at
  grok.com; `rate-limited` means stop and fall back; `parse` means the page changed, so use
  `--ui`.
- Keep the raw answers in files (`--json > grok-1.json`) so quotes can be checked later.

## 3. Verify every URL (no exceptions)

For each cited post:

```bash
browserkit scrape "<post url>" --json
```

Check:

- the page loads and is a post, not a search or a deleted-post page;
- the author handle and date match the claim;
- the quoted words appear on the page;
- the engagement numbers are the ones cited (they move: say "at the time of writing").

Drop a link that fails any check. Do not present an unverified link as a source. If X shows a
sign-in wall, run `browserkit check <url>` to see whether the session is the problem.

## 4. Fallback: X search in the browser

When Grok is signed out or rate-limited, search X directly:

```bash
browserkit repl "page = await browser.openTab('https://x.com/search?q=<query>&f=live'); await page.waitForTimeout(1500); const rows = await page.list('article'); rows.slice(0, 15)"
```

Then open the promising posts with `scrape`. Add `&f=live` for recency, `from:handle` for an
account, and `since:YYYY-MM-DD until:YYYY-MM-DD` for a window. The result is the same shape:
claim, author, date, URL, verified.

## 5. Write the answer

- Lead with the answer in one paragraph.
- Then a table or list: claim, who, when, link, verified.
- Separate **what the posts say** from **what you infer**.
- Say how many queries you used and which accounts dominated.
- If the evidence is thin, say so; do not pad with search-engine summaries.

## Composition

This skill is the primitive path: `browserkit ask grok`, `browserkit scrape`, and X search in a
tab. A durable version is a workflow whose steps are those three calls, with the post URLs as its
output, so a later run can diff new posts against the last answer.
