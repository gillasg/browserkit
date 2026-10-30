// bu.fillProfile(): fill a form from the user's form profile. The engine reads the page's fields,
// matches each one to a profile field by its autocomplete hint and label, asks the machine for
// those values and sets them; agent code gets back which fields were filled and which the
// profile has no value for, never the values themselves.

type Ask = (request: unknown) => Promise<unknown>;

interface PageField {
  index: number;
  label: string;
  autocomplete: string;
  tag: string;
  type: string;
}

export interface ProfileFillResult {
  filled: { label: string; field: string }[];
  /** Fields the form asks for that the profile has no value for: ask the user, then offer to save. */
  missing: { label: string; field: string }[];
  /** Fields with no profile match (left alone). */
  other: string[];
}

const AUTOCOMPLETE: Record<string, string> = {
  name: "name",
  "given-name": "firstName",
  "additional-name": "middleName",
  "family-name": "lastName",
  email: "email",
  tel: "phone",
  "tel-national": "phone",
  "street-address": "address1",
  "address-line1": "address1",
  "address-line2": "address2",
  "address-level2": "city",
  "address-level1": "state",
  "postal-code": "postalCode",
  country: "country",
  "country-name": "country",
  organization: "company",
  "organization-title": "jobTitle",
  bday: "birthday",
  url: "website",
};

const LABELS: [RegExp, string][] = [
  [/first.?name|given.?name|fname|forename/i, "firstName"],
  [/last.?name|surname|family.?name|lname/i, "lastName"],
  [/middle.?name/i, "middleName"],
  [/full.?name|^name$|your name/i, "name"],
  [/e-?mail/i, "email"],
  [/phone|mobile|cell|^tel/i, "phone"],
  [/address.?(line)?.?2|apartment|apt|suite|unit/i, "address2"],
  [/address.?(line)?.?1|street|^address$/i, "address1"],
  [/city|town/i, "city"],
  [/state|province|region|county/i, "state"],
  [/zip|postal|post.?code|pin.?code/i, "postalCode"],
  [/country/i, "country"],
  [/linkedin/i, "linkedin"],
  [/github/i, "github"],
  [/twitter|x handle/i, "twitter"],
  [/website|portfolio|homepage/i, "website"],
  [/company|organi[sz]ation|employer/i, "company"],
  [/job.?title|position|designation/i, "jobTitle"],
  [/birth|dob/i, "birthday"],
];

/** "Passport city" and "passport_city" both read as passportcity, matched against saved keys. */
const squash = (text: string) => text.toLowerCase().replace(/[^a-z0-9]/g, "");

export function profileFieldFor(field: PageField, saved: readonly string[]): string | undefined {
  const hint = field.autocomplete.toLowerCase().split(/\s+/).at(-1) ?? "";
  if (AUTOCOMPLETE[hint]) return AUTOCOMPLETE[hint];
  const label = squash(field.label);
  const custom = saved.find((key) => squash(key) === label);
  if (custom) return custom;
  for (const [pattern, key] of LABELS) if (pattern.test(field.label)) return key;
  return saved.find((key) => squash(key).length > 3 && label.includes(squash(key)));
}

// Runs in the page: the visible, editable fields in document order, described by their label.
function scanPage(): PageField[] {
  const skip = /^(hidden|password|file|submit|button|reset|image|checkbox|radio|search)$/;
  const controls = [...document.querySelectorAll("input, select, textarea")] as HTMLInputElement[];
  const visible = (el: HTMLElement) => {
    const box = el.getBoundingClientRect();
    return box.width > 0 && box.height > 0 && getComputedStyle(el).visibility !== "hidden";
  };
  const labelOf = (el: HTMLInputElement) => {
    const byFor = el.id ? document.querySelector(`label[for="${CSS.escape(el.id)}"]`) : null;
    const text =
      el.getAttribute("aria-label") ||
      (byFor as HTMLElement | null)?.innerText ||
      (el.closest("label") as HTMLElement | null)?.innerText ||
      el.placeholder ||
      el.name ||
      el.id;
    return (text || "").replace(/\s+/g, " ").trim().slice(0, 80);
  };
  return controls
    .map((el, index) => ({ el, index }))
    .filter(({ el }) => !skip.test(el.type) && !el.disabled && !el.readOnly && visible(el))
    .map(({ el, index }) => ({
      index,
      label: labelOf(el),
      autocomplete: el.getAttribute("autocomplete") || "",
      tag: el.tagName.toLowerCase(),
      type: el.type,
    }));
}

// Runs in the page: sets each value the way typing would, so frameworks see the change.
function fillPage(entries: { index: number; value: string }[]): number[] {
  const controls = [...document.querySelectorAll("input, select, textarea")] as HTMLInputElement[];
  const done: number[] = [];
  for (const { index, value } of entries) {
    const el = controls[index];
    if (!el) continue;
    if (el instanceof HTMLSelectElement) {
      const wanted = value.toLowerCase();
      const option = [...el.options].find(
        (item) => item.value.toLowerCase() === wanted || item.text.trim().toLowerCase() === wanted,
      );
      if (!option) continue;
      el.value = option.value;
    } else {
      const proto =
        el instanceof HTMLTextAreaElement
          ? HTMLTextAreaElement.prototype
          : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(el, value);
    }
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    done.push(index);
  }
  return done;
}

async function inPage<T, A extends unknown[]>(
  tabId: number,
  func: (...args: A) => T,
  args: A,
): Promise<T | undefined> {
  const [result] = await chrome.scripting.executeScript({ target: { tabId }, func, args });
  return result?.result as T | undefined;
}

export async function fillProfileOnPage(
  tabId: number,
  options: { fields?: unknown },
  ask: Ask,
): Promise<ProfileFillResult> {
  const only = Array.isArray(options.fields) ? options.fields.map(String) : undefined;
  const saved = ((await ask({ profile: "fields" })) as { fields?: string[] }).fields ?? [];
  const fields = (await inPage(tabId, scanPage, [])) ?? [];
  const matched = fields.map((field) => ({ field, key: profileFieldFor(field, saved) }));
  const wanted = matched.filter(
    (item): item is { field: PageField; key: string } =>
      Boolean(item.key) && (!only || only.includes(item.key!)),
  );
  const { values = {} } = (await ask({
    profile: "values",
    keys: [...new Set(wanted.map((item) => item.key))],
  })) as { values?: Record<string, string> };
  const entries = wanted
    .filter((item) => values[item.key] !== undefined)
    .map((item) => ({ index: item.field.index, value: values[item.key]! }));
  const done = new Set((await inPage(tabId, fillPage, [entries])) ?? []);
  return {
    filled: wanted
      .filter((item) => done.has(item.field.index))
      .map((item) => ({ label: item.field.label, field: item.key })),
    missing: wanted
      .filter((item) => values[item.key] === undefined)
      .map((item) => ({ label: item.field.label, field: item.key })),
    other: matched
      .filter((item) => !item.key && item.field.label)
      .map((item) => item.field.label)
      .slice(0, 20),
  };
}
