## Chat providers and media

```bash
browserkit providers                                        # what is available
browserkit ask chatgpt|gemini|grok|perplexity|kimi "<question>" [--ui|--direct] [--json]
browserkit media image "<prompt>" [--image in.png] --out out.png   # Gemini, made or edited
browserkit media youtube "<url>" --ask "<question>"
```

- `ask` uses the session the user is signed in to in Chrome (no API key, no separate login): it
  sends the provider's own request and falls back to typing in the page. Signed out says
  `signed-out`; the output carries the answer only, never cookies or tokens.
- MCP clients that prefer single steps have `browser_action` (click, navigate, type, press, scroll,
  wait, extract, screenshot…); anything with several steps stays in `browser_code`.
- Sourced research on X ("what is X saying about"): the `deep-x-research` skill (Grok searches,
  every post opened and checked, a query budget, X search in a tab as the fallback).
