## Chat providers and media

`browserkit ask` talks to a chat product the user is already signed in to. It uses the session in
Chrome, so there is no API key and no separate login:

```bash
browserkit providers                                   # what is available
browserkit ask chatgpt "Summarise this page: <url>"     # direct request first
browserkit ask gemini "Compare these two plans" --ui   # force the page
browserkit ask grok "What is X saying about <topic>?" --json
```

- The **direct transport** sends the request the provider's own page sends, with the user's
  cookies, and reads the streamed answer. It is the first choice: fast and no tab.
- The **page fallback** opens the provider, types the prompt and reads the answer element. It is
  used automatically when the direct request fails (a changed API, a missing token, a rate limit),
  so a rename on the provider side degrades instead of breaking.
- `--direct` never falls back; `--ui` always uses the page. A signed-out provider says
  `signed-out`, not a timeout.
- A model not in the known list is accepted with a warning; providers rename models without
  notice. `browserkit providers --json` lists the known ones.
- Cookies and tokens stay in the process: the output carries the answer only.

Inside a chat, the primitive path is one browser_code cell (`browser.openTab(provider)`,
locators, `page.inspect`).

### Images and video

```bash
browserkit media image "a red fox in snow" --out fox.png
browserkit media image "make it dusk" --image fox.png --out dusk.png
browserkit media youtube "https://youtu.be/<id>" --ask "What are the three main claims?"
```

Images are generated or edited by Gemini and saved in the workspace; YouTube links are watched by
Gemini and answered as text. The primitive path is `page.upload("input[type=file]", [file])`,
`page.saveMedia("img", {name})` on `gemini.google.com/app`. AI Studio is not used.

### One action at a time

MCP clients that prefer discrete calls have `browser_action`: `{action: "click", selector:
"button[type=submit]"}`, with navigate, type, press, scroll, wait, extract, screenshot, evaluate,
back, forward, reload and tabs. It builds the same browser_code cell, and `browser_code` stays the
tool for anything with several steps or its own logic. It does not replace the other tools.

### Deep research on X

The `deep-x-research` skill does sourced X work: Grok searches, every post URL is opened and
checked, a query budget keeps it from looping, and X search in a tab is the fallback. Use it for
"what is X saying about", not for a single post the user already linked.
