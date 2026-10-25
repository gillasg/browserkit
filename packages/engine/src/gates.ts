// Gate classification, pure and testable on fixtures: age checks, terms/rules walls, region
// modals and "click to enter" interstitials, besides cookie consent. The page half gathers a
// layer's text and its buttons' labels; these two functions decide what it is and which control
// is the affirmative one (never a sign-in, paid or leave button).

export type GateKind = "age" | "consent" | "terms" | "region" | "enter" | "none";

const AGE =
  /\b(18\+|18 or older|are you (over )?18|age verification|verify your age|adults? only|you must be (over )?18|mature content|date of birth|birth ?year)\b/i;
const CONSENT =
  /\b(cookie|consent|gdpr|privacy (choices|settings|preferences)|tracking technologies)\b/i;
const TERMS =
  /\b(terms (of (use|service)|and conditions)|site rules|rules of (the )?site|by (entering|continuing)|agree to (the )?(terms|rules)|i (have read|agree))\b/i;
const REGION =
  /\b(region|country|geo.?block|not available in your|available in your country|based on your location|use a vpn|vpn)\b/i;
const ENTER =
  /\b(click to enter|enter (the )?site|enter here|continue to (the )?site|proceed to (the )?site|tap to enter)\b/i;

const NEGATIVE =
  /\b(sign|log)\s*in\b|\blogin\b|sign\s*up|register|subscribe|pay|buy|purchase|rent|leave|exit|under\s*18|not\s*18|decline|reject|deny|no,?\s*thanks|not\s*now\b/i;
const AFFIRM =
  /^(yes|i\s*am\s*(over\s*)?18|18\s*\+|i'?m\s*(over\s*)?18|enter(\s*(the\s*)?site)?|enter\s*here|click\s*to\s*enter|tap\s*to\s*enter|continue(\s*to\s*(the\s*)?site)?|proceed|i\s*agree|agree|accept|allow(\s*all)?|ok(ay)?|got\s*it|i\s*understand|go\s*to\s*(the\s*)?site|watch|play)/i;

/** What kind of gate this text describes; cookie consent is checked after the four hard gates. */
export function classifyGate(text: string): GateKind {
  const value = String(text ?? "");
  if (AGE.test(value)) return "age";
  if (TERMS.test(value)) return "terms";
  if (REGION.test(value)) return "region";
  if (ENTER.test(value)) return "enter";
  if (CONSENT.test(value)) return "consent";
  return "none";
}

/**
 * The index of the affirmative control among a layer's button labels, or -1. A sign-in, paid or
 * leave button is never picked, even when it is the only one.
 */
export function affirmativeIndex(labels: readonly string[]): number {
  const options = labels
    .map((label, index) => ({
      label: String(label ?? "")
        .replace(/\s+/g, " ")
        .trim(),
      index,
    }))
    .filter((option) => option.label && !NEGATIVE.test(option.label));
  const affirmative = options.find((option) => AFFIRM.test(option.label));
  return affirmative ? affirmative.index : -1;
}
