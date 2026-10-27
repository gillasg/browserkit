## Chat providers and media

`browserkit ask` talks to a chat product the user is already signed in to. It uses the session in
Chrome, so there is no API key and no separate login:

```bash
browserkit providers                                   # what is available
browserkit ask chatgpt "Summarise this page: <url>"     # direct request first
browserkit ask gemini "Compare these two plans" --ui   # force the page
browserkit ask grok "What is X saying about <topic>?" --json
```

- It sends the provider's own request with the user's cookies and falls back to typing in the page
  when that fails (`--direct` / `--ui` force one). Signed out says `signed-out`. The output carries
  the answer only, never cookies or tokens.

Inside a chat, the primitive path is one browser_code cell (`browser.openTab(provider)`,
locators, `page.inspect`).

### Images and video

```bash
browserkit media image "a red fox in snow" --out fox.png
browserkit media image "make it dusk" --image fox.png --out dusk.png
browserkit media youtube "https://youtu.be/<id>" --ask "What are the three main claims?"
```

Images are made or edited by Gemini and saved in the workspace; YouTube links are answered as text.

### One action at a time

MCP clients that prefer discrete calls have `browser_action` (`{action: "click", selector}`, plus
navigate, type, press, scroll, wait, extract, screenshot…). Anything with several steps stays in
`browser_code`.

### Deep research on X

The `deep-x-research` skill does sourced X work: Grok searches, every post URL is opened and
checked, a query budget keeps it from looping, and X search in a tab is the fallback. Use it for
"what is X saying about", not for a single post the user already linked.
