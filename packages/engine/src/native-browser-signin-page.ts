import { withBrowserDebugger } from "./native-browser-session.js";

// The page side of a password-manager sign-in: find the sign-in fields, type into them as real
// keystrokes (sites that ignore scripted values still see them), and press the form's button.

export interface SignInFields {
  user: boolean;
  userValue: string;
  password: boolean;
  code: boolean;
  submit: boolean;
  captcha: boolean;
  url: string;
  /** One-character boxes the one-time code is split across (0 when it is one field). */
  codeBoxes?: number;
  /** The host the form posts to, when it is another site than the page. */
  foreign?: string;
  /** The page asks the user to approve the sign-in on another device. */
  approve?: boolean;
  /** Something covers the sign-in field (a cookie or promo banner). */
  covered?: boolean;
}

const MARK = "data-signin-field";

/** Marks the visible username, password, one-time-code field and submit button. */
const SCAN = `(() => {
  const mark = ${JSON.stringify(MARK)};
  document.querySelectorAll("[" + mark + "]").forEach((el) => el.removeAttribute(mark));
  const shown = (el) => {
    const box = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return box.width > 0 && box.height > 0 && style.visibility !== "hidden" && !el.disabled && !el.readOnly;
  };
  const words = (el) => [el.name, el.id, el.placeholder, el.getAttribute("aria-label"), el.autocomplete].join(" ");
  const inputs = [...document.querySelectorAll("input")].filter(shown);
  const password = inputs.find((el) => el.type === "password" && !/new-password/.test(el.autocomplete));
  let code = inputs.find((el) => el !== password && ["text", "tel", "number", ""].includes(el.type) &&
    (/one-time-code/.test(el.autocomplete) || (/otp|totp|2fa|mfa|verif|passcode|security.?code|auth.?code/i.test(words(el)) && !/user|email|login|phone|mobile/i.test(el.name + el.id))));
  const single = (el) => ["text", "tel", "number", ""].includes(el.type) && Number(el.maxLength) === 1;
  const boxes = inputs.filter(single);
  const codeBoxes = boxes.length >= 4 && boxes.length <= 8 && boxes.every((el) => el.closest("form") === boxes[0].closest("form")) ? boxes : [];
  if (codeBoxes.length) code = undefined;
  const user = inputs.find((el) => el !== password && el !== code && !codeBoxes.includes(el) && ["text", "email", "tel", ""].includes(el.type) &&
    (/username|email/.test(el.autocomplete) || el.type === "email" || /user|email|login|account|identifier|phone|mobile/i.test(words(el))));
  const field = password || code || codeBoxes[0] || user;
  const site = (host) => { const parts = host.replace(/^www[.]/, "").split("."); const n = parts.length >= 3 && parts[parts.length - 1].length === 2 && /^(co|com|org|net|ac|gov|edu)$/.test(parts[parts.length - 2]) ? 3 : 2; return parts.slice(-n).join("."); };
  let foreign = "";
  if (field && field.form && (password || user)) {
    try {
      const action = new URL(field.form.getAttribute("action") || location.href, location.href);
      if (/^https?:$/.test(action.protocol) && site(action.hostname) !== site(location.hostname)) foreign = action.hostname;
    } catch {}
  }
  let covered = false;
  if (field) {
    const box = field.getBoundingClientRect();
    const top = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
    covered = Boolean(top && top !== field && !field.contains(top) && !top.contains(field) && !(top.tagName === "LABEL"));
  }
  const text = (document.body && document.body.innerText || "").slice(0, 5000);
  const approve = !field && /(approve|confirm|tap|allow)[^.]{0,60}(sign.?in|log.?in|request|notification)[^.]{0,60}(phone|device|app)|check your (phone|device|authenticator app)|sent a (push|notification)/i.test(text);
  const scope = field && field.form ? field.form : document;
  const buttons = [...scope.querySelectorAll("button, input[type=submit], [role=button]")].filter(shown);
  const label = (el) => (el.innerText || el.value || el.getAttribute("aria-label") || "").trim();
  const submit = buttons.find((el) => field && field.form && el.type === "submit") ||
    buttons.find((el) => /^(sign ?in|log ?in|continue|next|submit|verify|sign on|proceed)$/i.test(label(el)));
  for (const [name, el] of [["user", user], ["password", password], ["code", code], ["submit", submit]])
    if (el) el.setAttribute(mark, name);
  codeBoxes.forEach((el, index) => el.setAttribute(mark, "code-" + index));
  const captcha = Boolean(document.querySelector('iframe[src*="recaptcha"], iframe[src*="hcaptcha"], iframe[src*="challenges.cloudflare"], iframe[src*="arkoselabs"]'));
  return { user: Boolean(user), userValue: user ? user.value : "", password: Boolean(password),
    code: Boolean(code) || codeBoxes.length > 0, submit: Boolean(submit), captcha, url: location.href,
    codeBoxes: codeBoxes.length, foreign, approve, covered };
})()`;

const FOCUS = (name: string) => `(() => {
  const el = document.querySelector('[${MARK}="${name}"]');
  if (!el) return false;
  el.focus();
  el.select && el.select();
  return document.activeElement === el;
})()`;

const CLICK = `(() => {
  const el = document.querySelector('[${MARK}="submit"]');
  if (!el) return false;
  el.click();
  return true;
})()`;

const CLEAR_PASSWORD = `(() => {
  for (const el of document.querySelectorAll('input[type=password]')) {
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
    set.call(el, "");
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }
})()`;

/**
 * Clears a banner covering the sign-in form: the most private choice first (reject, necessary
 * only), then a close or accept button inside a fixed, on-top layer.
 */
const CLEAR_COVER = `(() => {
  const fixed = (el) => { for (let node = el; node && node !== document.body; node = node.parentElement) { const position = getComputedStyle(node).position; if (position === "fixed" || position === "sticky") return true; } return false; };
  const label = (el) => (el.innerText || el.value || el.getAttribute("aria-label") || "").trim();
  const buttons = [...document.querySelectorAll("button, [role=button], a, input[type=button], input[type=submit]")]
    .filter((el) => fixed(el) && el.getBoundingClientRect().width > 0 && !el.closest("form [${MARK}]"));
  for (const pattern of [/^(reject|decline|refuse)( all)?$|necessary only|only (necessary|essential)|essential only/i, /^(close|dismiss|no,? thanks|not now|maybe later|×|x)$/i, /^(accept|agree|got it|ok|i understand|allow)( all)?$/i]) {
    const button = buttons.find((el) => pattern.test(label(el)));
    if (button) { button.click(); return true; }
  }
  return false;
})()`;

export async function clearCover(tabId: number): Promise<boolean> {
  return Boolean(await evaluate(tabId, CLEAR_COVER).catch(() => false));
}

/** Types a one-time code one character per box, for codes split across separate boxes. */
export async function typeCodeBoxes(tabId: number, code: string, boxes: number): Promise<boolean> {
  const characters = [...code];
  if (characters.length !== boxes) return typeInto(tabId, "code-0", code);
  for (const [index, character] of characters.entries())
    if (!(await typeInto(tabId, `code-${index}`, character))) return false;
  return true;
}

export async function scanFields(tabId: number): Promise<SignInFields | undefined> {
  const value = await evaluate(tabId, SCAN).catch(() => undefined);
  return value && typeof value === "object" ? (value as SignInFields) : undefined;
}

/** Selects the marked field and types the value into it with the keyboard. */
export async function typeInto(tabId: number, field: string, value: string): Promise<boolean> {
  if (!(await evaluate(tabId, FOCUS(field)).catch(() => false))) return false;
  await withBrowserDebugger(tabId, async (debuggee) => {
    await chrome.debugger.sendCommand(debuggee, "Input.dispatchKeyEvent", {
      type: "keyDown",
      key: "Backspace",
      code: "Backspace",
      windowsVirtualKeyCode: 8,
    });
    await chrome.debugger.sendCommand(debuggee, "Input.dispatchKeyEvent", {
      type: "keyUp",
      key: "Backspace",
      code: "Backspace",
      windowsVirtualKeyCode: 8,
    });
    await chrome.debugger.sendCommand(debuggee, "Input.insertText", { text: value });
  });
  return true;
}

/** Presses the form's button, or Enter in the field when there is none. */
export async function submitForm(tabId: number): Promise<void> {
  if (await evaluate(tabId, CLICK).catch(() => false)) return;
  await withBrowserDebugger(tabId, async (debuggee) => {
    for (const type of ["keyDown", "keyUp"] as const)
      await chrome.debugger.sendCommand(debuggee, "Input.dispatchKeyEvent", {
        type,
        key: "Enter",
        code: "Enter",
        windowsVirtualKeyCode: 13,
        ...(type === "keyDown" ? { text: "\r" } : {}),
      });
  });
}

export function clearPasswords(tabId: number): Promise<void> {
  return evaluate(tabId, CLEAR_PASSWORD).then(
    () => undefined,
    () => undefined,
  );
}

/** Waits for the page to move on after a submit: new fields, a new address, or nothing left. */
export async function waitForChange(
  tabId: number,
  before: SignInFields,
  timeoutMs = 12_000,
): Promise<SignInFields | undefined> {
  const deadline = Date.now() + timeoutMs;
  let last: SignInFields | undefined;
  await new Promise((resolve) => setTimeout(resolve, 800));
  while (Date.now() < deadline) {
    last = await scanFields(tabId);
    if (last && changed(before, last)) return last;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return last;
}

function changed(before: SignInFields, after: SignInFields): boolean {
  return (
    after.url !== before.url ||
    after.password !== before.password ||
    after.code !== before.code ||
    after.captcha !== before.captcha ||
    Boolean(after.approve) !== Boolean(before.approve)
  );
}

async function evaluate(tabId: number, expression: string): Promise<unknown> {
  const result = await withBrowserDebugger(tabId, (debuggee) =>
    chrome.debugger.sendCommand(debuggee, "Runtime.evaluate", {
      expression,
      returnByValue: true,
      silent: true,
    }),
  );
  return (result as { result?: { value?: unknown } } | undefined)?.result?.value;
}
