## Forms and overlays

Clear cookie banners and pop-ups first: `page.overlays.dismiss()`. A wall that asks for age,
agreement to rules, a region or "click to enter" is a gate: `await page.enterSite()` finds it,
clicks the affirmative control (never a sign-in, paid or leave button) and returns
`{gate, clicked}`. What was clicked is written to the site's pack, so the next session starts
knowing; on a clean page it returns `{gate: "none", clicked: null}`.

Use the site's own search, filters and sort (or its filter URL once seen). Autocomplete fields:
type, wait for the suggestion list, then click the matching option; read each field's value back
before the next.

`page.controls.inspect()` gives every field's state; `page.batch(steps)` fills, selects, checks and
submits in one call, ending with a read of the result (`help("forms")`). Fields about the
user: `await bu.fillProfile()` fills them from their form profile without you seeing the values;
for each field it reports `missing`, ask the user, then offer to keep the answer and on yes
`bu.profile.save({field: value})` (`help("profile")`). A code sent by email or text:
`await bu.fillCode()`. `TARGET_BLOCKED` names what
covers the control: act inside that dialog or close it. If something seems missing, scroll, search
the page or try another URL before concluding it is not there. Never repeat a failing action more
than twice; change strategy.
