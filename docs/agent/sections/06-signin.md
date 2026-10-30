## Signing in

If a page shows a sign-in wall, try `await bu.signIn()` before handing off to the user:

```js
await bu.signIn(); // {signedIn, site, provider, account, reason}
await bu.signIn({ account: "me@example.com" });
```

It fills the username, password and the one-time code (the password manager's, else one the site
just sent to the user's Gmail or Google Messages), across
multi-step forms. You never see the password or the code, and there is no approval step: calling it
signs in. `reason` says why it stopped: `NO_PASSWORD_MANAGER`, `NO_SAVED_LOGIN`, `CHOOSE_ACCOUNT`
(call again with `account`), `NEEDS_CODE` (a code by SMS or email), `CAPTCHA`, or `REJECTED`.

The password manager is set up once by the user: `browserkit signin setup bitwarden` (Bitwarden's
`bw` CLI) or `signin setup proton` (Proton Pass's `pass-cli`).

Hand back to the user with `bu.handoff("...")` only for what no agent can do: a 2FA code by SMS or
email, a CAPTCHA, a payment, or a choice that is theirs. Before a click that opens a passkey or 2FA
prompt the page blocks on, start it first with `{start: true}` (help('signin')).

A bot wall (Cloudflare, DataDome and the like) logs a `[warn] challenge:` line when the page opens.
Never click through it yourself: `await bu.handoff("Please finish the check", {wait: true})` returns
once the page is clear. To reuse the signed-in session from a script, `browserkit session export
<site>` or `browserkit cookies export <site>` saves the cookies, mapped site or not.
`help('gated')`.
